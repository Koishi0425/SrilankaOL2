import { randomUUID } from 'node:crypto';
import {
  canReadResult,
  projectResult,
  prepareResultAudiences,
} from './result-audience.js';
import {
  correctedText,
  readCorrections,
  SettlementCorrectionService,
} from './corrections.js';
import { isDeepStrictEqual } from 'node:util';

import type {
  GameRole,
  MapRevealPlan,
  QuarterSettlement,
  QuarterState,
  QuarterSummary,
  SaveSettlementInput,
  Season,
  SettlementAction,
  SettlementSummary,
  SettlementStateChange,
  SettlementBattle,
  BattleRollInput,
  SettlementRecruitment,
  EconomicRules,
  DiplomacyChange,
  GovernmentChange,
} from '@srilanka/contracts';
import { toDiplomacyInput, toGovernmentInput } from '@srilanka/contracts';
import {
  prepareGovernment,
  publishGovernment,
} from '../government/government-service.js';
import {
  prepareDiplomacy,
  publishDiplomacy,
} from '../diplomacy/diplomacy-service.js';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { readGameRules } from '../games/game-rules.js';
import { listRevealPlans, publishMapReveals } from '../world/map-discovery.js';
import { refreshCountryVision } from '../world/map-vision.js';
import {
  prepareStateChanges,
  publishStateChanges,
  publishTerritoryKnowledge,
  stateOptions,
  type StoredStateChange,
} from './state-changes.js';
import {
  battleInput,
  prepareBattles,
  readBattles,
  rollBattle,
  validateCombinedEffects,
  type StoredBattle,
} from './battles.js';
import { lockMap } from '../world/map-mutations.js';
import { CountryService } from '../games/country-service.js';
import {
  publishResources,
  resourceInput,
  type StoredResourceChange,
} from './resources.js';
import type { ResourceChange } from '@srilanka/contracts';
import {
  prepareRecruitments,
  recruitmentInput,
  prepareRecruitmentCosts,
  combineRecruitmentEffects,
  type StoredRecruitment,
} from './recruitments.js';
import {
  economicBillInput,
  prepareEconomicBill,
  previewEconomy,
  type StoredEconomicBill,
  type EconomicSnapshot,
} from './economy.js';

type Queryable = DatabaseClient | DatabasePool;
interface QuarterRow {
  id: string;
  game_year: number;
  season: Season;
  sequence_number: number;
  state: QuarterState;
  is_current: boolean;
  action_deadline: Date | null;
  current_world_version: string;
  action_rules: unknown;
  economic_snapshot: EconomicSnapshot | null;
  current_economic_rules: EconomicRules;
}
interface SettlementRow {
  version: number;
  public_report: string;
  results: SaveSettlementInput['results'];
  state_changes: StoredStateChange[];
  battles: StoredBattle[];
  resource_changes: StoredResourceChange[];
  recruitments: StoredRecruitment[];
  economic_bill: StoredEconomicBill | null;
  diplomacy_changes: DiplomacyChange[];
  government_changes: GovernmentChange[];
  published_snapshot: {
    publicReport: string;
    actions: SettlementAction[];
    mapReveals?: MapRevealPlan[];
    stateChanges?: SettlementStateChange[];
    battles?: SettlementBattle[];
    resourceChanges?: ResourceChange[];
    recruitments?: SettlementRecruitment[];
    economicBill?: StoredEconomicBill['bill'] | null;
    diplomacyChanges?: DiplomacyChange[];
    governmentChanges?: GovernmentChange[];
  } | null;
  published_at: Date | null;
}

export function nextCalendar(gameYear: number, season: Season) {
  const seasons: Season[] = ['Spring', 'Summer', 'Autumn', 'Winter'];
  const index = seasons.indexOf(season);
  return {
    gameYear: gameYear + (index === 3 ? 1 : 0),
    season: seasons[(index + 1) % 4]!,
  };
}

function quarterSummary(row: QuarterRow): QuarterSummary {
  return {
    id: row.id,
    gameYear: row.game_year,
    season: row.season,
    sequenceNumber: row.sequence_number,
    state: row.state,
    actionDeadline: row.action_deadline?.toISOString() ?? null,
    currentWorldVersion: Number(row.current_world_version),
  };
}

export class SettlementService {
  readonly corrections: SettlementCorrectionService;
  readonly countries: CountryService;
  constructor(
    private readonly database: DatabasePool,
    private readonly beforePublish?: (context: {
      gameId: string;
      quarterId: string;
      version: number;
    }) => Promise<void>,
  ) {
    this.countries = new CountryService(database);
    this.corrections = new SettlementCorrectionService(database);
  }

  private async member(
    gameId: string,
    userId: string,
    db: Queryable = this.database,
  ) {
    const result = await db.query<{
      role: GameRole;
      controlled_country_id: string | null;
    }>(
      `SELECT role, controlled_country_id FROM game_members
       WHERE game_id = $1 AND user_id = $2 AND status = 'Active'`,
      [gameId, userId],
    );
    const member = result.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return { ...member, host: ['Host', 'Administrator'].includes(member.role) };
  }

  private async host(gameId: string, userId: string, db: Queryable) {
    const member = await this.member(gameId, userId, db);
    if (!member.host)
      throw new ApiFault(
        403,
        'HOST_PERMISSION_REQUIRED',
        '该操作需要主持人权限。',
      );
  }

  private async quarter(
    db: Queryable,
    gameId: string,
    quarterId: string,
    lock = false,
  ) {
    const result = await db.query<QuarterRow>(
      `SELECT q.*,g.economic_rules AS current_economic_rules, COALESCE(q.published_world_version, g.current_world_version) AS current_world_version FROM quarters q JOIN games g ON g.id = q.game_id
       WHERE q.game_id = $1 AND q.id = $2 ${lock ? 'FOR UPDATE OF q' : ''}`,
      [gameId, quarterId],
    );
    const quarter = result.rows[0];
    if (!quarter) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该回合。');
    return quarter;
  }

  private async draft(db: Queryable, gameId: string, quarterId: string) {
    const result = await db.query<SettlementRow>(
      'SELECT * FROM quarter_settlements WHERE game_id = $1 AND quarter_id = $2',
      [gameId, quarterId],
    );
    return result.rows[0];
  }

  private async actions(
    db: Queryable,
    gameId: string,
    quarterId: string,
    results: SaveSettlementInput['results'] = [],
  ) {
    const rows = await db.query<{
      id: string;
      country_id: string;
      country_name: string;
      title: string;
      submitted_text: string;
      status: SettlementAction['status'];
      review_reason: string;
      refs: NonNullable<SettlementAction['refs']>;
    }>(
      `SELECT a.id, a.country_id, c.name AS country_name, a.title, a.status,
          COALESCE(s.text, a.submitted_original_text, a.current_text) AS submitted_text,
          COALESCE(h.reason, '') AS review_reason,
          COALESCE(s.refs, (SELECT jsonb_agg(jsonb_build_object('refKind',r.ref_kind,'objectType',r.object_type,'objectId',r.object_id,'label',r.label) ORDER BY r.id) FROM action_object_refs r WHERE r.game_id=a.game_id AND r.action_id=a.id), '[]'::jsonb) AS refs
       FROM actions a JOIN countries c ON c.game_id = a.game_id AND c.id = a.country_id
       LEFT JOIN LATERAL (
         SELECT text, refs FROM action_submissions WHERE game_id = a.game_id AND action_id = a.id
         ORDER BY submitted_at DESC, id DESC LIMIT 1
       ) s ON TRUE
       LEFT JOIN LATERAL (
         SELECT reason FROM action_status_history WHERE game_id = a.game_id AND action_id = a.id
           AND to_status IN ('Approved', 'Rejected') ORDER BY created_at DESC, id DESC LIMIT 1
       ) h ON TRUE
       WHERE a.game_id = $1 AND a.quarter_id = $2 AND a.status IN ('Approved', 'Rejected', 'Completed')
       ORDER BY c.name, a.submitted_at, a.id`,
      [gameId, quarterId],
    );
    const feedback = new Map(results.map((item) => [item.actionId, item]));
    return rows.rows.map((row): SettlementAction => ({
      actionId: row.id,
      countryId: row.country_id,
      countryName: row.country_name,
      title: row.title,
      submittedText: row.submitted_text,
      status: row.status,
      reviewReason: row.review_reason,
      feedback: feedback.get(row.id)?.feedback ?? '',
      resultAudience: feedback.get(row.id)?.resultAudience ?? {
        kind: 'OwnerOnly',
      },
      refs: row.refs,
    }));
  }

  async list(gameId: string, userId: string): Promise<SettlementSummary[]> {
    const member = await this.member(gameId, userId);
    const result = await this.database.query<
      QuarterRow & { published_at: Date | null; corrected_at: Date | null }
    >(
      `SELECT q.*, s.published_at, (
         SELECT MAX(c.created_at) FROM settlement_corrections c WHERE c.game_id=q.game_id AND c.quarter_id=q.id
           AND ($2::boolean OR c.kind='PublicReport'
             OR (c.kind <> 'ActionFeedback' AND $3::boolean AND c.country_id=$4::uuid)
             OR (c.kind='ActionFeedback' AND EXISTS (
               SELECT 1 FROM jsonb_array_elements(COALESCE(s.published_snapshot->'actions','[]'::jsonb)) a
               WHERE a->>'actionId'=c.data->>'actionId' AND (
                 a->'resultAudience'->>'kind'='Public'
                 OR ($3::boolean AND $4::uuid IS NOT NULL AND (
                   (COALESCE(a->'resultAudience'->>'kind','OwnerOnly')='OwnerOnly' AND a->>'countryId'=$4::text)
                   OR (a->'resultAudience'->>'kind'='Countries' AND a->'resultAudience'->'countryIds' ? $4::text)
                 ))
               )
             )))
       ) AS corrected_at FROM quarters q
       LEFT JOIN quarter_settlements s ON s.game_id = q.game_id AND s.quarter_id = q.id
       WHERE q.game_id = $1 AND ($2::boolean OR q.is_current OR s.published_at IS NOT NULL)
       ORDER BY q.sequence_number DESC`,
      [
        gameId,
        member.host,
        member.role === 'Player',
        member.controlled_country_id,
      ],
    );
    return result.rows.map((row) => ({
      quarterId: row.id,
      gameYear: row.game_year,
      season: row.season,
      sequenceNumber: row.sequence_number,
      state: row.state,
      isCurrent: row.is_current,
      publishedAt: row.published_at?.toISOString() ?? null,
      correctedAt: row.corrected_at?.toISOString() ?? null,
    }));
  }

  async get(
    gameId: string,
    userId: string,
    quarterId: string,
  ): Promise<QuarterSettlement> {
    // 一个读取快照，避免发布或推进回合时混合草稿与正式结果。
    const client = await this.database.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const member = await this.member(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId);
      const draft = await this.draft(client, gameId, quarterId);
      const corrections = await readCorrections(client, gameId, quarterId);
      const published = draft?.published_snapshot
        ? {
            ...draft.published_snapshot,
            ...correctedText(draft.published_snapshot, corrections),
          }
        : null;
      const visible = !!published || member.host;
      const actions =
        published?.actions ??
        (member.host
          ? await this.actions(client, gameId, quarterId, draft?.results)
          : []);
      const data: QuarterSettlement = {
        quarter: quarterSummary(quarter),
        isCurrent: quarter.is_current,
        version: visible ? (draft?.version ?? 0) : 0,
        publishedAt: draft?.published_at?.toISOString() ?? null,
        publicReport:
          published?.publicReport ??
          (member.host ? (draft?.public_report ?? '') : ''),
        actions: member.host
          ? actions
          : actions
              .filter((action) =>
                canReadResult(
                  action,
                  member.role,
                  member.controlled_country_id,
                ),
              )
              .map((action) =>
                projectResult(
                  action,
                  member.role,
                  member.controlled_country_id,
                ),
              ),
        corrections: corrections
          .filter(
            ({ change }) =>
              member.host ||
              change.kind === 'PublicReport' ||
              (change.kind === 'ActionFeedback'
                ? actions.some(
                    (action) =>
                      action.actionId === change.actionId &&
                      canReadResult(
                        action,
                        member.role,
                        member.controlled_country_id,
                      ),
                  )
                : member.role === 'Player' &&
                  change.countryId === member.controlled_country_id),
          )
          .map((correction) =>
            !member.host &&
            correction.change.kind === 'ActionFeedback' &&
            !(
              member.role === 'Player' &&
              correction.change.countryId === member.controlled_country_id
            )
              ? {
                  ...correction,
                  change: { ...correction.change, title: '政策结算结果' },
                }
              : correction,
          ),
        ...(member.host ? { correctionVersion: corrections.length } : {}),
      };
      const reveals =
        published?.mapReveals ??
        (member.host ? await listRevealPlans(client, gameId, quarterId) : []);
      data.mapReveals = member.host
        ? reveals
        : reveals.filter(
            (plan) =>
              member.role === 'Player' &&
              plan.countryId === member.controlled_country_id,
          );
      if (member.host) {
        data.resultCountries = (
          await client.query<{ id: string; name: string }>(
            'SELECT id,name FROM countries WHERE game_id=$1 ORDER BY name,id',
            [gameId],
          )
        ).rows;
        data.diplomacyChanges =
          published?.diplomacyChanges ?? draft?.diplomacy_changes ?? [];
        data.economyStatus = {
          status: quarter.economic_snapshot
            ? quarter.economic_snapshot.rules.enabled
              ? 'Ready'
              : 'Disabled'
            : quarter.current_economic_rules.enabled
              ? 'MissingSnapshot'
              : 'Disabled',
          capturedAt: quarter.economic_snapshot?.capturedAt ?? null,
        };
        data.economicBill =
          published?.economicBill ?? draft?.economic_bill?.bill ?? null;
        data.recruitments =
          published?.recruitments ??
          draft?.recruitments.map((item) => item.recruitment) ??
          [];
        data.governmentChanges =
          published?.governmentChanges ?? draft?.government_changes ?? [];
        data.resourceChanges =
          published?.resourceChanges ??
          draft?.resource_changes.map((item) => item.change) ??
          [];
        data.battles =
          published?.battles ??
          (await readBattles(client, gameId, quarterId, draft?.battles ?? []));
        data.stateChanges =
          published?.stateChanges ??
          draft?.state_changes.map((item) => item.change) ??
          [];
        const map = await client.query<{ asset_version: string }>(
          'SELECT asset_version FROM world_maps WHERE game_id=$1',
          [gameId],
        );
        data.mapRevision = Number(map.rows[0]?.asset_version ?? 0);
      }
      await client.query('COMMIT');
      return data;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async options(gameId: string, userId: string, quarterId: string) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId);
      this.current(quarter);
      if (quarter.state !== 'Resolving')
        throw new ApiFault(
          409,
          'SETTLEMENT_LOCKED',
          '请在回合结算中设置状态变化。',
        );
      const options = await stateOptions(client, gameId);
      await client.query('COMMIT');
      return options;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async economicPreview(
    gameId: string,
    userId: string,
    quarterId: string,
    expectedVersion: number,
  ) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId),
        draft = await this.draft(client, gameId, quarterId);
      this.current(quarter);
      this.version(draft, expectedVersion);
      if (quarter.state !== 'Resolving' || draft?.published_at)
        throw new ApiFault(
          409,
          'SETTLEMENT_LOCKED',
          '请在回合结算中生成经济账单。',
        );
      if (!quarter.economic_snapshot?.rules.enabled)
        throw new ApiFault(
          409,
          'ECONOMY_UNAVAILABLE',
          '本回合没有启用经济结算的期初快照。',
        );
      const bill = await previewEconomy(
        client,
        gameId,
        quarter.economic_snapshot,
      );
      await client.query('COMMIT');
      return bill;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async transaction<T>(
    operation: (client: DatabaseClient) => Promise<T>,
  ) {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private current(quarter: QuarterRow) {
    if (!quarter.is_current)
      throw new ApiFault(409, 'QUARTER_CHANGED', '当前回合已变化，请刷新。');
  }

  private async state(
    client: DatabaseClient,
    gameId: string,
    userId: string,
    quarter: QuarterRow,
    state: QuarterState,
  ) {
    await client.query(
      'UPDATE quarters SET state = $3 WHERE game_id = $1 AND id = $2',
      [gameId, quarter.id, state],
    );
    await client.query(
      `INSERT INTO quarter_state_history (id, game_id, quarter_id, from_state, to_state, actor_user_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [randomUUID(), gameId, quarter.id, quarter.state, state, userId],
    );
  }

  async begin(gameId: string, userId: string, quarterId: string) {
    await this.transaction(async (client) => {
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId, true);
      this.current(quarter);
      if (quarter.state === 'Resolving') return;
      if (quarter.state !== 'HostReview')
        throw new ApiFault(
          409,
          'INVALID_QUARTER_TRANSITION',
          '请先完成主持人审核。',
        );
      const pending = await client.query(
        `SELECT id FROM actions WHERE game_id = $1 AND quarter_id = $2
           AND status NOT IN ('Draft', 'Approved', 'Rejected', 'Withdrawn', 'Invalidated') LIMIT 1`,
        [gameId, quarterId],
      );
      if (pending.rows[0])
        throw new ApiFault(
          409,
          'ACTION_REVIEW_INCOMPLETE',
          '仍有未完成审核或等待补充的政策。',
        );
      await client.query(
        `INSERT INTO quarter_settlements (game_id, quarter_id, updated_by_user_id) VALUES ($1,$2,$3)`,
        [gameId, quarterId, userId],
      );
      await this.state(client, gameId, userId, quarter, 'Resolving');
    });
    return this.get(gameId, userId, quarterId);
  }

  private version(draft: SettlementRow | undefined, expectedVersion: number) {
    if (!draft || draft.version !== expectedVersion)
      throw new ApiFault(
        409,
        'SETTLEMENT_VERSION_CONFLICT',
        '结算草稿已变化，请刷新后再操作。',
      );
  }

  async save(
    gameId: string,
    userId: string,
    quarterId: string,
    input: SaveSettlementInput,
  ) {
    await this.transaction(async (client) => {
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId, true);
      this.current(quarter);
      const draft = await this.draft(client, gameId, quarterId);
      if (quarter.state !== 'Resolving' || draft?.published_at)
        throw new ApiFault(409, 'SETTLEMENT_LOCKED', '当前回合不能修改结算。');
      this.version(draft, input.expectedVersion);
      const actions = await this.actions(client, gameId, quarterId);
      const ids = new Set(actions.map((action) => action.actionId));
      if (
        new Set(input.results.map((result) => result.actionId)).size !==
          input.results.length ||
        input.results.some((result) => !ids.has(result.actionId))
      ) {
        throw new ApiFault(
          400,
          'INVALID_SETTLEMENT_ACTION',
          '反馈中包含重复或不属于本回合的政策。',
        );
      }
      const results = await prepareResultAudiences(
        client,
        gameId,
        input.results,
        draft!.results,
      );
      const changes =
        input.stateChanges === undefined
          ? draft!.state_changes
          : await prepareStateChanges(
              client,
              gameId,
              input.stateChanges,
              draft!.state_changes,
              new Set(
                actions
                  .filter((action) => action.status === 'Approved')
                  .map((action) => action.actionId),
              ),
              input.expectedMapRevision,
            );
      const approved = new Set(
        actions
          .filter((action) => action.status === 'Approved')
          .map((action) => action.actionId),
      );
      const diplomacy = await prepareDiplomacy(
        client,
        gameId,
        {
          sequenceNumber: quarter.sequence_number,
          gameYear: quarter.game_year,
          season: quarter.season,
        },
        input.diplomacyChanges ??
          draft!.diplomacy_changes.map(toDiplomacyInput),
        draft!.diplomacy_changes,
        approved,
      );
      const government = await prepareGovernment(
        client,
        gameId,
        {
          sequenceNumber: quarter.sequence_number,
          gameYear: quarter.game_year,
          season: quarter.season,
        },
        input.governmentChanges ??
          draft!.government_changes.map(toGovernmentInput),
        draft!.government_changes,
        approved,
        'Settlement',
      );
      const battles =
        input.battles === undefined
          ? draft!.battles
          : await prepareBattles(
              client,
              gameId,
              quarterId,
              input.battles,
              draft!.battles,
              approved,
              input.expectedMapRevision,
            );
      // Recheck saved participants even when an older client edits only text.
      if (input.battles === undefined && battles.length)
        await prepareBattles(
          client,
          gameId,
          quarterId,
          battles.map((item) => battleInput(item.battle)),
          battles,
          approved,
        );
      const recruitments = await prepareRecruitments(
        client,
        gameId,
        input.recruitments ??
          draft!.recruitments.map((item) => recruitmentInput(item.recruitment)),
        draft!.recruitments,
        approved,
        input.expectedMapRevision,
      );
      const combined = await validateCombinedEffects(
        client,
        gameId,
        changes,
        battles,
        approved,
      );
      await combineRecruitmentEffects(
        client,
        gameId,
        combined,
        recruitments,
        approved,
      );
      const economic = await prepareEconomicBill(
        client,
        gameId,
        quarter.economic_snapshot,
        input.economicBill === undefined
          ? draft!.economic_bill
            ? economicBillInput(draft!.economic_bill.bill)
            : null
          : input.economicBill,
        draft!.economic_bill,
      );
      const resources = await prepareRecruitmentCosts(
        client,
        gameId,
        input.resourceChanges ??
          draft!.resource_changes.map((item) => resourceInput(item.change)),
        draft!.resource_changes,
        recruitments,
        draft!.recruitments,
        approved,
        economic,
        draft!.economic_bill,
      );
      await client.query(
        `UPDATE quarter_settlements SET version = version + 1, public_report = $3,
          results = $4::jsonb, updated_by_user_id = $5, state_changes = $6::jsonb, battles = $7::jsonb, resource_changes = $8::jsonb, recruitments = $9::jsonb,economic_bill=$10::jsonb,diplomacy_changes=$11::jsonb,government_changes=$12::jsonb, updated_at = NOW()
         WHERE game_id = $1 AND quarter_id = $2`,
        [
          gameId,
          quarterId,
          input.publicReport,
          JSON.stringify(results),
          userId,
          JSON.stringify(changes),
          JSON.stringify(battles),
          JSON.stringify(resources.manual),
          JSON.stringify(recruitments),
          economic ? JSON.stringify(economic) : null,
          JSON.stringify(diplomacy),
          JSON.stringify(government),
        ],
      );
    });
    return this.get(gameId, userId, quarterId);
  }

  async roll(
    gameId: string,
    userId: string,
    quarterId: string,
    battleId: string,
    input: BattleRollInput,
  ) {
    await this.transaction(async (client) => {
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId, true);
      const draft = await this.draft(client, gameId, quarterId);
      const {
        expectedVersion: _version,
        expectedMapRevision: _revision,
        idempotencyKey,
        ...request
      } = input;
      void _version;
      void _revision;
      const retry = await client.query<{ request: unknown }>(
        'SELECT request FROM settlement_battle_rolls WHERE game_id=$1 AND quarter_id=$2 AND battle_id=$3 AND idempotency_key=$4',
        [gameId, quarterId, battleId, idempotencyKey],
      );
      if (retry.rows[0]) {
        if (!isDeepStrictEqual(request, retry.rows[0].request))
          throw new ApiFault(
            409,
            'IDEMPOTENCY_CONFLICT',
            '该掷骰请求标识已用于其他参数，请刷新后重新操作。',
          );
        return;
      }
      this.current(quarter);
      if (quarter.state !== 'Resolving' || draft?.published_at)
        throw new ApiFault(409, 'SETTLEMENT_LOCKED', '当前回合不能掷骰。');
      this.version(draft, input.expectedVersion);
      const battle = draft!.battles.find((item) => item.battle.id === battleId);
      if (!battle)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '请先保存这场战斗。');
      await lockMap(client, gameId, input.expectedMapRevision);
      const approved = new Set(
        (await this.actions(client, gameId, quarterId))
          .filter((item) => item.status === 'Approved')
          .map((item) => item.actionId),
      );
      await prepareBattles(
        client,
        gameId,
        quarterId,
        [battleInput(battle.battle)],
        [battle],
        approved,
      );
      await rollBattle(client, gameId, quarterId, userId, battle, input);
      await client.query(
        'UPDATE quarter_settlements SET version=version+1,updated_by_user_id=$3,updated_at=NOW() WHERE game_id=$1 AND quarter_id=$2',
        [gameId, quarterId, userId],
      );
    });
    return this.get(gameId, userId, quarterId);
  }

  async publish(
    gameId: string,
    userId: string,
    quarterId: string,
    expectedVersion: number,
    expectedMapRevision?: number,
  ) {
    await this.transaction(async (client) => {
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId, true);
      const draft = await this.draft(client, gameId, quarterId);
      this.version(draft, expectedVersion);
      if (draft!.published_at) return; // 同一修订的重复请求不会再次执行结算。
      this.current(quarter);
      if (quarter.state !== 'Resolving')
        throw new ApiFault(409, 'SETTLEMENT_LOCKED', '当前回合不能发布结算。');
      if (quarter.economic_snapshot?.rules.enabled && !draft!.economic_bill)
        throw new ApiFault(
          409,
          'ECONOMIC_BILL_REQUIRED',
          '请生成并核对本回合经济账单后发布。',
        );
      const actions = await this.actions(
        client,
        gameId,
        quarterId,
        draft!.results,
      );
      const missing = actions.filter((action) => !action.feedback.trim());
      if (missing.length)
        throw new ApiFault(
          409,
          'SETTLEMENT_INCOMPLETE',
          '请填写所有政策的反馈后再发布。',
          { actionIds: missing.map((action) => action.actionId) },
        );
      if (!actions.length && !draft!.public_report.trim())
        throw new ApiFault(
          409,
          'SETTLEMENT_INCOMPLETE',
          '请填写回合公报后再发布。',
        );
      const approved = new Set(
        actions
          .filter((action) => action.status === 'Approved')
          .map((action) => action.actionId),
      );
      if (draft!.battles.some((item) => !item.battle.resolution))
        throw new ApiFault(
          409,
          'BATTLE_UNRESOLVED',
          '请先裁决所有战斗，或移除未执行的战斗。',
        );
      if (
        draft!.battles.length ||
        draft!.state_changes.length ||
        draft!.recruitments.length
      ) {
        if (expectedMapRevision === undefined)
          throw new ApiFault(
            409,
            'MAP_VERSION_CONFLICT',
            '请刷新结算并检查战场后发布。',
          );
        await lockMap(client, gameId, expectedMapRevision);
      }
      await prepareBattles(
        client,
        gameId,
        quarterId,
        draft!.battles.map((item) => battleInput(item.battle)),
        draft!.battles,
        approved,
      );
      const combined = await validateCombinedEffects(
        client,
        gameId,
        draft!.state_changes,
        draft!.battles,
        approved,
      );
      const recruitments = await prepareRecruitments(
        client,
        gameId,
        draft!.recruitments.map((item) => recruitmentInput(item.recruitment)),
        draft!.recruitments,
        approved,
      );
      const effects = await combineRecruitmentEffects(
        client,
        gameId,
        combined,
        recruitments,
        approved,
      );
      const economic = await prepareEconomicBill(
        client,
        gameId,
        quarter.economic_snapshot,
        draft!.economic_bill
          ? economicBillInput(draft!.economic_bill.bill)
          : null,
        draft!.economic_bill,
      );
      const resources = await prepareRecruitmentCosts(
        client,
        gameId,
        draft!.resource_changes.map((item) => resourceInput(item.change)),
        draft!.resource_changes,
        recruitments,
        draft!.recruitments,
        approved,
        economic,
        draft!.economic_bill,
      );
      // The quarter lock remains held: a failed checkpoint rolls back publication.
      // Authorization and draft validation above prevent unauthorized checkpoint requests.
      await this.beforePublish?.({
        gameId,
        quarterId,
        version: expectedVersion,
      });
      const statePublication = await publishStateChanges(
        client,
        gameId,
        quarterId,
        userId,
        effects,
        expectedMapRevision,
        recruitments.flatMap((item) =>
          item.recruitment.kind === 'Create'
            ? [
                {
                  id: item.recruitment.id,
                  countryId: item.recruitment.countryId,
                  tileId: item.recruitment.tileId,
                  name: item.recruitment.name,
                  strength: item.recruitment.strength,
                },
              ]
            : [],
        ),
      );
      let publication = await publishResources(
        client,
        gameId,
        quarterId,
        userId,
        resources.all,
        statePublication,
      );
      const diplomaticPublication = await publishDiplomacy(
        client,
        gameId,
        quarterId,
        userId,
        {
          sequenceNumber: quarter.sequence_number,
          gameYear: quarter.game_year,
          season: quarter.season,
        },
        draft!.diplomacy_changes,
        approved,
        publication,
      );
      publication = diplomaticPublication.publication;
      const governmentPublication = await publishGovernment(
        client,
        gameId,
        quarterId,
        userId,
        {
          sequenceNumber: quarter.sequence_number,
          gameYear: quarter.game_year,
          season: quarter.season,
        },
        draft!.government_changes,
        approved,
        publication,
      );
      publication = governmentPublication.publication;
      await publishMapReveals(
        client,
        gameId,
        quarterId,
        userId,
        expectedMapRevision,
        publication,
      );
      await publishTerritoryKnowledge(client, gameId, effects);
      await refreshCountryVision(client, gameId);
      const snapshot = {
        diplomacyChanges: diplomaticPublication.changes,
        governmentChanges: governmentPublication.changes,
        economicBill: economic?.bill ?? null,
        resourceChanges: resources.manual.map((item) => item.change),
        recruitments: recruitments.map((item) => item.recruitment),
        battles: await readBattles(client, gameId, quarterId, draft!.battles),
        stateChanges: draft!.state_changes.map((item) => item.change),
        mapReveals: await listRevealPlans(client, gameId, quarterId),
        publicReport: draft!.public_report,
        actions: actions.map((action) => ({
          ...action,
          status: action.status === 'Approved' ? 'Completed' : action.status,
        })),
      };
      await client.query(
        `INSERT INTO action_status_history (id, game_id, action_id, from_status, to_status, actor_user_id, reason)
         SELECT gen_random_uuid(), game_id, id, status, 'Completed', $3, '回合结算已发布'
         FROM actions WHERE game_id = $1 AND quarter_id = $2 AND status = 'Approved'`,
        [gameId, quarterId, userId],
      );
      await client.query(
        `UPDATE actions SET status = 'Completed', updated_at = NOW() WHERE game_id = $1 AND quarter_id = $2 AND status = 'Approved'`,
        [gameId, quarterId],
      );
      await client.query(
        `UPDATE quarter_settlements SET published_snapshot = $3::jsonb, published_at = NOW(), updated_by_user_id = $4, diplomacy_changes = $5::jsonb, government_changes=$6::jsonb, updated_at = NOW()
         WHERE game_id = $1 AND quarter_id = $2`,
        [
          gameId,
          quarterId,
          JSON.stringify(snapshot),
          userId,
          JSON.stringify(diplomaticPublication.changes),
          JSON.stringify(governmentPublication.changes),
        ],
      );
      await this.state(client, gameId, userId, quarter, 'Published');
      await client.query(
        `UPDATE quarters SET published_at = NOW(), published_world_version = (SELECT current_world_version FROM games WHERE id=$1) WHERE game_id = $1 AND id = $2`,
        [gameId, quarterId],
      );
    });
    return this.get(gameId, userId, quarterId);
  }

  async advance(
    gameId: string,
    userId: string,
    quarterId: string,
  ): Promise<QuarterSummary> {
    await this.transaction(async (client) => {
      await this.host(gameId, userId, client);
      const quarter = await this.quarter(client, gameId, quarterId, true);
      const settlement = await this.draft(client, gameId, quarterId);
      if (
        !quarter.is_current &&
        quarter.state === 'Completed' &&
        settlement?.published_at
      )
        return;
      this.current(quarter);
      if (quarter.state !== 'Published' || !settlement?.published_at)
        throw new ApiFault(
          409,
          'SETTLEMENT_NOT_PUBLISHED',
          '请先发布本回合结果。',
        );
      const games = await client.query<{
        config: Record<string, unknown>;
        current_world_version: string;
      }>(
        'SELECT config, current_world_version FROM games WHERE id = $1 FOR UPDATE',
        [gameId],
      );
      const game = games.rows[0]!;
      const calendar = nextCalendar(quarter.game_year, quarter.season);
      const rules = readGameRules(quarterId, game.config, quarter.action_rules);
      await this.state(client, gameId, userId, quarter, 'Completed');
      await client.query(
        'UPDATE quarters SET is_current = FALSE WHERE game_id = $1 AND id = $2',
        [gameId, quarterId],
      );
      await client.query(
        `INSERT INTO action_status_history (id, game_id, action_id, from_status, to_status, actor_user_id, reason)
         SELECT gen_random_uuid(), game_id, id, 'Draft', 'Invalidated', $3, '回合结束，未提交草稿归档'
         FROM actions WHERE game_id = $1 AND quarter_id = $2 AND status = 'Draft'`,
        [gameId, quarterId, userId],
      );
      await client.query(
        `UPDATE actions SET status = 'Invalidated', updated_at = NOW() WHERE game_id = $1 AND quarter_id = $2 AND status = 'Draft'`,
        [gameId, quarterId],
      );
      await client.query(
        `INSERT INTO quarters (id, game_id, game_year, season, sequence_number, state, is_current, base_world_version, action_rules)
         VALUES ($1,$2,$3,$4,$5,'Preparing',TRUE,$6,$7::jsonb)`,
        [
          randomUUID(),
          gameId,
          calendar.gameYear,
          calendar.season,
          quarter.sequence_number + 1,
          Number(game.current_world_version),
          JSON.stringify({ ...rules.quarter, briefing: '' }),
        ],
      );
      await client.query(
        'UPDATE games SET current_year = $2, current_season = $3 WHERE id = $1',
        [gameId, calendar.gameYear, calendar.season],
      );
    });
    const current = await this.database.query<QuarterRow>(
      `SELECT q.*, g.current_world_version FROM quarters q JOIN games g ON g.id = q.game_id WHERE q.game_id = $1 AND q.is_current`,
      [gameId],
    );
    return quarterSummary(current.rows[0]!);
  }
}
