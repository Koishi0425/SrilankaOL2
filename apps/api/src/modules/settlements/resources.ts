import type { ResourceChange, ResourceChangeInput } from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';

export interface ResourceRow {
  id: string;
  name: string;
  treasury: string;
  manpower: number;
  resource_revision: number;
}
export interface StoredResourceChange {
  change: ResourceChange;
  baseline: { treasury: number; manpower: number; revision: number };
}
export function resourceInput(change: ResourceChange): ResourceChangeInput {
  const {
    id,
    actionId,
    countryId,
    expectedResourceRevision,
    resource,
    amount,
    reason,
  } = change;
  return {
    id,
    actionId,
    countryId,
    expectedResourceRevision,
    resource,
    amount,
    reason,
  };
}
export function validBalance(resource: 'Treasury' | 'Manpower', value: number) {
  return (
    Number.isFinite(value) &&
    (resource === 'Treasury'
      ? Math.abs(value) <= 1_000_000_000 &&
        Math.abs(value * 100 - Math.round(value * 100)) < 0.0001
      : Number.isInteger(value) && value >= 0 && value <= 2_147_483_647)
  );
}

export async function prepareResources(
  db: DatabaseClient,
  gameId: string,
  inputs: ResourceChangeInput[],
  previous: StoredResourceChange[],
  approved: Set<string>,
): Promise<StoredResourceChange[]> {
  if (!inputs.length) return [];
  // Map mutations acquire quarter → map → game. Call this after map validation.
  await db.query('SELECT id FROM world_maps WHERE game_id=$1 FOR UPDATE', [
    gameId,
  ]);
  await db.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [gameId]);
  const countries = await db.query<ResourceRow>(
    'SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 ORDER BY id FOR UPDATE',
    [gameId],
  );
  const original = new Map(countries.rows.map((row) => [row.id, row]));
  const running = new Map(
    countries.rows.map((row) => [
      row.id,
      {
        Treasury: Math.round(Number(row.treasury) * 100),
        Manpower: row.manpower,
      },
    ]),
  );
  const old = new Map(previous.map((item) => [item.change.id, item]));
  const retired = await db.query(
    'SELECT change_id FROM country_resource_ledger WHERE game_id=$1 AND change_id=ANY($2::uuid[])',
    [gameId, inputs.map((item) => item.id)],
  );
  if (retired.rows.length)
    throw new ApiFault(
      400,
      'INVALID_RESOURCE_CHANGE',
      '该收支标识已用于正式账目，请重新添加。',
    );
  const used = new Set<string>();
  const stored: StoredResourceChange[] = [];
  for (const input of inputs) {
    const row = original.get(input.countryId);
    if (
      !row ||
      used.has(input.id) ||
      (input.actionId && !approved.has(input.actionId))
    )
      throw new ApiFault(
        400,
        'INVALID_RESOURCE_CHANGE',
        '资源收支包含重复标识、无效国家或未批准的政策。',
      );
    used.add(input.id);
    const saved = old.get(input.id);
    if (
      saved &&
      (saved.change.countryId !== input.countryId ||
        saved.change.resource !== input.resource)
    )
      throw new ApiFault(
        400,
        'INVALID_RESOURCE_CHANGE',
        '更换国家或资源时，请移除原收支后重新添加。',
      );
    if (
      input.expectedResourceRevision !== row.resource_revision ||
      (saved &&
        (saved.baseline.revision !== row.resource_revision ||
          saved.baseline.treasury !== Number(row.treasury) ||
          saved.baseline.manpower !== row.manpower))
    )
      throw new ApiFault(
        409,
        'RESOURCE_VERSION_CONFLICT',
        '国家余额已变化，请移除该国原收支，读取最新余额后重新添加。',
        { countryId: row.id },
      );
    if (
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      input.amount === 0 ||
      !Number.isFinite(input.amount) ||
      (input.resource === 'Treasury'
        ? !validBalance('Treasury', input.amount)
        : !Number.isInteger(input.amount) ||
          Math.abs(input.amount) > 2_147_483_647)
    )
      throw new ApiFault(
        400,
        'INVALID_RESOURCE_CHANGE',
        '请填写有效的增减数值和原因，国库最多两位小数，人力为整数。',
      );
    const balances = running.get(row.id)!;
    const scale = input.resource === 'Treasury' ? 100 : 1;
    const before = balances[input.resource] / scale;
    balances[input.resource] += Math.round(input.amount * scale);
    const after = balances[input.resource] / scale;
    if (!validBalance(input.resource, after))
      throw new ApiFault(
        400,
        'INSUFFICIENT_RESOURCE',
        '资源收支超出余额范围；人力不能为负，请检查增减数值与收支顺序。',
        { countryId: row.id },
      );
    stored.push({
      change: {
        ...input,
        reason: input.reason.trim(),
        countryName: row.name,
        before,
        after,
      },
      baseline: saved?.baseline ?? {
        treasury: Number(row.treasury),
        manpower: row.manpower,
        revision: row.resource_revision,
      },
    });
  }
  return stored;
}

export async function insertResourceLedger(
  db: DatabaseClient,
  context: {
    gameId: string;
    quarterId: string;
    userId: string;
    kind: 'Setup' | 'Settlement' | 'Correction';
  },
  change: Pick<
    ResourceChange,
    'id' | 'countryId' | 'resource' | 'amount' | 'before' | 'after' | 'reason'
  >,
) {
  await db.query(
    `INSERT INTO country_resource_ledger (game_id,country_id,quarter_id,kind,change_id,resource,amount,before_balance,after_balance,reason,actor_user_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      context.gameId,
      change.countryId,
      context.quarterId,
      context.kind,
      change.id,
      change.resource,
      change.amount,
      change.before,
      change.after,
      change.reason,
      context.userId,
    ],
  );
}

export async function publishResources(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  stored: StoredResourceChange[],
  statePublication?: {
    previousWorldVersion: number;
    worldVersion: number;
    tileIds: string[];
  },
) {
  if (!stored.length) return statePublication;
  const finals = new Map<string, { treasury: number; manpower: number }>();
  for (const { change, baseline } of stored) {
    const balances = finals.get(change.countryId) ?? {
      treasury: baseline.treasury,
      manpower: baseline.manpower,
    };
    if (change.resource === 'Treasury') balances.treasury = change.after;
    else balances.manpower = change.after;
    finals.set(change.countryId, balances);
    await insertResourceLedger(
      db,
      { gameId, quarterId, userId, kind: 'Settlement' },
      change,
    );
  }
  for (const [countryId, values] of finals)
    await db.query(
      'UPDATE countries SET treasury=$3,manpower=$4,resource_revision=resource_revision+1 WHERE game_id=$1 AND id=$2',
      [gameId, countryId, values.treasury, values.manpower],
    );
  if (statePublication) return statePublication;
  const version = await db.query<{ current_world_version: string }>(
    'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1 RETURNING current_world_version',
    [gameId],
  );
  const worldVersion = Number(version.rows[0]!.current_world_version);
  return {
    previousWorldVersion: worldVersion - 1,
    worldVersion,
    tileIds: [],
    mapRevisionDelta: 0,
  };
}
