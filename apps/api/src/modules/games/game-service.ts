import { randomUUID } from 'node:crypto';

import type {
  CountrySummary,
  GameDetails,
  GameMemberSummary,
  GameRole,
  GameStatus,
  GameSummary,
  QuarterState,
  QuarterSummary,
  Season,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';

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
}

interface MemberRow {
  id: string;
  user_id: string;
  email: string;
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
         g.ai_enabled, g.created_at, g.current_world_version,
         q.id AS quarter_id, q.game_year, q.season,
         q.sequence_number, q.state AS quarter_state, q.action_deadline
  FROM game_members gm
  JOIN games g ON g.id = gm.game_id
  JOIN quarters q ON q.game_id = g.id AND q.is_current = TRUE
`;

export class GameService {
  constructor(private readonly database: DatabasePool) {}

  async listForUser(userId: string): Promise<GameSummary[]> {
    const result = await this.database.query<GameRow>(
      `${gameSelect}
       WHERE gm.user_id = $1 AND gm.status = 'Active' AND g.status <> 'Archived'
       ORDER BY g.created_at DESC`,
      [userId],
    );
    return result.rows.map(toSummary);
  }

  async create(input: {
    userId: string;
    name: string;
    countryNames: string[];
  }): Promise<GameDetails> {
    const client = await this.database.connect();
    const gameId = randomUUID();
    const memberId = randomUUID();
    const quarterId = randomUUID();

    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO games (id, name, host_user_id)
         VALUES ($1, $2, $3)`,
        [gameId, input.name.trim(), input.userId],
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

      const countryNames = [
        ...new Set(
          input.countryNames.map((name) => name.trim()).filter(Boolean),
        ),
      ];
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

  async getCurrentQuarter(
    gameId: string,
    userId: string,
  ): Promise<QuarterSummary> {
    return (await this.getForUser(gameId, userId)).currentQuarter;
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

  async listMembers(
    gameId: string,
    userId: string,
  ): Promise<GameMemberSummary[]> {
    await this.requireHost(gameId, userId);
    const result = await this.database.query<MemberRow>(
      `SELECT gm.id, gm.user_id, u.email, u.display_name, gm.role, gm.status,
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
      email: row.email,
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
    email: string;
    role: 'Player' | 'Observer';
  }): Promise<GameMemberSummary> {
    await this.requireHost(input.gameId, input.actorUserId);
    const userResult = await this.database.query<{ id: string }>(
      `SELECT id FROM users WHERE LOWER(email) = LOWER($1) AND status = 'Active'`,
      [input.email.trim()],
    );
    const target = userResult.rows[0];
    if (!target) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该用户。');

    await this.database.query(
      `INSERT INTO game_members (id, game_id, user_id, role, status)
       VALUES ($1, $2, $3, $4, 'Active')
       ON CONFLICT (game_id, user_id) DO UPDATE SET
         role = EXCLUDED.role, status = 'Active'`,
      [randomUUID(), input.gameId, target.id, input.role],
    );
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
    const result = await this.database.query<CountrySummary>(
      `SELECT id, name FROM countries
       WHERE game_id = $1 AND status = 'Active' ORDER BY name`,
      [gameId],
    );
    return result.rows;
  }

  async assignCountry(input: {
    gameId: string;
    actorUserId: string;
    memberId: string;
    countryId: string;
  }): Promise<GameMemberSummary> {
    await this.requireHost(input.gameId, input.actorUserId);
    const result = await this.database.query(
      `UPDATE game_members gm
       SET controlled_country_id = $1
       WHERE gm.id = $2 AND gm.game_id = $3
         AND EXISTS (
           SELECT 1 FROM countries c
           WHERE c.id = $1 AND c.game_id = $3 AND c.status = 'Active'
         )`,
      [input.countryId, input.memberId, input.gameId],
    );
    if (result.rowCount !== 1) {
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到成员或国家。');
    }
    const members = await this.listMembers(input.gameId, input.actorUserId);
    const member = members.find((candidate) => candidate.id === input.memberId);
    if (!member) throw new Error('Assigned member was not found');
    return member;
  }
}
