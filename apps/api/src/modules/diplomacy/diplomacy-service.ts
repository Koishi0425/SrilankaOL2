import { isDeepStrictEqual } from 'node:util';
import { treatyKindNames, toDiplomacyInput } from '@srilanka/contracts';
import type {
  DiplomacyChange,
  DiplomacyChangeInput,
  DiplomacyData,
  DiplomacyQuarter,
  DiplomaticTreaty,
  DiplomaticRelation,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { requireMapHost } from '../world/map-mutations.js';

const invalid = (message: string) =>
  new ApiFault(400, 'INVALID_DIPLOMACY_CHANGE', message);
const conflict = () =>
  new ApiFault(
    409,
    'DIPLOMACY_VERSION_CONFLICT',
    '外交资料已变化，请移除原计划，刷新后重新添加。',
  );
const seasons = ['Spring', 'Summer', 'Autumn', 'Winter'] as const;
function futureQuarter(
  quarter: DiplomacyQuarter,
  count: number,
): DiplomacyQuarter {
  const index = seasons.indexOf(quarter.season) + count;
  return {
    sequenceNumber: quarter.sequenceNumber + count,
    gameYear: quarter.gameYear + Math.floor(index / 4),
    season: seasons[index % 4]!,
  };
}
export async function readDiplomacy(
  db: DatabaseClient,
  gameId: string,
): Promise<DiplomacyData> {
  const row = (
    await db.query<{
      revision: number;
      state: string;
      sequenceNumber: number;
      gameYear: number;
      season: DiplomacyQuarter['season'];
    }>(
      'SELECT g.diplomacy_revision AS revision,q.state,q.sequence_number AS "sequenceNumber",q.game_year AS "gameYear",q.season FROM games g JOIN quarters q ON q.game_id=g.id AND q.is_current WHERE g.id=$1',
      [gameId],
    )
  ).rows[0];
  if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
  const relations = (
    await db.query<{ record: DiplomaticRelation }>(
      'SELECT record FROM diplomatic_relations WHERE game_id=$1 ORDER BY country_a,country_b',
      [gameId],
    )
  ).rows.map((r) => r.record);
  const treaties = (
    await db.query<{ record: DiplomaticTreaty }>(
      "SELECT record FROM diplomatic_treaties WHERE game_id=$1 ORDER BY record->>'title',id",
      [gameId],
    )
  ).rows.map((r) => r.record);
  const countries = (
    await db.query<{ id: string; name: string }>(
      "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active' ORDER BY name,id",
      [gameId],
    )
  ).rows;
  return {
    revision: row.revision,
    canEdit: row.state === 'Preparing',
    quarter: {
      sequenceNumber: row.sequenceNumber,
      gameYear: row.gameYear,
      season: row.season,
    },
    relations,
    treaties,
    countries,
  };
}
export async function prepareDiplomacy(
  db: DatabaseClient,
  gameId: string,
  quarter: DiplomacyQuarter,
  inputs: DiplomacyChangeInput[],
  previous: DiplomacyChange[],
  approved: Set<string>,
): Promise<DiplomacyChange[]> {
  if (!inputs.length) return [];
  if (inputs.length > 100) throw invalid('每回合最多 100 项外交变化。');
  const data = await readDiplomacy(db, gameId),
    ids = new Set<string>(),
    targets = new Set<string>();
  const old = new Map(previous.map((c) => [c.id, c]));
  const names = new Map(data.countries!.map((c) => [c.id, c.name]));
  const result: DiplomacyChange[] = [];
  for (const raw of inputs) {
    const input = toDiplomacyInput(raw);
    input.reason = input.reason.trim();
    if (input.expectedQuarterSequence !== quarter.sequenceNumber)
      throw new ApiFault(
        409,
        'QUARTER_CHANGED',
        '回合已变化，请取消设置，刷新后重新核对外交资料。',
      );
    if (!input.reason || input.reason.length > 2000 || ids.has(input.id))
      throw invalid('请填写原因，外交变化标识不能重复。');
    ids.add(input.id);
    if (input.actionId && !approved.has(input.actionId))
      throw invalid('外交变化只能关联本回合已批准的政策。');
    if (
      !Number.isInteger(input.expectedRevision) ||
      input.expectedRevision !== data.revision
    )
      throw conflict();
    if (
      (
        await db.query('SELECT id FROM diplomacy_history WHERE id=$1', [
          input.id,
        ])
      ).rowCount
    )
      throw invalid('外交变化标识已用于正式记录。');
    let before: DiplomacyChange['before'],
      after: DiplomacyChange['after'],
      summary: string,
      target: string;
    if (input.kind === 'WarStatus') {
      if (
        input.countryIds.length !== 2 ||
        input.countryIds[0] === input.countryIds[1] ||
        input.countryIds.some((id) => !names.has(id)) ||
        !['Peace', 'War'].includes(input.state)
      )
        throw invalid('请选择两个不同的本游戏国家和有效战争状态。');
      const pair = [...input.countryIds].sort() as [string, string];
      input.countryIds = pair;
      target = 'War:' + pair.join(':');
      before =
        data.relations.find((r) => isDeepStrictEqual(r.countryIds, pair)) ??
        null;
      if ((before?.state ?? 'Peace') === input.state)
        throw invalid('战争状态未变化。');
      after = {
        countryIds: pair,
        countryNames: [names.get(pair[0])!, names.get(pair[1])!],
        state: input.state,
        effectiveQuarter: quarter,
        reason: input.reason,
      };
      summary =
        after.countryNames.join(' ↔ ') +
        '：' +
        ((before?.state ?? 'Peace') === 'Peace' ? '和平' : '交战') +
        ' → ' +
        (input.state === 'Peace' ? '和平' : '交战');
    } else {
      target = 'Treaty:' + input.treatyId;
      const treaty = data.treaties.find((t) => t.id === input.treatyId) ?? null;
      before = treaty;
      if (input.kind === 'EndTreaty') {
        if (!treaty || treaty.endedAt) throw invalid('条约不存在或已经终止。');
        after = { ...treaty, endedAt: quarter, updatedQuarter: quarter };
        summary = '终止条约：' + treaty.title;
      } else {
        input.title = input.title.trim();
        input.terms = input.terms.trim();
        input.countryIds = [...input.countryIds].sort();
        const directional = input.type === 'Guarantee';
        if (
          directional
            ? input.countryIds.length !== 2 ||
              !input.grantorCountryId ||
              !input.countryIds.includes(input.grantorCountryId)
            : input.grantorCountryId !== null
        )
          throw invalid('独立保障需要两个参与国，并明确保障国。');
        if (
          !input.title ||
          input.title.length > 200 ||
          !input.terms ||
          input.terms.length > 20000 ||
          !Object.hasOwn(treatyKindNames, input.type) ||
          !['Public', 'Participants'].includes(input.visibility) ||
          input.countryIds.length < 2 ||
          input.countryIds.length > 20 ||
          new Set(input.countryIds).size !== input.countryIds.length ||
          input.countryIds.some((id) => !names.has(id)) ||
          (input.durationQuarters !== null &&
            (!Number.isInteger(input.durationQuarters) ||
              input.durationQuarters < 1 ||
              input.durationQuarters > 400))
        )
          throw invalid('请填写有效条约正文、参与国家、公开范围和期限。');
        if (treaty?.endedAt) throw invalid('已终止条约不能修改，请另立新约。');
        if (
          treaty &&
          (!isDeepStrictEqual(treaty.countryIds, input.countryIds) ||
            treaty.visibility !== input.visibility)
        )
          throw invalid(
            '已生效条约的参与国和公开范围保持固定；需要变更时请终止后另立新约。',
          );
        if (
          !treaty &&
          (
            await db.query('SELECT id FROM diplomatic_treaties WHERE id=$1', [
              input.treatyId,
            ])
          ).rowCount
        )
          throw invalid('条约标识不属于当前游戏。');
        after = {
          id: input.treatyId,
          title: input.title,
          type: input.type,
          countryIds: input.countryIds,
          countryNames: input.countryIds.map((id) => names.get(id)!),
          terms: input.terms,
          visibility: input.visibility,
          grantorCountryId: input.grantorCountryId,
          startQuarter: treaty?.startQuarter ?? quarter,
          updatedQuarter: quarter,
          expiresAt:
            input.durationQuarters === null
              ? null
              : futureQuarter(quarter, input.durationQuarters),
          endedAt: null,
        };
        if (
          treaty &&
          isDeepStrictEqual({ ...treaty, updatedQuarter: quarter }, after)
        )
          throw invalid('条约内容未变化。');
        summary =
          (treaty ? '修改条约：' : '缔结条约：') +
          after.title +
          '（' +
          after.countryNames.join('、') +
          '；' +
          (after.visibility === 'Public' ? '公开' : '秘密') +
          '）';
      }
    }
    if (targets.has(target))
      throw invalid('同一国家对或条约只能设置一次，请合并后保存。');
    targets.add(target);
    const saved = old.get(input.id);
    if (saved) {
      const oldTarget =
        saved.kind === 'WarStatus'
          ? 'War:' + saved.countryIds.join(':')
          : 'Treaty:' + saved.treatyId;
      if (oldTarget !== target || saved.kind !== input.kind)
        throw invalid('变更目标或操作时请移除原计划后重新添加。');
      if (
        !isDeepStrictEqual(saved.before, before) ||
        saved.expectedRevision !== input.expectedRevision
      )
        throw conflict();
    }
    result.push({ ...input, before, after, summary });
  }
  if (
    data.treaties.length +
      result.filter((c) => c.kind === 'Treaty' && !c.before).length >
    500
  )
    throw invalid('每场游戏最多保留 500 份条约，请在规则中合并重复协议。');
  return result;
}
export async function applyDiplomacy(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  changes: DiplomacyChange[],
  operation: 'Setup' | 'Settlement',
) {
  for (const change of changes) {
    if (change.kind === 'WarStatus')
      await db.query(
        'INSERT INTO diplomatic_relations(game_id,country_a,country_b,record) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(game_id,country_a,country_b) DO UPDATE SET record=EXCLUDED.record',
        [gameId, ...change.countryIds, JSON.stringify(change.after)],
      );
    else
      await db.query(
        'INSERT INTO diplomatic_treaties(id,game_id,record) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET record=EXCLUDED.record WHERE diplomatic_treaties.game_id=EXCLUDED.game_id',
        [change.treatyId, gameId, JSON.stringify(change.after)],
      );
    await db.query(
      'INSERT INTO diplomacy_history(id,game_id,quarter_id,actor_user_id,operation,change) VALUES($1,$2,$3,$4,$5,$6::jsonb)',
      [change.id, gameId, quarterId, userId, operation, JSON.stringify(change)],
    );
  }
  if (changes.length)
    await db.query(
      'UPDATE games SET diplomacy_revision=diplomacy_revision+1 WHERE id=$1',
      [gameId],
    );
}
export function canReadTreaty(treaty: DiplomaticTreaty, own: string | null) {
  return (
    treaty.visibility === 'Public' || (!!own && treaty.countryIds.includes(own))
  );
}
export async function publishDiplomacy(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
  userId: string,
  quarter: DiplomacyQuarter,
  stored: DiplomacyChange[],
  approved: Set<string>,
  publication?: {
    previousWorldVersion: number;
    worldVersion: number;
    tileIds: string[];
    mapRevisionDelta?: number;
  },
) {
  if (!stored.length) return { publication, changes: [] };
  const changes = await prepareDiplomacy(
    db,
    gameId,
    quarter,
    stored.map(toDiplomacyInput),
    stored,
    approved,
  );
  await applyDiplomacy(db, gameId, quarterId, userId, changes, 'Settlement');
  if (publication) return { publication, changes };
  const row = (
    await db.query<{ current_world_version: string }>(
      'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1 RETURNING current_world_version',
      [gameId],
    )
  ).rows[0]!;
  const version = Number(row.current_world_version);
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
export class DiplomacyService {
  constructor(private readonly database: DatabasePool) {}
  private async transaction<T>(
    read: boolean,
    operation: (db: DatabaseClient) => Promise<T>,
  ) {
    const db = await this.database.connect();
    try {
      await db.query(
        read ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      const result = await operation(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async get(gameId: string, userId: string): Promise<DiplomacyData> {
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
        own = member.role === 'Player' ? member.controlled_country_id : null;
      const data = await readDiplomacy(db, gameId);
      if (!host) {
        data.canEdit = false;
        delete data.countries;
        data.treaties = data.treaties.filter((t) => canReadTreaty(t, own));
      }
      const history = (
        await db.query<{
          id: string;
          operation: 'Setup' | 'Settlement';
          change: DiplomacyChange;
          game_year: number;
          season: DiplomacyQuarter['season'];
          sequence_number: number;
        }>(
          `SELECT h.id,h.operation,h.change,q.game_year,q.season,q.sequence_number FROM diplomacy_history h JOIN quarters q ON q.game_id=h.game_id AND q.id=h.quarter_id WHERE h.game_id=$1 AND ($2::boolean OR h.change->>'kind'='WarStatus' OR h.change->'after'->>'visibility'='Public' OR ($3::text IS NOT NULL AND h.change->'after'->'countryIds' ? $3)) ORDER BY h.created_at DESC,h.id DESC LIMIT 30`,
          [gameId, host, own],
        )
      ).rows;
      data.history = history.map((h) => ({
        id: h.id,
        operation: h.operation,
        quarter: {
          gameYear: h.game_year,
          season: h.season,
          sequenceNumber: h.sequence_number,
        },
        summary: h.change.summary,
        reason: h.change.reason,
        before: h.change.before,
        after: h.change.after,
      }));
      return data;
    });
  }
  async setup(gameId: string, userId: string, inputs: DiplomacyChangeInput[]) {
    await this.transaction(false, async (db) => {
      await requireMapHost(db, gameId, userId);
      const q = (
        await db.query<{
          id: string;
          state: string;
          sequenceNumber: number;
          gameYear: number;
          season: DiplomacyQuarter['season'];
        }>(
          'SELECT id,state,sequence_number AS "sequenceNumber",game_year AS "gameYear",season FROM quarters WHERE game_id=$1 AND is_current FOR UPDATE',
          [gameId],
        )
      ).rows[0];
      if (!q || q.state !== 'Preparing')
        throw new ApiFault(
          409,
          'DIPLOMACY_SETUP_LOCKED',
          '只能在回合准备阶段设置外交状态。',
        );
      if (!inputs.length || inputs.some((c) => c.actionId !== null))
        throw invalid('开场设置需要至少一项变化，不能关联政策。');
      const changes = await prepareDiplomacy(
        db,
        gameId,
        {
          sequenceNumber: q.sequenceNumber,
          gameYear: q.gameYear,
          season: q.season,
        },
        inputs,
        [],
        new Set(),
      );
      await applyDiplomacy(db, gameId, q.id, userId, changes, 'Setup');
      await db.query(
        'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1',
        [gameId],
      );
    });
    return this.get(gameId, userId);
  }
}
