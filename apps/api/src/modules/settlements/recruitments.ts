import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { toStateChangeInput } from '@srilanka/contracts';
import type {
  RecruitmentInput,
  SettlementRecruitment,
  ResourceChangeInput,
} from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import type { StoredEconomicBill } from './economy.js';
import { lockMap } from '../world/map-mutations.js';
import {
  prepareStateChanges,
  type StoredStateChange,
} from './state-changes.js';
import {
  prepareResources,
  resourceInput,
  validBalance,
  type StoredResourceChange,
} from './resources.js';

export interface StoredRecruitment {
  recruitment: SettlementRecruitment;
  baseline: { countryId: string; tileId: string; strength: number };
  effect: StoredStateChange | null;
  costs: StoredResourceChange[];
}
export function recruitmentInput(
  item: SettlementRecruitment,
): RecruitmentInput {
  const {
    id,
    actionId,
    kind,
    strength,
    treasuryCost,
    manpowerCost,
    expectedResourceRevision,
    note,
  } = item;
  const base = {
    id,
    actionId,
    kind,
    strength,
    treasuryCost,
    manpowerCost,
    expectedResourceRevision,
    note,
  };
  return kind === 'Create'
    ? {
        ...base,
        kind,
        countryId: item.countryId,
        name: item.name,
        tileId: item.tileId,
      }
    : { ...base, kind, armyId: item.armyId };
}
function target(input: RecruitmentInput) {
  return input.kind === 'Create'
    ? [input.kind, input.countryId, input.name, input.tileId]
    : [input.kind, input.armyId];
}
function invalid(message: string) {
  return new ApiFault(400, 'INVALID_RECRUITMENT', message);
}

export async function prepareRecruitments(
  db: DatabaseClient,
  gameId: string,
  inputs: RecruitmentInput[],
  previous: StoredRecruitment[],
  approved: Set<string>,
  expectedRevision?: number,
): Promise<StoredRecruitment[]> {
  if (!inputs.length) return [];
  const old = new Map(previous.map((item) => [item.recruitment.id, item]));
  const modified = inputs.some(
    (input) =>
      !isDeepStrictEqual(
        input,
        old.has(input.id)
          ? recruitmentInput(old.get(input.id)!.recruitment)
          : undefined,
      ),
  );
  if (modified && expectedRevision === undefined)
    throw new ApiFault(
      409,
      'MAP_VERSION_CONFLICT',
      '请读取当前地图后再保存征兵。',
    );
  const map = await lockMap(
    db,
    gameId,
    modified ? expectedRevision : undefined,
  );
  const countries = await db.query<{ id: string; name: string }>(
    "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active'",
    [gameId],
  );
  const names = new Map(countries.rows.map((c) => [c.id, c.name]));
  const armyRows = await db.query<{
    id: string;
    name: string;
    country_id: string;
    tile_id: string;
    strength: number;
    q: number;
    r: number;
  }>(
    'SELECT a.*,t.q,t.r FROM armies a JOIN hex_tiles t ON t.id=a.tile_id AND t.game_id=a.game_id WHERE a.game_id=$1',
    [gameId],
  );
  const armies = new Map(armyRows.rows.map((a) => [a.id, a]));
  const retired = await db.query(
    'SELECT id FROM armies WHERE id=ANY($1::uuid[])',
    [inputs.map((item) => item.id)],
  );
  if (retired.rows.length)
    throw invalid('征兵标识与已有军队重复，请重新添加。');
  const used = new Set<string>(),
    reinforced = new Set<string>(),
    newNames = new Set<string>();
  const stored: StoredRecruitment[] = [];
  for (const input of inputs) {
    if (used.has(input.id) || (input.actionId && !approved.has(input.actionId)))
      throw invalid('征兵包含重复标识或未批准的政策。');
    used.add(input.id);
    if (
      !Number.isInteger(input.strength) ||
      input.strength < 1 ||
      input.strength > 2_147_483_647 ||
      !validBalance('Treasury', input.treasuryCost) ||
      input.treasuryCost < 0 ||
      !validBalance('Manpower', input.manpowerCost) ||
      !input.note.trim() ||
      input.note.length > 2000
    )
      throw invalid('请填写正整数征募人数、非负费用与征募说明。');
    const saved = old.get(input.id);
    if (
      saved &&
      !isDeepStrictEqual(
        target(input),
        target(recruitmentInput(saved.recruitment)),
      )
    )
      throw invalid('更换军队、国家、驻地或名称时，请移除原征兵后重新添加。');
    let countryId: string,
      tileId: string,
      armyName: string,
      beforeStrength: number,
      q: number,
      r: number;
    if (input.kind === 'Create') {
      if (!input.name.trim() || input.name.length > 120)
        throw invalid('请填写军队名称。');
      countryId = input.countryId;
      tileId = input.tileId;
      armyName = input.name.trim();
      beforeStrength = 0;
      const key = `${countryId}:${armyName}`;
      if (
        newNames.has(key) ||
        armyRows.rows.some(
          (a) => a.country_id === countryId && a.name === armyName,
        )
      )
        throw invalid('该国已有同名军队或组建计划，请使用不同名称。');
      newNames.add(key);
      const tile = await db.query<{ q: number; r: number; passable: boolean }>(
        'SELECT q,r,passable FROM hex_tiles WHERE game_id=$1 AND id=$2',
        [gameId, tileId],
      );
      if (!tile.rows[0]?.passable)
        throw invalid('驻地必须是本游戏的可通行地块。');
      ({ q, r } = tile.rows[0]);
    } else {
      const army = armies.get(input.armyId);
      if (!army) throw invalid('军队不属于当前游戏或已不存在。');
      if (reinforced.has(army.id))
        throw invalid('同一军队本回合只能设置一项补兵，请合并人数与费用。');
      reinforced.add(army.id);
      countryId = army.country_id;
      tileId = army.tile_id;
      armyName = army.name;
      beforeStrength = army.strength;
      ({ q, r } = army);
    }
    if (!names.has(countryId)) throw invalid('国家不属于当前游戏或已停用。');
    const baseline = { countryId, tileId, strength: beforeStrength };
    if (saved && !isDeepStrictEqual(baseline, saved.baseline))
      throw new ApiFault(
        409,
        'RECRUITMENT_STATE_CONFLICT',
        '补兵军队的所属国家、人数或位置已变化，请移除原征兵后重新添加。',
        { recruitmentId: input.id },
      );
    const afterStrength = beforeStrength + input.strength;
    if (afterStrength > 2_147_483_647)
      throw invalid('补兵后的军队人数超出上限。');
    const effect =
      input.kind === 'Reinforce'
        ? (
            await prepareStateChanges(
              db,
              gameId,
              [
                {
                  id: saved?.effect?.change.id ?? randomUUID(),
                  actionId: input.actionId,
                  kind: 'ArmyStrength',
                  armyId: input.armyId,
                  strength: afterStrength,
                },
              ],
              saved?.effect ? [saved.effect] : [],
              approved,
              expectedRevision ?? map.revision,
            )
          )[0]!
        : null;
    const costs: StoredResourceChange[] = [];
    for (const [resource, amount] of [
      ['Treasury', input.treasuryCost],
      ['Manpower', input.manpowerCost],
    ] as const) {
      if (!amount) continue;
      const prior = saved?.costs.find((c) => c.change.resource === resource);
      const change = {
        id: prior?.change.id ?? randomUUID(),
        actionId: input.actionId,
        countryId,
        expectedResourceRevision: input.expectedResourceRevision,
        resource,
        amount: -amount,
        reason:
          `${input.kind === 'Create' ? '组建' : '补充'}${armyName}（${input.strength} 人）：${input.note.trim()}`.slice(
            0,
            2000,
          ),
      };
      // Final balances are calculated with ordinary income/expenses in prepareRecruitmentCosts.
      costs.push({
        change: {
          ...change,
          countryName: names.get(countryId)!,
          before: 0,
          after: 0,
        },
        baseline: prior?.baseline ?? {
          treasury: 0,
          manpower: 0,
          revision: input.expectedResourceRevision,
        },
      });
    }
    const summary =
      input.kind === 'Create'
        ? `${names.get(countryId)}：组建${armyName}，${input.strength} 人，驻地 (${q}, ${r})`
        : `${names.get(countryId)} · ${armyName}：补充 ${input.strength} 人（${beforeStrength} → ${afterStrength}）`;
    stored.push({
      recruitment: {
        ...input,
        countryId,
        countryName: names.get(countryId)!,
        armyName,
        q,
        r,
        beforeStrength,
        afterStrength,
        summary,
        costs: costs.map((c) => c.change),
      },
      baseline: saved?.baseline ?? baseline,
      effect,
      costs,
    });
  }
  return stored;
}

export async function prepareRecruitmentCosts(
  db: DatabaseClient,
  gameId: string,
  manualInputs: ResourceChangeInput[],
  previousManual: StoredResourceChange[],
  recruitments: StoredRecruitment[],
  previousRecruitments: StoredRecruitment[],
  approved: Set<string>,
  economic: StoredEconomicBill | null = null,
  previousEconomic: StoredEconomicBill | null = null,
) {
  const all = await prepareResources(
    db,
    gameId,
    [
      ...(economic?.costs.map((c) => resourceInput(c.change)) ?? []),
      ...manualInputs,
      ...recruitments.flatMap((item) =>
        item.costs.map((c) => resourceInput(c.change)),
      ),
    ],
    [
      ...(previousEconomic?.costs ?? []),
      ...previousManual,
      ...previousRecruitments.flatMap((item) => item.costs),
    ],
    approved,
  );
  const byId = new Map(all.map((item) => [item.change.id, item]));
  if (economic) {
    economic.costs = economic.costs.map((c) => byId.get(c.change.id)!);
    economic.bill.effects = economic.costs.map((c) => c.change);
  }
  for (const item of recruitments) {
    item.costs = item.costs.map((c) => byId.get(c.change.id)!);
    item.recruitment.costs = item.costs.map((c) => c.change);
  }
  const manualIds = new Set(manualInputs.map((item) => item.id));
  return { manual: all.filter((item) => manualIds.has(item.change.id)), all };
}

export async function combineRecruitmentEffects(
  db: DatabaseClient,
  gameId: string,
  combined: StoredStateChange[],
  recruitments: StoredRecruitment[],
  approved: Set<string>,
) {
  const effects = [
    ...combined,
    ...recruitments.flatMap((item) => (item.effect ? [item.effect] : [])),
  ];
  if (
    new Set(
      effects
        .filter((item) => item.change.kind === 'ArmyStrength')
        .map((item) => (item.change as { armyId: string }).armyId),
    ).size !==
    effects.filter((item) => item.change.kind === 'ArmyStrength').length
  )
    throw invalid(
      '该军队本回合已有兵力裁决。请合并裁决，或用“状态变化”填写最终人数，并在“资源收支”记录费用。',
    );
  await prepareStateChanges(
    db,
    gameId,
    effects.map((item) => toStateChangeInput(item.change)),
    effects,
    approved,
  );
  return effects;
}
