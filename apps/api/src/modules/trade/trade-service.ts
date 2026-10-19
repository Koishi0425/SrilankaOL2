import { isDeepStrictEqual } from 'node:util';
import type { DatabasePool, DatabaseClient } from '@srilanka/database';
import type {
  TradeData,
  SetTradeZoneInput,
  EconomicBill,
  Season,
} from '@srilanka/contracts';
import { ApiFault } from '../../errors.js';
import {
  lockMap,
  mapTransaction,
  recordMapChange,
  requireMapHost,
} from '../world/map-mutations.js';
import { readTradeZones } from './trade-data.js';
import { calculateTrade } from './trade-calculation.js';
export const validTradePower = (v: number) =>
  Number.isFinite(v) &&
  v >= 0 &&
  v <= 1000000 &&
  Math.abs(v * 100 - Math.round(v * 100)) < 0.0001;
const invalid = (message: string) =>
  new ApiFault(400, 'INVALID_TRADE_ZONE', message);
export class TradeService {
  constructor(private readonly database: DatabasePool) {}
  private async read(
    db: DatabaseClient,
    gameId: string,
    userId: string,
    countryId?: string,
  ): Promise<TradeData> {
    const member = (
      await db.query<{ role: string; controlled_country_id: string | null }>(
        "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
        [gameId, userId],
      )
    ).rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    const host = ['Host', 'Administrator'].includes(member.role);
    const own = member.role === 'Player' ? member.controlled_country_id : null;
    if (!host && countryId && countryId !== own)
      throw new ApiFault(
        403,
        'COUNTRY_PERMISSION_REQUIRED',
        '只能读取本国贸易资料。',
      );
    const selected = host ? countryId : own;
    const row = (
      await db.query<{
        state: string;
        asset_version: string | null;
        economic_rules: { enabled: boolean; tradeCoefficient?: number };
      }>(
        'SELECT q.state,m.asset_version,g.economic_rules FROM games g JOIN quarters q ON q.game_id=g.id AND q.is_current LEFT JOIN world_maps m ON m.game_id=g.id WHERE g.id=$1',
        [gameId],
      )
    ).rows[0]!;
    const data: TradeData = {
      economicEnabled: row.economic_rules.enabled,
      coefficient: row.economic_rules.tradeCoefficient ?? 0,
      canEdit: host && row.state === 'Preparing' && row.asset_version !== null,
      mapRevision: Number(row.asset_version ?? 0),
      zones: [],
      lastIncome: null,
    };
    if (!host && !own) return data;
    const countries = (
      await db.query<{ id: string; name: string }>(
        "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active' ORDER BY name,id",
        [gameId],
      )
    ).rows;
    if (selected && !countries.some((c) => c.id === selected))
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该国家。');
    const zones = await readTradeZones(db, gameId);
    const allocation = host
      ? calculateTrade(zones, data.coefficient, countries)
      : [];
    data.zones = zones.flatMap((z) => {
      const ownInfluence =
        z.influences.find((i) => i.countryId === selected)?.power ?? 0;
      if (!host && !ownInfluence) return [];
      const result = allocation.find((i) => i.zone.id === z.id);
      return [
        {
          id: z.id,
          name: z.name,
          ownInfluence,
          ...(host
            ? {
                setup: {
                  ...z,
                  value: result!.value,
                  allocations: result!.allocations.map(
                    ({ countryId, amount }) => ({ countryId, amount }),
                  ),
                },
              }
            : {}),
        },
      ];
    });
    if (host)
      data.options = {
        countries,
        provinces: (
          await db.query<{ id: string; name: string }>(
            'SELECT id,name FROM provinces WHERE game_id=$1 ORDER BY name,id',
            [gameId],
          )
        ).rows,
      };
    if (selected) {
      const published = (
        await db.query<{
          game_year: number;
          season: Season;
          bill: EconomicBill | null;
        }>(
          `SELECT q.game_year,q.season,s.published_snapshot->'economicBill' AS bill FROM quarter_settlements s JOIN quarters q ON q.game_id=s.game_id AND q.id=s.quarter_id WHERE s.game_id=$1 AND s.published_at IS NOT NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(s.published_snapshot->'economicBill'->'lines','[]'::jsonb)) l WHERE l->>'kind'='Trade' AND l->>'countryId'=$2) ORDER BY q.sequence_number DESC LIMIT 1`,
          [gameId, selected],
        )
      ).rows[0];
      const line = published?.bill?.lines.find(
        (l) => l.countryId === selected && l.kind === 'Trade',
      );
      if (published && line)
        data.lastIncome = {
          gameYear: published.game_year,
          season: published.season,
          calculatedIncome: line.calculatedAmount,
          actualIncome: line.amount,
          adjustmentReason: line.adjustmentReason,
          sources: line.sources.map(({ name, amount }) => ({ name, amount })),
        };
    }
    return data;
  }
  async get(gameId: string, userId: string, countryId?: string) {
    const db = await this.database.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const data = await this.read(db, gameId, userId, countryId);
      await db.query('COMMIT');
      return data;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async set(
    gameId: string,
    userId: string,
    zoneId: string,
    input: SetTradeZoneInput,
  ) {
    return mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const map = await lockMap(db, gameId, input.expectedMapRevision);
      if (map.quarter.state !== 'Preparing')
        throw new ApiFault(
          409,
          'TRADE_SETUP_LOCKED',
          '贸易区只能在回合准备阶段设置。',
        );
      const before = (await readTradeZones(db, gameId)).find(
        (z) => z.id === zoneId,
      );
      if (
        before
          ? before.revision !== input.expectedRevision
          : input.expectedRevision !== null
      )
        throw new ApiFault(
          409,
          'TRADE_VERSION_CONFLICT',
          '贸易区已变化，请取消编辑，刷新后核对。',
        );
      if (
        !input.name.trim() ||
        input.name.trim().length > 120 ||
        !input.reason.trim() ||
        input.reason.length > 2000 ||
        input.provinceIds.length > 1000 ||
        input.influences.length > 100 ||
        new Set(input.provinceIds).size !== input.provinceIds.length ||
        new Set(input.influences.map((i) => i.countryId)).size !==
          input.influences.length ||
        input.influences.some((i) => !validTradePower(i.power))
      )
        throw invalid('请填写有效的贸易区、省份、影响力和修改原因。');
      const countries = (
        await db.query<{ id: string }>(
          "SELECT id FROM countries WHERE game_id=$1 AND status='Active'",
          [gameId],
        )
      ).rows;
      if (
        input.influences.some(
          (i) => !countries.some((c) => c.id === i.countryId),
        )
      )
        throw invalid('影响力包含不属于当前游戏的国家。');
      if (
        (
          await db.query(
            'SELECT id FROM provinces WHERE game_id=$1 AND id=ANY($2::uuid[])',
            [gameId, input.provinceIds],
          )
        ).rowCount !== input.provinceIds.length
      )
        throw invalid('省份不属于当前游戏。');
      if (
        (
          await db.query(
            'SELECT province_id FROM trade_zone_provinces WHERE game_id=$1 AND zone_id<>$2 AND province_id=ANY($3::uuid[])',
            [gameId, zoneId, input.provinceIds],
          )
        ).rowCount
      )
        throw new ApiFault(
          409,
          'TRADE_PROVINCE_CONFLICT',
          '省份已属于其他贸易区，请先从原贸易区移除。',
        );
      if (
        (
          await db.query(
            'SELECT id FROM trade_zones WHERE (id=$2 AND game_id<>$1) OR (game_id=$1 AND name=$3 AND id<>$2)',
            [gameId, zoneId, input.name.trim()],
          )
        ).rowCount
      )
        throw invalid('贸易区标识无效或名称已使用。');
      const normalize = (
        influences: Array<{ countryId: string; power: number }>,
      ) =>
        influences
          .filter((i) => i.power > 0)
          .sort((a, b) => a.countryId.localeCompare(b.countryId));
      const next = {
        name: input.name.trim(),
        provinceIds: [...input.provinceIds].sort(),
        influences: normalize(input.influences),
      };
      if (
        before &&
        isDeepStrictEqual(
          {
            name: before.name,
            provinceIds: before.provinces.map((p) => p.id).sort(),
            influences: normalize(before.influences),
          },
          next,
        )
      )
        throw invalid('贸易区资料未变化。');
      if (!before) {
        if (
          (
            await db.query('SELECT id FROM trade_zones WHERE game_id=$1', [
              gameId,
            ])
          ).rowCount! >= 200
        )
          throw invalid('每场游戏最多 200 个贸易区。');
        await db.query(
          'INSERT INTO trade_zones(id,game_id,name) VALUES($1,$2,$3)',
          [zoneId, gameId, next.name],
        );
      } else
        await db.query(
          'UPDATE trade_zones SET name=$3,revision=revision+1 WHERE game_id=$1 AND id=$2',
          [gameId, zoneId, next.name],
        );
      await db.query(
        'DELETE FROM trade_zone_provinces WHERE game_id=$1 AND zone_id=$2',
        [gameId, zoneId],
      );
      for (const provinceId of next.provinceIds)
        await db.query(
          'INSERT INTO trade_zone_provinces(game_id,zone_id,province_id) VALUES($1,$2,$3)',
          [gameId, zoneId, provinceId],
        );
      await db.query(
        'DELETE FROM trade_influences WHERE game_id=$1 AND zone_id=$2',
        [gameId, zoneId],
      );
      for (const i of next.influences)
        await db.query(
          'INSERT INTO trade_influences(game_id,zone_id,country_id,power) VALUES($1,$2,$3,$4)',
          [gameId, zoneId, i.countryId, i.power],
        );
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'EditTradeZone',
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: [],
        note: input.reason.trim(),
        details: { zoneId, before: before ?? null, after: next },
      });
      return { id: zoneId, revision: before ? before.revision + 1 : 0 };
    });
  }
}
