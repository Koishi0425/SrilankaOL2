import { randomUUID } from 'node:crypto';

import type {
  CountrySummary,
  GameDetails,
  GamePreparation,
  GameMemberSummary,
  GameRulesData,
  GameRole,
  GameStatus,
  GameSummary,
  QuarterState,
  QuarterSummary,
  Season,
  EndGameInput,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { isGameReadOnly } from '@srilanka/contracts';

import { ApiFault } from '../../errors.js';
import { readGameRules } from './game-rules.js';
import { readPreparation } from './game-preparation.js';
import { EconomicService } from './economic-service.js';
import { TradeService } from '../trade/trade-service.js';
import { DiplomacyService } from '../diplomacy/diplomacy-service.js';
import { GovernmentService } from '../government/government-service.js';
import {
  captureEconomicSnapshot,
  type EconomicSnapshot,
} from '../settlements/economy.js';

interface GameRow {
  id: string;
  name: string;
  status: GameStatus;
  role: GameRole;
  allow_new_players: boolean;
  ai_enabled: boolean;
  created_at: Date;
  current_world_version: string;
  quarter_id: string;
  game_year: number;
  season: Season;
  sequence_number: number;
  quarter_state: QuarterState;
  action_deadline: Date | null;
  ended_at: Date | null;
  ending_reason: string | null;
}

interface MemberRow {
  id: string;
  user_id: string;
  username: string;
  display_name: string;
  role: GameRole;
  status: 'Invited' | 'Active' | 'Left' | 'Suspended';
  controlled_country_id: string | null;
  controlled_country_name: string | null;
}

function toQuarter(row: GameRow): QuarterSummary {
  return {
    id: row.quarter_id,
    gameYear: row.game_year,
    season: row.season,
    sequenceNumber: row.sequence_number,
    state: row.quarter_state,
    actionDeadline: row.action_deadline?.toISOString() ?? null,
    currentWorldVersion: Number(row.current_world_version),
  };
}

function toSummary(row: GameRow): GameSummary {
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    role: row.role,
    currentQuarter: toQuarter(row),
    endedAt: row.ended_at?.toISOString() ?? null,
    endingReason: row.ending_reason,
  };
}

function toDetails(row: GameRow): GameDetails {
  return {
    ...toSummary(row),
    allowNewPlayers: row.allow_new_players,
    aiEnabled: row.ai_enabled,
    createdAt: row.created_at.toISOString(),
  };
}

const gameSelect = `
  SELECT g.id, g.name, g.status, gm.role, g.allow_new_players,
         g.ai_enabled, g.created_at, g.current_world_version, g.ended_at, g.ending_reason,
         q.id AS quarter_id, q.game_year, q.season,
         q.sequence_number, q.state AS quarter_state, q.action_deadline
  FROM game_members gm
  JOIN games g ON g.id = gm.game_id
  JOIN quarters q ON q.game_id = g.id AND q.is_current = TRUE
`;

export class GameService {
  readonly economics: EconomicService;
  readonly trade: TradeService;
  readonly diplomacy: DiplomacyService;
  readonly government: GovernmentService;
  constructor(private readonly database: DatabasePool) {
    this.economics = new EconomicService(database);
    this.trade = new TradeService(database);
    this.diplomacy = new DiplomacyService(database);
    this.government = new GovernmentService(database);
  }

  async listForUser(userId: string): Promise<GameSummary[]> {
    const result = await this.database.query<GameRow>(
      `${gameSelect}
       WHERE gm.user_id = $1 AND gm.status = 'Active'
       ORDER BY (g.status IN ('Completed', 'Archived')), g.created_at DESC, g.id`,
      [userId],
    );
    return result.rows.map(toSummary);
  }

  async canCreateGame(): Promise<boolean> {
    const result = await this.database.query<{ available: boolean }>(
      "SELECT NOT EXISTS (SELECT 1 FROM games WHERE status IN ('Preparing','Running','Paused','Correcting')) AS available",
    );
    return result.rows[0]!.available;
  }

  async create(input: {
    userId: string;
    name: string;
    countryNames: string[];
    creationId?: string;
  }): Promise<GameDetails> {
    const client = await this.database.connect();
    const gameId = randomUUID();
    const memberId = randomUUID();
    const quarterId = randomUUID();

    try {
      await client.query('BEGIN');
      // 与数据库唯一索引共同防止两个并发请求同时建立活动游戏。
      await client.query('SELECT pg_advisory_xact_lock($1)', [1_936_445_701]);
      const countryNames = [
        ...new Set(
          input.countryNames.map((name) => name.trim()).filter(Boolean),
        ),
      ];
      if (input.creationId) {
        const replay = await client.query<{
          id: string;
          name: string;
          config: { creationCountries: string[] };
        }>(
          `SELECT id,name,config FROM games WHERE host_user_id=$1 AND config->>'creationId'=$2`,
          [input.userId, input.creationId],
        );
        if (replay.rows[0]) {
          const previous = replay.rows[0];
          if (
            previous.name !== input.name.trim() ||
            JSON.stringify(previous.config.creationCountries) !==
              JSON.stringify(countryNames)
          )
            throw new ApiFault(
              409,
              'CREATION_REQUEST_CONFLICT',
              '这次新建请求的内容已变化，请重新提交。',
            );
          await client.query('COMMIT');
          return await this.getForUser(previous.id, input.userId);
        }
      }
      const activeGame = await client.query<{ id: string }>(
        `SELECT id FROM games
         WHERE status IN ('Preparing', 'Running', 'Paused', 'Correcting')
         LIMIT 1`,
      );
      if (activeGame.rows[0]) {
        throw new ApiFault(
          409,
          'ACTIVE_GAME_ALREADY_EXISTS',
          '当前已有一场正在推进的游戏。',
        );
      }
      await client.query(
        `INSERT INTO games (id, name, host_user_id, config)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          gameId,
          input.name.trim(),
          input.userId,
          JSON.stringify(
            input.creationId
              ? {
                  creationId: input.creationId,
                  creationCountries: countryNames,
                }
              : {},
          ),
        ],
      );
      await client.query(
        `INSERT INTO game_members (id, game_id, user_id, role)
         VALUES ($1, $2, $3, 'Host')`,
        [memberId, gameId, input.userId],
      );
      await client.query(
        `INSERT INTO quarters (
           id, game_id, game_year, season, sequence_number,
           state, is_current, base_world_version
         ) VALUES ($1, $2, 1, 'Spring', 1, 'Preparing', TRUE, 0)`,
        [quarterId, gameId],
      );

      for (const name of countryNames) {
        await client.query(
          'INSERT INTO countries (id, game_id, name) VALUES ($1, $2, $3)',
          [randomUUID(), gameId, name],
        );
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }

    return this.getForUser(gameId, input.userId);
  }

  async getForUser(gameId: string, userId: string): Promise<GameDetails> {
    const result = await this.database.query<GameRow>(
      `${gameSelect}
       WHERE g.id = $1 AND gm.user_id = $2 AND gm.status = 'Active'`,
      [gameId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return toDetails(row);
  }

  async end(
    gameId: string,
    userId: string,
    input: EndGameInput,
  ): Promise<GameDetails> {
    await this.requireHost(gameId, userId);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_xact_lock(1936445702, hashtext($1)) AS locked',
        [gameId],
      );
      if (!lock.rows[0]!.locked)
        throw new ApiFault(
          409,
          'GAME_BUSY',
          '本局正在保存或结算，请稍后重试。',
        );
      const member = await client.query<{ role: GameRole }>(
        "SELECT role FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
        [gameId, userId],
      );
      if (
        !member.rows[0] ||
        !['Host', 'Administrator'].includes(member.rows[0].role)
      )
        throw new ApiFault(
          403,
          'HOST_PERMISSION_REQUIRED',
          '该操作需要主持人权限。',
        );
      // Ending never locks a quarter/map after acquiring the lifecycle lock.
      // NOWAIT avoids waiting on an earlier operation that has not written yet.
      const result = await client.query<{
        status: GameStatus;
        quarter_id: string;
        state: QuarterState;
      }>(
        `SELECT g.status, q.id AS quarter_id, q.state FROM games g
         JOIN quarters q ON q.game_id=g.id AND q.is_current
         WHERE g.id=$1 FOR UPDATE OF g NOWAIT`,
        [gameId],
      );
      const game = result.rows[0];
      if (!game) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
      if (!isGameReadOnly(game.status)) {
        if (
          game.quarter_id !== input.expectedQuarterId ||
          game.state !== input.expectedQuarterState
        )
          throw new ApiFault(
            409,
            'QUARTER_CHANGED',
            '回合阶段已变化，请刷新后重新确认结束。',
          );
        if (!input.reason.trim())
          throw new ApiFault(400, 'ENDING_REASON_REQUIRED', '请填写结束说明。');
        await client.query(
          `UPDATE games SET status='Archived', ended_at=NOW(), archived_at=NOW(), ended_by_user_id=$2, ending_reason=$3, allow_new_players=FALSE WHERE id=$1`,
          [gameId, userId, input.reason.trim()],
        );
        await client.query(
          `INSERT INTO game_lifecycle_history (id, game_id, quarter_id, actor_user_id, previous_status, next_status, reason) VALUES ($1,$2,$3,$4,$5,'Archived',$6)`,
          [
            randomUUID(),
            gameId,
            game.quarter_id,
            userId,
            game.status,
            input.reason.trim(),
          ],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      if ((error as { code?: string }).code === '55P03')
        throw new ApiFault(
          409,
          'GAME_BUSY',
          '本局正在保存或结算，请稍后重试。',
        );
      throw error;
    } finally {
      client.release();
    }
    return this.getForUser(gameId, userId);
  }

  async getCurrentQuarter(
    gameId: string,
    userId: string,
  ): Promise<QuarterSummary> {
    return (await this.getForUser(gameId, userId)).currentQuarter;
  }

  async getRules(gameId: string, userId: string): Promise<GameRulesData> {
    await this.getForUser(gameId, userId);
    const result = await this.database.query<{
      config: Record<string, unknown>;
      quarter_id: string;
      action_rules: unknown;
    }>(
      `SELECT g.config, q.id AS quarter_id, q.action_rules
       FROM games g JOIN quarters q ON q.game_id = g.id AND q.is_current = TRUE
       WHERE g.id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到当前回合。');
    return readGameRules(row.quarter_id, row.config, row.action_rules);
  }

  async updateRules(input: {
    gameId: string;
    userId: string;
    quarterId: string;
    expectedVersion: number;
    scenario: GameRulesData['scenario'];
    quarter: GameRulesData['quarter'];
  }): Promise<GameRulesData> {
    await this.requireHost(input.gameId, input.userId);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      // 与回合状态切换保持相同的锁顺序：先回合，再游戏。
      const quarters = await client.query<{
        id: string;
        action_rules: unknown;
      }>(
        `SELECT id, action_rules FROM quarters
         WHERE game_id = $1 AND is_current = TRUE FOR UPDATE`,
        [input.gameId],
      );
      const quarter = quarters.rows[0];
      if (!quarter || quarter.id !== input.quarterId) {
        throw new ApiFault(
          409,
          'QUARTER_CHANGED',
          '当前回合已变化，请重新读取规则。',
        );
      }
      const games = await client.query<{ config: Record<string, unknown> }>(
        'SELECT config FROM games WHERE id = $1 FOR UPDATE',
        [input.gameId],
      );
      const previous = readGameRules(
        quarter.id,
        games.rows[0]!.config,
        quarter.action_rules,
      );
      if (previous.version !== input.expectedVersion) {
        throw new ApiFault(
          409,
          'RULES_VERSION_CONFLICT',
          '规则已被其他窗口修改，请重新读取后再保存。',
        );
      }
      const next: GameRulesData = {
        quarterId: quarter.id,
        version: previous.version + 1,
        scenario: input.scenario,
        quarter: input.quarter,
      };
      await client.query(
        `UPDATE games SET config = config || jsonb_build_object(
           'scenario', $2::jsonb, 'rulesVersion', $3::integer
         ) WHERE id = $1`,
        [input.gameId, JSON.stringify(next.scenario), next.version],
      );
      await client.query(
        'UPDATE quarters SET action_rules = $3::jsonb WHERE game_id = $1 AND id = $2',
        [input.gameId, quarter.id, JSON.stringify(next.quarter)],
      );
      await client.query(
        `INSERT INTO game_rule_history (
           id, game_id, quarter_id, actor_user_id, previous_rules, next_rules
         ) VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb)`,
        [
          randomUUID(),
          input.gameId,
          quarter.id,
          input.userId,
          JSON.stringify(previous),
          JSON.stringify(next),
        ],
      );
      await client.query('COMMIT');
      return next;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async transitionCurrentQuarter(input: {
    gameId: string;
    userId: string;
    state: 'ActionSubmission' | 'Locked' | 'HostReview';
    actionDeadline?: string | null;
    preparation?: { quarterId: string; expectedRevision: string };
  }): Promise<QuarterSummary> {
    await this.requireHost(input.gameId, input.userId);
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const current = await client.query<{
        id: string;
        state: QuarterState;
        economic_snapshot: EconomicSnapshot | null;
      }>(
        `SELECT id, state,economic_snapshot FROM quarters
         WHERE game_id = $1 AND is_current = TRUE FOR UPDATE`,
        [input.gameId],
      );
      const quarter = current.rows[0];
      if (!quarter)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到当前季度。');
      if (input.preparation) {
        if (quarter.id !== input.preparation.quarterId)
          throw new ApiFault(
            409,
            'QUARTER_CHANGED',
            '当前回合已变化，请重新读取准备内容。',
          );
        if (!['Preparing', 'ActionSubmission'].includes(quarter.state))
          throw new ApiFault(
            409,
            'INVALID_QUARTER_TRANSITION',
            '第一回合已经开放，请从行动审核管理后续阶段。',
          );
        // Hold quarter → map → game while checking reviewed settings and freezing the snapshot.
        await client.query(
          'SELECT id FROM world_maps WHERE game_id=$1 FOR UPDATE',
          [input.gameId],
        );
        await client.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [
          input.gameId,
        ]);
        const row = (
          await client.query<GameRow>(
            `${gameSelect} WHERE g.id=$1 AND gm.user_id=$2 AND gm.status='Active'`,
            [input.gameId, input.userId],
          )
        ).rows[0]!;
        const preparation = await readPreparation(
          client,
          input.gameId,
          toQuarter(row),
        );
        if (preparation.quarter.sequenceNumber !== 1)
          throw new ApiFault(
            409,
            'INVALID_QUARTER_TRANSITION',
            '开局入口只用于第一回合。',
          );
        if (quarter.state === 'ActionSubmission') {
          await client.query('COMMIT');
          return await this.getCurrentQuarter(input.gameId, input.userId);
        }
        if (preparation.revision !== input.preparation.expectedRevision)
          throw new ApiFault(
            409,
            'PREPARATION_CHANGED',
            '准备内容已变化，请重新读取并确认。',
          );
        if (!preparation.canOpen)
          throw new ApiFault(
            409,
            'PREPARATION_INCOMPLETE',
            '请先添加玩家并为每位玩家分配国家。',
          );
      }
      const allowed: Record<string, string[]> = {
        Preparing: ['ActionSubmission'],
        EventResponse: ['ActionSubmission'],
        ActionSubmission: ['Locked'],
        Locked: ['HostReview', 'ActionSubmission'],
        HostReview: ['ActionSubmission'],
      };
      if (!allowed[quarter.state]?.includes(input.state)) {
        throw new ApiFault(
          409,
          'INVALID_QUARTER_TRANSITION',
          '季度状态不能这样转换。',
        );
      }
      if (
        input.state === 'ActionSubmission' &&
        ['Preparing', 'EventResponse'].includes(quarter.state) &&
        !quarter.economic_snapshot
      )
        await captureEconomicSnapshot(client, input.gameId, quarter.id);
      await client.query(
        `UPDATE quarters SET state = $1,
           action_deadline = CASE WHEN $1 = 'ActionSubmission' THEN $2 ELSE action_deadline END,
           started_at = CASE WHEN $1 = 'ActionSubmission' THEN COALESCE(started_at, NOW()) ELSE started_at END
         WHERE game_id = $3 AND id = $4`,
        [input.state, input.actionDeadline ?? null, input.gameId, quarter.id],
      );
      await client.query(
        `INSERT INTO quarter_state_history (
           id, game_id, quarter_id, from_state, to_state, actor_user_id
         ) VALUES ($1,$2,$3,$4,$5,$6)`,
        [
          randomUUID(),
          input.gameId,
          quarter.id,
          quarter.state,
          input.state,
          input.userId,
        ],
      );
      if (input.state === 'HostReview') {
        await client.query(
          `INSERT INTO action_status_history (
             id, game_id, action_id, from_status, to_status, actor_user_id, reason
           )
           SELECT gen_random_uuid(), game_id, id, status, 'HostReview', $2,
                  '季度进入主持人审核'
           FROM actions
           WHERE game_id = $1 AND quarter_id = $3 AND status = 'Submitted'`,
          [input.gameId, input.userId, quarter.id],
        );
        await client.query(
          `UPDATE actions SET status = 'HostReview', updated_at = NOW()
           WHERE game_id = $1 AND quarter_id = $2 AND status = 'Submitted'`,
          [input.gameId, quarter.id],
        );
      }
      if (input.state === 'ActionSubmission') {
        if (quarter.state === 'HostReview') {
          await client.query(
            `INSERT INTO action_status_history (
               id, game_id, action_id, from_status, to_status, actor_user_id, reason
             )
             SELECT gen_random_uuid(), game_id, id, status, 'Submitted', $2,
                    '主持人重新开放季度行动提交'
             FROM actions
             WHERE game_id = $1 AND quarter_id = $3 AND status = 'HostReview'`,
            [input.gameId, input.userId, quarter.id],
          );
          await client.query(
            `UPDATE actions SET status = 'Submitted', updated_at = NOW()
             WHERE game_id = $1 AND quarter_id = $2 AND status = 'HostReview'`,
            [input.gameId, quarter.id],
          );
        }
        await client.query(
          `UPDATE games SET status = 'Running', started_at = COALESCE(started_at, NOW())
           WHERE id = $1 AND status = 'Preparing'`,
          [input.gameId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getCurrentQuarter(input.gameId, input.userId);
  }

  private async requireHost(gameId: string, userId: string): Promise<void> {
    const result = await this.database.query<{ role: GameRole }>(
      `SELECT role FROM game_members
       WHERE game_id = $1 AND user_id = $2 AND status = 'Active'`,
      [gameId, userId],
    );
    const member = result.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    if (member.role !== 'Host' && member.role !== 'Administrator') {
      throw new ApiFault(
        403,
        'HOST_PERMISSION_REQUIRED',
        '该操作需要主持人权限。',
      );
    }
  }

  async getPreparation(
    gameId: string,
    userId: string,
  ): Promise<GamePreparation> {
    await this.requireHost(gameId, userId);
    const db = await this.database.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const row = (
        await db.query<GameRow>(
          `${gameSelect} WHERE g.id=$1 AND gm.user_id=$2 AND gm.status='Active'`,
          [gameId, userId],
        )
      ).rows[0];
      if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
      const preparation = await readPreparation(db, gameId, toQuarter(row));
      await db.query('COMMIT');
      return preparation;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  async listMembers(
    gameId: string,
    userId: string,
  ): Promise<GameMemberSummary[]> {
    await this.requireHost(gameId, userId);
    const result = await this.database.query<MemberRow>(
      `SELECT gm.id, gm.user_id, u.username, u.display_name, gm.role, gm.status,
              gm.controlled_country_id, c.name AS controlled_country_name
       FROM game_members gm
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN countries c ON c.id = gm.controlled_country_id
       WHERE gm.game_id = $1
       ORDER BY gm.joined_at`,
      [gameId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      username: row.username,
      displayName: row.display_name,
      role: row.role,
      status: row.status,
      controlledCountryId: row.controlled_country_id,
      controlledCountryName: row.controlled_country_name,
    }));
  }

  async addMember(input: {
    gameId: string;
    actorUserId: string;
    username: string;
    role: 'Player' | 'Observer';
  }): Promise<GameMemberSummary> {
    await this.requireHost(input.gameId, input.actorUserId);
    const userResult = await this.database.query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(username) = LOWER($1) AND status = 'Active'`,
      [input.username.trim()],
    );
    const target = userResult.rows[0];
    if (!target)
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该注册用户。');

    await this.updateMembership(input.gameId, async (db) => {
      await db.query(
        `INSERT INTO game_members (id, game_id, user_id, role, status)
       VALUES ($1, $2, $3, $4, 'Active')
       ON CONFLICT (game_id, user_id) DO UPDATE SET
         role = EXCLUDED.role, status = 'Active',
         controlled_country_id = CASE WHEN EXCLUDED.role='Observer' THEN NULL ELSE game_members.controlled_country_id END
       WHERE game_members.role NOT IN ('Host', 'Administrator')`,
        [randomUUID(), input.gameId, target.id, input.role],
      );
    });
    const members = await this.listMembers(input.gameId, input.actorUserId);
    const member = members.find((candidate) => candidate.userId === target.id);
    if (!member) throw new Error('Member was not created');
    return member;
  }

  async listCountries(
    gameId: string,
    userId: string,
  ): Promise<CountrySummary[]> {
    await this.getForUser(gameId, userId);
    const result = await this.database.query<{
      id: string;
      name: string;
      map_color: string;
    }>(
      `SELECT id, name, map_color FROM countries
       WHERE game_id = $1 AND status = 'Active' ORDER BY name`,
      [gameId],
    );
    return result.rows.map((row) => ({
      id: row.id,
      name: row.name,
      mapColor: row.map_color,
    }));
  }

  async assignCountry(input: {
    gameId: string;
    actorUserId: string;
    memberId: string;
    countryId: string | null;
  }): Promise<GameMemberSummary> {
    await this.requireHost(input.gameId, input.actorUserId);
    await this.updateMembership(input.gameId, async (db) => {
      const result = await db.query(
        `UPDATE game_members gm
       SET controlled_country_id = $1
       WHERE gm.id = $2 AND gm.game_id = $3
         AND gm.role='Player' AND gm.status='Active'
         AND ($1::uuid IS NULL OR EXISTS (
           SELECT 1 FROM countries c
           WHERE c.id = $1 AND c.game_id = $3 AND c.status = 'Active'
         ))`,
        [input.countryId, input.memberId, input.gameId],
      );
      if (result.rowCount !== 1) {
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到成员或国家。');
      }
    });
    const members = await this.listMembers(input.gameId, input.actorUserId);
    const member = members.find((candidate) => candidate.id === input.memberId);
    if (!member) throw new Error('Assigned member was not found');
    return member;
  }

  private async updateMembership(
    gameId: string,
    write: (db: DatabaseClient) => Promise<void>,
  ) {
    const db = await this.database.connect();
    try {
      await db.query('BEGIN');
      await db.query(
        'SELECT id FROM quarters WHERE game_id=$1 AND is_current FOR UPDATE',
        [gameId],
      );
      await write(db);
      await db.query('COMMIT');
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
}
