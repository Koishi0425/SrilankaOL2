import { isDeepStrictEqual } from 'node:util';
import {
  nationalPolicyStatus,
  policyEffectNames,
  toGovernmentInput,
} from '@srilanka/contracts';
import type {
  GovernmentChange,
  GovernmentChangeInput,
  GovernmentData,
  GovernmentProfile,
  NationalPolicy,
  DiplomacyQuarter,
  EconomicBill,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { requireMapHost } from '../world/map-mutations.js';
const invalid = (message: string) =>
  new ApiFault(400, 'INVALID_GOVERNMENT_CHANGE', message);
const conflict = () =>
  new ApiFault(
    409,
    'GOVERNMENT_VERSION_CONFLICT',
    '政府与政策资料已变化，请移除原计划，刷新后重新添加。',
  );
export function governmentQuarterAfter(
  quarter: DiplomacyQuarter,
  count: number,
): DiplomacyQuarter {
  const seasons = ['Spring', 'Summer', 'Autumn', 'Winter'] as const,
    index = seasons.indexOf(quarter.season) + count;
  return {
    sequenceNumber: quarter.sequenceNumber + count,
    gameYear: quarter.gameYear + Math.floor(index / 4),
    season: seasons[index % 4]!,
  };
}
export async function readNationalPolicies(db: DatabaseClient, gameId: string) {
  return (
    await db.query<{ record: NationalPolicy }>(
      'SELECT record FROM national_policies WHERE game_id=$1 ORDER BY id',
      [gameId],
    )
  ).rows.map((r) => r.record);
}
export async function readGovernmentState(
  db: DatabaseClient,
  gameId: string,
): Promise<GovernmentData> {
  const row = (
    await db.query<{
      revision: number;
      state: string;
      gameYear: number;
      season: DiplomacyQuarter['season'];
      sequenceNumber: number;
    }>(
      'SELECT g.government_revision AS revision,q.state,q.game_year AS "gameYear",q.season,q.sequence_number AS "sequenceNumber" FROM games g JOIN quarters q ON q.game_id=g.id AND q.is_current WHERE g.id=$1',
      [gameId],
    )
  ).rows[0];
  if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
  const countries = (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active' ORDER BY name,id",
      [gameId],
    )
  ).rows;
  const stored = (
    await db.query<{ country_id: string; record: GovernmentProfile }>(
      'SELECT country_id,record FROM country_governments WHERE game_id=$1',
      [gameId],
    )
  ).rows;
  return {
    revision: row.revision,
    quarter: {
      gameYear: row.gameYear,
      season: row.season,
      sequenceNumber: row.sequenceNumber,
    },
    canEdit: row.state === 'Preparing',
    countries,
    profiles: countries.map(
      (c) =>
        stored.find((p) => p.country_id === c.id)?.record ?? {
          countryId: c.id,
          countryName: c.name,
          regime: '',
          authority: '',
          description: '',
        },
    ),
    policies: await readNationalPolicies(db, gameId),
    lastBill: null,
  };
}
function target(c: GovernmentChangeInput) {
  return c.kind === 'Government'
    ? 'government:' + c.countryId
    : 'policy:' + c.policyId;
}
export async function prepareGovernment(
  db: DatabaseClient,
  gameId: string,
  quarter: DiplomacyQuarter,
  inputs: GovernmentChangeInput[],
  previous: GovernmentChange[],
  approved: Set<string>,
  operation: 'Setup' | 'Settlement',
) {
  if (!inputs.length) return [];
  if (inputs.length > 100) throw invalid('每回合最多 100 项政府与政策变化。');
  const data = await readGovernmentState(db, gameId),
    names = new Map(data.countries!.map((c) => [c.id, c.name]));
  const ids = new Set<string>(),
    targets = new Set<string>(),
    old = new Map(previous.map((c) => [c.id, c])),
    changes: GovernmentChange[] = [];
  const effective = governmentQuarterAfter(
    quarter,
    operation === 'Settlement' ? 1 : 0,
  );
  for (const raw of inputs) {
    if (
      raw.kind === 'Policy' &&
      (!raw.effects ||
        Array.isArray(raw.effects) ||
        Object.entries(raw.effects).some(
          ([key, value]) =>
            !Object.hasOwn(policyEffectNames, key) ||
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < -100 ||
            value > 1000 ||
            Math.abs(value * 100 - Math.round(value * 100)) > 0.0001,
        ))
    )
      throw invalid('政策效果为 -100% 至 1000%，最多两位小数。');
    const input = toGovernmentInput(raw);
    input.reason = input.reason.trim();
    if (
      !input.reason ||
      input.reason.length > 2000 ||
      ids.has(input.id) ||
      targets.has(target(input))
    )
      throw invalid('请填写原因；同一政府或政策不能重复设置。');
    ids.add(input.id);
    targets.add(target(input));
    if (input.expectedQuarterSequence !== quarter.sequenceNumber)
      throw new ApiFault(
        409,
        'QUARTER_CHANGED',
        '回合已变化，请取消设置，刷新后重新核对。',
      );
    if (input.expectedRevision !== data.revision) throw conflict();
    if (input.actionId && !approved.has(input.actionId))
      throw invalid('政府与政策变化只能关联本回合已批准的政策。');
    if (
      (
        await db.query('SELECT id FROM government_history WHERE id=$1', [
          input.id,
        ])
      ).rowCount
    )
      throw invalid('变化标识已用于正式政府记录。');
    let before: GovernmentChange['before'],
      after: GovernmentChange['after'],
      countryId: string,
      summary: string;
    if (input.kind === 'EndPolicy') {
      const policy = data.policies.find((p) => p.id === input.policyId);
      if (
        !policy ||
        !names.has(policy.countryId) ||
        policy.endedAt ||
        nationalPolicyStatus(policy, quarter.sequenceNumber) === 'Expired'
      )
        throw invalid('政策不存在、已终止或已到期。');
      before = policy;
      countryId = policy.countryId;
      after = { ...policy, endedAt: effective };
      summary = `${policy.countryName}：终止${policy.type === 'Policy' ? '政策' : '改革'}“${policy.title}”（${operation === 'Settlement' ? '下季' : '本季'}起）`;
    } else {
      countryId = input.countryId;
      if (!names.has(countryId))
        throw invalid('国家不属于当前游戏或已不活跃。');
      if (input.kind === 'Government') {
        input.regime = input.regime.trim();
        input.authority = input.authority.trim();
        input.description = input.description.trim();
        if (
          input.regime.length > 120 ||
          input.authority.length > 120 ||
          input.description.length > 5000
        )
          throw invalid('政府资料超过长度限制。');
        before = data.profiles.find((p) => p.countryId === countryId)!;
        after = {
          countryId,
          countryName: names.get(countryId)!,
          regime: input.regime,
          authority: input.authority,
          description: input.description,
        };
        if (isDeepStrictEqual(before, after)) throw invalid('政府资料未变化。');
        summary = names.get(countryId) + '：更新政府资料';
      } else {
        input.title = input.title.trim();
        input.text = input.text.trim();
        if (
          !input.title ||
          input.title.length > 200 ||
          !input.text ||
          input.text.length > 20000 ||
          !['Policy', 'Reform'].includes(input.type) ||
          (input.durationQuarters !== null &&
            (!Number.isInteger(input.durationQuarters) ||
              input.durationQuarters < 1 ||
              input.durationQuarters > 400))
        )
          throw invalid('请填写政策名称、条文及有效期限。');
        if (
          (
            await db.query('SELECT id FROM national_policies WHERE id=$1', [
              input.policyId,
            ])
          ).rowCount
        )
          throw invalid('政策标识已使用，请另立新政策。');
        input.effects = Object.fromEntries(
          Object.entries(input.effects).filter(([, v]) => v !== 0),
        );
        before = null;
        after = {
          id: input.policyId,
          countryId,
          countryName: names.get(countryId)!,
          title: input.title,
          type: input.type,
          text: input.text,
          effects: input.effects,
          startsAt: effective,
          expiresAt:
            input.durationQuarters === null
              ? null
              : governmentQuarterAfter(effective, input.durationQuarters),
          endedAt: null,
        };
        summary = `${after.countryName}：施行${input.type === 'Policy' ? '政策' : '改革'}“${input.title}”（${operation === 'Settlement' ? '下季' : '本季'}起）`;
      }
    }
    const saved = old.get(input.id);
    if (saved && (target(saved) !== target(input) || saved.kind !== input.kind))
      throw invalid('变更目标时请移除原计划后重新添加。');
    if (
      saved &&
      (!isDeepStrictEqual(saved.before, before) ||
        saved.expectedRevision !== input.expectedRevision)
    )
      throw conflict();
    changes.push({
      ...input,
      countryId,
      countryName: names.get(countryId)!,
      before,
      after,
      summary,
    });
  }
  if (
    data.policies.length + changes.filter((c) => c.kind === 'Policy').length >
    500
  )
    throw invalid('每场游戏最多保留 500 项长期政策与改革。');
  return changes;
}
export async function applyGovernment(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  changes: GovernmentChange[],
  operation: 'Setup' | 'Settlement',
) {
  for (const c of changes) {
    if (c.kind === 'Government')
      await db.query(
        'INSERT INTO country_governments(game_id,country_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(game_id,country_id) DO UPDATE SET record=EXCLUDED.record',
        [gameId, c.countryId, JSON.stringify(c.after)],
      );
    else if (c.kind === 'Policy')
      await db.query(
        'INSERT INTO national_policies(id,game_id,country_id,record) VALUES($1,$2,$3,$4::jsonb)',
        [c.policyId, gameId, c.countryId, JSON.stringify(c.after)],
      );
    else
      await db.query(
        'UPDATE national_policies SET record=$3::jsonb WHERE game_id=$1 AND id=$2',
        [gameId, c.policyId, JSON.stringify(c.after)],
      );
    await db.query(
      'INSERT INTO government_history(id,game_id,country_id,quarter_id,actor_user_id,operation,change) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)',
      [
        c.id,
        gameId,
        c.countryId,
        quarterId,
        userId,
        operation,
        JSON.stringify(c),
      ],
    );
  }
  if (changes.length)
    await db.query(
      'UPDATE games SET government_revision=government_revision+1 WHERE id=$1',
      [gameId],
    );
}
export async function publishGovernment(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  quarter: DiplomacyQuarter,
  stored: GovernmentChange[],
  approved: Set<string>,
  publication?: {
    previousWorldVersion: number;
    worldVersion: number;
    tileIds: string[];
    mapRevisionDelta?: number;
  },
) {
  if (!stored.length) return { changes: [], publication };
  const changes = await prepareGovernment(
    db,
    gameId,
    quarter,
    stored.map(toGovernmentInput),
    stored,
    approved,
    'Settlement',
  );
  await applyGovernment(db, gameId, quarterId, userId, changes, 'Settlement');
  if (publication) return { changes, publication };
  const version = Number(
    (
      await db.query<{ current_world_version: string }>(
        'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1 RETURNING current_world_version',
        [gameId],
      )
    ).rows[0]!.current_world_version,
  );
  return {
    changes,
    publication: {
      previousWorldVersion: version - 1,
      worldVersion: version,
      tileIds: [],
      mapRevisionDelta: 0,
    },
  };
}
export class GovernmentService {
  constructor(private readonly database: DatabasePool) {}
  private async transaction<T>(
    read: boolean,
    fn: (db: DatabaseClient) => Promise<T>,
  ) {
    const db = await this.database.connect();
    try {
      await db.query(
        read ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      const result = await fn(db);
      await db.query('COMMIT');
      return result;
    } catch (e) {
      await db.query('ROLLBACK');
      throw e;
    } finally {
      db.release();
    }
  }
  async get(
    gameId: string,
    userId: string,
    countryId?: string,
  ): Promise<GovernmentData> {
    return this.transaction(true, async (db) => {
      const member = (
        await db.query<{ role: string; controlled_country_id: string | null }>(
          "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
          [gameId, userId],
        )
      ).rows[0];
      if (!member)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
      const host = ['Host', 'Administrator'].includes(member.role),
        own = member.role === 'Player' ? member.controlled_country_id : null,
        selected = host ? countryId : own;
      if (!host && countryId && countryId !== own)
        throw new ApiFault(
          403,
          'COUNTRY_PERMISSION_REQUIRED',
          '只能读取本国政府与政策。',
        );
      const data = await readGovernmentState(db, gameId);
      if (selected && !data.countries!.some((c) => c.id === selected))
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该国家。');
      if (!host) {
        delete data.countries;
        data.canEdit = false;
        data.revision = 0;
      }
      data.profiles = data.profiles.filter(
        (p) => (host && !selected) || p.countryId === selected,
      );
      data.policies = data.policies.filter(
        (p) => (host && !selected) || p.countryId === selected,
      );
      if (!host && !own) return data;
      const history = (
        await db.query<{
          id: string;
          operation: 'Setup' | 'Settlement';
          change: GovernmentChange;
          gameYear: number;
          season: DiplomacyQuarter['season'];
          sequenceNumber: number;
        }>(
          'SELECT h.id,h.operation,h.change,q.game_year AS "gameYear",q.season,q.sequence_number AS "sequenceNumber" FROM government_history h JOIN quarters q ON q.game_id=h.game_id AND q.id=h.quarter_id WHERE h.game_id=$1 AND ($2::uuid IS NULL OR h.country_id=$2) ORDER BY h.created_at DESC,h.id DESC LIMIT 30',
          [gameId, selected ?? null],
        )
      ).rows;
      data.history = history.map((h) => ({
        id: h.id,
        operation: h.operation,
        quarter: {
          gameYear: h.gameYear,
          season: h.season,
          sequenceNumber: h.sequenceNumber,
        },
        summary: h.change.summary,
        reason: h.change.reason,
        before: h.change.before,
        after: h.change.after,
      }));
      if (selected) {
        const latest = (
          await db.query<{
            bill: EconomicBill;
            gameYear: number;
            season: DiplomacyQuarter['season'];
            sequenceNumber: number;
          }>(
            `SELECT s.published_snapshot->'economicBill' AS bill,q.game_year AS "gameYear",q.season,q.sequence_number AS "sequenceNumber" FROM quarter_settlements s JOIN quarters q ON q.game_id=s.game_id AND q.id=s.quarter_id WHERE s.game_id=$1 AND s.published_at IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s.published_snapshot->'economicBill'->'lines','[]'::jsonb)) l WHERE l->>'countryId'=$2) ORDER BY q.sequence_number DESC LIMIT 1`,
            [gameId, selected],
          )
        ).rows[0];
        if (latest)
          data.lastBill = {
            quarter: {
              gameYear: latest.gameYear,
              season: latest.season,
              sequenceNumber: latest.sequenceNumber,
            },
            capturedAt: latest.bill.capturedAt,
            lines: latest.bill.lines
              .filter((l) => l.countryId === selected)
              .map((l) => ({
                kind: l.kind,
                baseAmount: l.baseAmount ?? l.calculatedAmount,
                calculatedAmount: l.calculatedAmount,
                actualAmount: l.amount,
                adjustmentReason: l.adjustmentReason,
                policyEffects: l.policyEffects ?? [],
              })),
          };
      }
      return data;
    });
  }
  async setup(gameId: string, userId: string, inputs: GovernmentChangeInput[]) {
    await this.transaction(false, async (db) => {
      await requireMapHost(db, gameId, userId);
      const q = (
        await db.query<{
          id: string;
          state: string;
          gameYear: number;
          season: DiplomacyQuarter['season'];
          sequenceNumber: number;
        }>(
          'SELECT id,state,game_year AS "gameYear",season,sequence_number AS "sequenceNumber" FROM quarters WHERE game_id=$1 AND is_current FOR UPDATE',
          [gameId],
        )
      ).rows[0];
      if (!q || q.state !== 'Preparing')
        throw new ApiFault(
          409,
          'GOVERNMENT_SETUP_LOCKED',
          '只能在准备阶段设置政府与开场政策。',
        );
      if (!inputs.length || inputs.some((c) => c.actionId !== null))
        throw invalid('准备阶段设置不能关联政策行动。');
      const changes = await prepareGovernment(
        db,
        gameId,
        {
          gameYear: q.gameYear,
          season: q.season,
          sequenceNumber: q.sequenceNumber,
        },
        inputs,
        [],
        new Set(),
        'Setup',
      );
      await applyGovernment(db, gameId, q.id, userId, changes, 'Setup');
      await db.query(
        'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1',
        [gameId],
      );
    });
    return this.get(gameId, userId);
  }
}
