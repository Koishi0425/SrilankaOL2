import { randomUUID } from 'node:crypto';
import type {
  CountryLedgerEntry,
  CountryLedgerPage,
  CountryStatus,
  NationalStatus,
  SetCountryBalancesInput,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  insertResourceLedger,
  validBalance,
  type ResourceRow,
} from '../settlements/resources.js';

export class CountryService {
  constructor(private readonly database: DatabasePool) {}
  private async member(db: DatabaseClient, gameId: string, userId: string) {
    const result = await db.query<{
      role: string;
      controlled_country_id: string | null;
    }>(
      "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
      [gameId, userId],
    );
    const member = result.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return { ...member, host: ['Host', 'Administrator'].includes(member.role) };
  }
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
  async status(gameId: string, userId: string): Promise<NationalStatus> {
    return this.transaction(true, async (db) => {
      const member = await this.member(db, gameId, userId);
      const ids = await db.query<ResourceRow & { map_color: string }>(
        `SELECT id,name,map_color,treasury,manpower,resource_revision FROM countries WHERE game_id=$1
        AND ($2::boolean OR ($3::boolean AND id=$4::uuid)) ORDER BY created_at,id`,
        [
          gameId,
          member.host,
          member.role === 'Player',
          member.controlled_country_id,
        ],
      );
      const countries: CountryStatus[] = [];
      for (const row of ids.rows) {
        const tiles = await db.query<{ controlled: string; legal: string }>(
          'SELECT COUNT(*) FILTER (WHERE controller_country_id=$2) AS controlled,COUNT(*) FILTER (WHERE legal_owner_country_id=$2) AS legal FROM hex_tiles WHERE game_id=$1',
          [gameId, row.id],
        );
        const cities = await db.query<CountryStatus['cities'][number]>(
          'SELECT c.id,c.name,t.q,t.r FROM cities c JOIN hex_tiles t ON t.game_id=c.game_id AND t.id=c.tile_id WHERE c.game_id=$1 AND c.controller_country_id=$2 ORDER BY c.name,c.id',
          [gameId, row.id],
        );
        const armies = await db.query<CountryStatus['armies'][number]>(
          'SELECT a.id,a.name,a.strength,t.q,t.r FROM armies a JOIN hex_tiles t ON t.game_id=a.game_id AND t.id=a.tile_id WHERE a.game_id=$1 AND a.country_id=$2 ORDER BY a.name,a.id',
          [gameId, row.id],
        );
        countries.push({
          id: row.id,
          name: row.name,
          mapColor: row.map_color,
          treasury: Number(row.treasury),
          manpower: row.manpower,
          resourceRevision: row.resource_revision,
          controlledTileCount: Number(tiles.rows[0]!.controlled),
          legalTileCount: Number(tiles.rows[0]!.legal),
          cities: cities.rows,
          armies: armies.rows,
        });
      }
      const quarter = await db.query<{ state: string }>(
        'SELECT state FROM quarters WHERE game_id=$1 AND is_current',
        [gameId],
      );
      return {
        countries,
        canSetBalances: member.host && quarter.rows[0]?.state === 'Preparing',
      };
    });
  }
  async ledger(
    gameId: string,
    userId: string,
    countryId: string,
    before?: string,
  ): Promise<CountryLedgerPage> {
    return this.transaction(true, async (db) => {
      const member = await this.member(db, gameId, userId);
      const country = await db.query(
        'SELECT id FROM countries WHERE game_id=$1 AND id=$2',
        [gameId, countryId],
      );
      if (
        !country.rows[0] ||
        (!member.host &&
          (member.role !== 'Player' ||
            member.controlled_country_id !== countryId))
      )
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该国账目。');
      const rows = await db.query<{
        id: string;
        kind: CountryLedgerEntry['kind'];
        quarter_id: string;
        game_year: number;
        season: CountryLedgerEntry['season'];
        resource: CountryLedgerEntry['resource'];
        amount: string;
        before_balance: string;
        after_balance: string;
        reason: string;
        created_at: Date;
      }>(
        `SELECT l.*,q.game_year,q.season FROM country_resource_ledger l JOIN quarters q ON q.id=l.quarter_id AND q.game_id=l.game_id
        WHERE l.game_id=$1 AND l.country_id=$2 AND ($3::bigint IS NULL OR l.id<$3::bigint) ORDER BY l.id DESC LIMIT 51`,
        [gameId, countryId, before ?? null],
      );
      const entries = rows.rows.slice(0, 50).map((row) => ({
        id: row.id,
        kind: row.kind,
        quarterId: row.quarter_id,
        gameYear: row.game_year,
        season: row.season,
        resource: row.resource,
        amount: Number(row.amount),
        before: Number(row.before_balance),
        after: Number(row.after_balance),
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
      }));
      return {
        entries,
        nextCursor: rows.rows.length > 50 ? entries.at(-1)!.id : null,
      };
    });
  }
  async setBalances(
    gameId: string,
    userId: string,
    countryId: string,
    input: SetCountryBalancesInput,
  ) {
    await this.transaction(false, async (db) => {
      const member = await this.member(db, gameId, userId);
      if (!member.host)
        throw new ApiFault(
          403,
          'HOST_PERMISSION_REQUIRED',
          '该操作需要主持人权限。',
        );
      const quarter = await db.query<{ id: string; state: string }>(
        'SELECT id,state FROM quarters WHERE game_id=$1 AND is_current FOR UPDATE',
        [gameId],
      );
      if (quarter.rows[0]?.state !== 'Preparing')
        throw new ApiFault(
          409,
          'RESOURCE_SETUP_LOCKED',
          '仅在回合准备阶段可设置余额；本回合收支请在结算中填写。',
        );
      await db.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [gameId]);
      const rows = await db.query<ResourceRow>(
        'SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 AND id=$2 FOR UPDATE',
        [gameId, countryId],
      );
      const country = rows.rows[0];
      if (!country)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该国家。');
      if (country.resource_revision !== input.expectedRevision)
        throw new ApiFault(
          409,
          'RESOURCE_VERSION_CONFLICT',
          '国家余额已变化，请刷新后核对。',
        );
      if (
        !validBalance('Treasury', input.treasury) ||
        !validBalance('Manpower', input.manpower) ||
        !input.reason.trim() ||
        input.reason.length > 2000
      )
        throw new ApiFault(
          400,
          'INVALID_RESOURCE_CHANGE',
          '请填写有效余额和设置原因。',
        );
      if (
        Number(country.treasury) === input.treasury &&
        country.manpower === input.manpower
      )
        throw new ApiFault(400, 'INVALID_RESOURCE_CHANGE', '余额未变化。');
      const id = randomUUID();
      for (const [resource, before, after] of [
        ['Treasury', Number(country.treasury), input.treasury],
        ['Manpower', country.manpower, input.manpower],
      ] as const) {
        if (before === after) continue;
        await insertResourceLedger(
          db,
          { gameId, quarterId: quarter.rows[0]!.id, userId, kind: 'Setup' },
          {
            id,
            countryId,
            resource,
            before,
            after,
            amount:
              resource === 'Treasury'
                ? Math.round((after - before) * 100) / 100
                : after - before,
            reason: input.reason.trim(),
          },
        );
      }
      await db.query(
        'UPDATE countries SET treasury=$3,manpower=$4,resource_revision=resource_revision+1 WHERE game_id=$1 AND id=$2',
        [gameId, countryId, input.treasury, input.manpower],
      );
      await db.query(
        'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1',
        [gameId],
      );
    });
    return this.status(gameId, userId);
  }
}
