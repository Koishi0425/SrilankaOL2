import type {
  ProvinceData,
  ProvinceSummary,
  SetProvinceInput,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  lockMap,
  mapTransaction,
  recordMapChange,
  requireMapHost,
} from './map-mutations.js';

type ProfileRow = {
  id: string;
  name: string;
  description: string;
  tax_base: number;
  production_base: number;
  manpower_base: number;
  autonomy: string;
  unrest: string;
  profile_revision: number;
};
type TileRow = {
  id: string;
  province_id: string;
  q: number;
  r: number;
  region_name: string;
  legal_owner_country_id: string | null;
  legal_name: string | null;
  controller_country_id: string | null;
  control_name: string | null;
};
function values(row: ProfileRow) {
  return {
    description: row.description,
    taxBase: row.tax_base,
    productionBase: row.production_base,
    manpowerBase: row.manpower_base,
    autonomy: Number(row.autonomy),
    unrest: Number(row.unrest),
  };
}
function counts(
  tiles: TileRow[],
  kind: 'legal' | 'control',
): ProvinceSummary['legalOwners'] {
  const groups = new Map<
    string | null,
    ProvinceSummary['legalOwners'][number]
  >();
  for (const tile of tiles) {
    const id =
      kind === 'legal'
        ? tile.legal_owner_country_id
        : tile.controller_country_id;
    const old = groups.get(id);
    if (old) old.tileCount++;
    else
      groups.set(id, {
        countryId: id,
        countryName: kind === 'legal' ? tile.legal_name : tile.control_name,
        tileCount: 1,
      });
  }
  return [...groups.values()].sort((a, b) =>
    (a.countryName ?? '').localeCompare(b.countryName ?? ''),
  );
}
export class ProvinceService {
  constructor(private readonly database: DatabasePool) {}
  private async read(
    db: DatabaseClient,
    gameId: string,
    userId: string,
  ): Promise<ProvinceData> {
    const members = await db.query<{
      role: string;
      controlled_country_id: string | null;
    }>(
      "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
      [gameId, userId],
    );
    const member = members.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    const host = ['Host', 'Administrator'].includes(member.role);
    const map = await db.query<{ asset_version: string; state: string }>(
      'SELECT m.asset_version,q.state FROM quarters q LEFT JOIN world_maps m ON m.game_id=q.game_id WHERE q.game_id=$1 AND q.is_current',
      [gameId],
    );
    const base = {
      mapRevision: Number(map.rows[0]?.asset_version ?? 0),
      canEdit:
        host &&
        map.rows[0]?.state === 'Preparing' &&
        !!map.rows[0]?.asset_version,
    };
    if (!host && (member.role !== 'Player' || !member.controlled_country_id))
      return { ...base, provinces: [] };
    const profiles = await db.query<ProfileRow>(
      'SELECT * FROM provinces WHERE game_id=$1 ORDER BY name,id',
      [gameId],
    );
    const rows = await db.query<TileRow>(
      `SELECT t.id,r.province_id,t.q,t.r,r.name AS region_name,
      t.legal_owner_country_id,l.name AS legal_name,t.controller_country_id,c.name AS control_name
      FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id
      LEFT JOIN countries l ON l.game_id=t.game_id AND l.id=t.legal_owner_country_id
      LEFT JOIN countries c ON c.game_id=t.game_id AND c.id=t.controller_country_id
      WHERE t.game_id=$1 AND r.province_id IS NOT NULL ORDER BY t.r,t.q`,
      [gameId],
    );
    const provinces: ProvinceSummary[] = [];
    const grouped = new Map<string, TileRow[]>();
    for (const tile of rows.rows) {
      const group = grouped.get(tile.province_id) ?? [];
      group.push(tile);
      grouped.set(tile.province_id, group);
    }
    for (const row of profiles.rows) {
      const all = grouped.get(row.id) ?? [];
      const scoped = host
        ? all
        : all.filter(
            (t) => t.legal_owner_country_id === member.controlled_country_id,
          );
      if (!host && !scoped.length) continue;
      const partial = scoped.length !== all.length;
      provinces.push({
        id: row.id,
        name: row.name,
        values: partial ? null : values(row),
        ...(host ? { revision: row.profile_revision } : {}),
        partial,
        tileCount: scoped.length,
        legalOwners: counts(scoped, 'legal'),
        controllers: counts(scoped, 'control'),
        tiles: scoped.map((t) => ({
          id: t.id,
          q: t.q,
          r: t.r,
          regionName: t.region_name,
        })),
      });
    }
    return { ...base, provinces };
  }
  async list(gameId: string, userId: string) {
    const db = await this.database.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const data = await this.read(db, gameId, userId);
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
    provinceId: string,
    input: SetProvinceInput,
  ) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const map = await lockMap(db, gameId, input.expectedMapRevision);
      if (map.quarter.state !== 'Preparing')
        throw new ApiFault(
          409,
          'PROVINCE_SETUP_LOCKED',
          '仅在回合准备阶段可以设置省份资料。',
        );
      const rows = await db.query<ProfileRow>(
        'SELECT * FROM provinces WHERE game_id=$1 AND id=$2 FOR UPDATE',
        [gameId, provinceId],
      );
      const before = rows.rows[0];
      if (!before)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该省份。');
      if (before.profile_revision !== input.expectedRevision)
        throw new ApiFault(
          409,
          'PROVINCE_VERSION_CONFLICT',
          '省份资料已变化，请取消编辑、刷新后核对。',
        );
      const decimal = (v: number, min: number, max: number) =>
        Number.isFinite(v) &&
        v >= min &&
        v <= max &&
        Math.abs(v * 100 - Math.round(v * 100)) < 0.0001;
      if (
        !input.name.trim() ||
        input.name.trim().length > 120 ||
        input.description.length > 2000 ||
        !input.reason.trim() ||
        input.reason.trim().length > 2000 ||
        ![input.taxBase, input.productionBase, input.manpowerBase].every(
          (v) => Number.isInteger(v) && v >= 0 && v <= 1000000,
        ) ||
        !decimal(input.autonomy, 0, 100) ||
        !decimal(input.unrest, -100, 100)
      )
        throw new ApiFault(
          400,
          'INVALID_PROVINCE',
          '请填写有效的省份名称、基础值、自治、不满和修改原因。',
        );
      if (
        (
          await db.query(
            'SELECT id FROM provinces WHERE game_id=$1 AND name=$2 AND id<>$3',
            [gameId, input.name.trim(), provinceId],
          )
        ).rowCount
      )
        throw new ApiFault(
          409,
          'PROVINCE_NAME_CONFLICT',
          '该游戏已有同名省份。',
        );
      const after = {
        description: input.description.trim(),
        taxBase: input.taxBase,
        productionBase: input.productionBase,
        manpowerBase: input.manpowerBase,
        autonomy: input.autonomy,
        unrest: input.unrest,
      };
      if (
        before.name === input.name.trim() &&
        JSON.stringify(values(before)) === JSON.stringify(after)
      )
        throw new ApiFault(400, 'INVALID_PROVINCE', '省份资料未变化。');
      await db.query(
        `UPDATE provinces SET name=$3,description=$4,tax_base=$5,production_base=$6,manpower_base=$7,
        autonomy=$8,unrest=$9,profile_revision=profile_revision+1 WHERE game_id=$1 AND id=$2`,
        [
          gameId,
          provinceId,
          input.name.trim(),
          after.description,
          after.taxBase,
          after.productionBase,
          after.manpowerBase,
          after.autonomy,
          after.unrest,
        ],
      );
      const tiles =
        before.name === input.name.trim()
          ? []
          : (
              await db.query<{ id: string }>(
                'SELECT t.id FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id WHERE t.game_id=$1 AND r.province_id=$2',
                [gameId, provinceId],
              )
            ).rows.map((t) => t.id);
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'EditProvince',
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: tiles,
        note: input.reason.trim(),
        details: {
          provinceId,
          before: { name: before.name, ...values(before) },
          after: { name: input.name.trim(), ...after },
        },
      });
    });
    return this.list(gameId, userId);
  }
}
