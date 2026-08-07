import { randomUUID } from 'node:crypto';

import type {
  MapArmyMarker,
  MapCityMarker,
  MapMetadata,
  MapSearchResult,
  MapTileSummary,
  MapViewportData,
  TileDetails,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';

interface TileRow {
  id: string;
  q: number;
  r: number;
  terrain_key: string;
  terrain_name: string;
  terrain_color: string;
  region_id: string | null;
  region_name: string | null;
  controller_country_id: string | null;
  controller_country_name: string | null;
  controller_color: string | null;
  passable: boolean;
  movement_cost: string;
}

interface CityRow extends MapCityMarker {
  tile_id: string;
}

interface ArmyRow extends Omit<MapArmyMarker, 'countryId'> {
  tile_id: string;
  country_id: string;
}

export class WorldService {
  constructor(private readonly database: DatabasePool) {}

  private async requireMember(
    gameId: string,
    userId: string,
  ): Promise<'Host' | 'Player' | 'Observer' | 'Administrator'> {
    const result = await this.database.query<{
      role: 'Host' | 'Player' | 'Observer' | 'Administrator';
    }>(
      `SELECT role FROM game_members
       WHERE game_id = $1 AND user_id = $2 AND status = 'Active'`,
      [gameId, userId],
    );
    const member = result.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return member.role;
  }

  private async requireHost(gameId: string, userId: string): Promise<void> {
    const role = await this.requireMember(gameId, userId);
    if (role !== 'Host' && role !== 'Administrator') {
      throw new ApiFault(
        403,
        'HOST_PERMISSION_REQUIRED',
        '该操作需要主持人权限。',
      );
    }
  }

  async initializeDevelopmentMap(
    gameId: string,
    userId: string,
  ): Promise<MapMetadata> {
    await this.requireHost(gameId, userId);
    const existing = await this.database.query(
      'SELECT id FROM world_maps WHERE game_id = $1',
      [gameId],
    );
    if (existing.rows[0]) return this.getMap(gameId, userId);

    const client = await this.database.connect();
    const mapId = randomUUID();
    const provinceId = randomUUID();
    const regionId = randomUUID();
    const terrain = {
      plains: randomUUID(),
      hills: randomUUID(),
      forest: randomUUID(),
      water: randomUUID(),
    };
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO world_maps (id, game_id, name, width, height)
         VALUES ($1, $2, 'Sri Lanka Test Map', 12, 8)`,
        [mapId, gameId],
      );
      for (const [key, name, color, cost, passable] of [
        ['plains', '平原', '#b9c98f', 1, true],
        ['hills', '丘陵', '#a68b5b', 2, true],
        ['forest', '森林', '#5f8a62', 2, true],
        ['water', '水域', '#5a8fb8', 3, false],
      ] as const) {
        await client.query(
          `INSERT INTO terrain_types (id, game_id, key, name, color, movement_cost, passable)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [terrain[key], gameId, key, name, color, cost, passable],
        );
      }
      const countries = await client.query<{ id: string }>(
        'SELECT id FROM countries WHERE game_id = $1 ORDER BY created_at, id',
        [gameId],
      );
      const palette = ['#c65d4b', '#4f7cac', '#d5a848', '#705d9e', '#4f8f67'];
      for (const [index, country] of countries.rows.entries()) {
        await client.query(
          'UPDATE countries SET map_color = $1 WHERE id = $2',
          [palette[index % palette.length], country.id],
        );
      }
      const primaryCountry = countries.rows[0]?.id ?? null;
      await client.query(
        `INSERT INTO provinces (id, game_id, map_id, name, controller_country_id)
         VALUES ($1, $2, $3, 'Central Province', $4)`,
        [provinceId, gameId, mapId, primaryCountry],
      );
      await client.query(
        `INSERT INTO regions (id, game_id, map_id, province_id, name, population,
                              legal_owner_country_id, controller_country_id)
         VALUES ($1, $2, $3, $4, 'Central Region', 120000, $5, $5)`,
        [regionId, gameId, mapId, provinceId, primaryCountry],
      );
      const tileIds = new Map<string, string>();
      for (let r = 0; r < 8; r += 1) {
        for (let q = 0; q < 12; q += 1) {
          const edge = q === 0 || r === 0 || q === 11 || r === 7;
          const terrainKey = edge
            ? 'water'
            : (q + r) % 5 === 0
              ? 'forest'
              : (q * 2 + r) % 7 === 0
                ? 'hills'
                : 'plains';
          const tileId = randomUUID();
          tileIds.set(`${q},${r}`, tileId);
          await client.query(
            `INSERT INTO hex_tiles (id, game_id, map_id, q, r, terrain_type_id,
                                    region_id, legal_owner_country_id, controller_country_id,
                                    passable, movement_cost)
             SELECT $1, $2, $3, $4, $5, tt.id, $7, $8, $8, tt.passable, tt.movement_cost
             FROM terrain_types tt WHERE tt.id = $6`,
            [
              tileId,
              gameId,
              mapId,
              q,
              r,
              terrain[terrainKey],
              regionId,
              primaryCountry,
            ],
          );
        }
      }
      const capitalTile = tileIds.get('5,3')!;
      await client.query(
        `INSERT INTO cities (id, game_id, tile_id, region_id, name, controller_country_id, importance)
         VALUES ($1, $2, $3, $4, 'Kandy', $5, 5)`,
        [randomUUID(), gameId, capitalTile, regionId, primaryCountry],
      );
      if (primaryCountry) {
        await client.query(
          `INSERT INTO armies (id, game_id, country_id, tile_id, name, strength)
           VALUES ($1, $2, $3, $4, 'Central Guard', 1200)`,
          [randomUUID(), gameId, primaryCountry, capitalTile],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getMap(gameId, userId);
  }

  async getMap(gameId: string, userId: string): Promise<MapMetadata> {
    await this.requireMember(gameId, userId);
    const result = await this.database.query<{
      id: string;
      name: string;
      width: number;
      height: number;
      orientation: 'Pointy' | 'Flat';
      min_zoom: string;
      max_zoom: string;
      current_world_version: string;
    }>(
      `SELECT m.id, m.name, m.width, m.height, m.orientation, m.min_zoom,
              m.max_zoom, g.current_world_version
       FROM world_maps m JOIN games g ON g.id = m.game_id WHERE m.game_id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    if (!row)
      throw new ApiFault(404, 'MAP_NOT_FOUND', '该游戏尚未初始化地图。');
    return {
      id: row.id,
      name: row.name,
      width: row.width,
      height: row.height,
      orientation: row.orientation,
      minZoom: Number(row.min_zoom),
      maxZoom: Number(row.max_zoom),
      currentWorldVersion: Number(row.current_world_version),
      availableLayers: ['terrain', 'control', 'city', 'army'],
    };
  }

  async getViewport(input: {
    gameId: string;
    userId: string;
    minQ: number;
    maxQ: number;
    minR: number;
    maxR: number;
  }): Promise<MapViewportData> {
    await this.requireMember(input.gameId, input.userId);
    if ((input.maxQ - input.minQ + 1) * (input.maxR - input.minR + 1) > 2500) {
      throw new ApiFault(
        400,
        'VIEWPORT_TOO_LARGE',
        '地图视口最多包含 2500 个坐标。',
      );
    }
    const map = await this.getMap(input.gameId, input.userId);
    const [tilesResult, citiesResult, armiesResult] = await Promise.all([
      this.database.query<TileRow>(
        `SELECT t.id, t.q, t.r, tt.key AS terrain_key, tt.name AS terrain_name,
                tt.color AS terrain_color, t.region_id, r.name AS region_name,
                t.controller_country_id, c.name AS controller_country_name,
                c.map_color AS controller_color, t.passable, t.movement_cost
         FROM hex_tiles t
         JOIN terrain_types tt ON tt.id = t.terrain_type_id
         LEFT JOIN regions r ON r.id = t.region_id
         LEFT JOIN countries c ON c.id = t.controller_country_id
         WHERE t.game_id = $1 AND t.q BETWEEN $2 AND $3 AND t.r BETWEEN $4 AND $5
         ORDER BY t.r, t.q`,
        [input.gameId, input.minQ, input.maxQ, input.minR, input.maxR],
      ),
      this.database.query<CityRow>(
        `SELECT ci.id, ci.tile_id, ci.name, ci.importance, ci.status
         FROM cities ci JOIN hex_tiles t ON t.id = ci.tile_id
         WHERE ci.game_id = $1 AND t.q BETWEEN $2 AND $3 AND t.r BETWEEN $4 AND $5`,
        [input.gameId, input.minQ, input.maxQ, input.minR, input.maxR],
      ),
      this.database.query<ArmyRow>(
        `SELECT a.id, a.tile_id, a.name, a.strength, a.status, a.country_id
         FROM armies a JOIN hex_tiles t ON t.id = a.tile_id
         WHERE a.game_id = $1 AND t.q BETWEEN $2 AND $3 AND t.r BETWEEN $4 AND $5`,
        [input.gameId, input.minQ, input.maxQ, input.minR, input.maxR],
      ),
    ]);
    const cities = new Map<string, MapCityMarker[]>();
    for (const row of citiesResult.rows) {
      const list = cities.get(row.tile_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        importance: row.importance,
        status: row.status,
      });
      cities.set(row.tile_id, list);
    }
    const armies = new Map<string, MapArmyMarker[]>();
    for (const row of armiesResult.rows) {
      const list = armies.get(row.tile_id) ?? [];
      list.push({
        id: row.id,
        name: row.name,
        strength: row.strength,
        status: row.status,
        countryId: row.country_id,
      });
      armies.set(row.tile_id, list);
    }
    const tiles: MapTileSummary[] = tilesResult.rows.map((row) => ({
      id: row.id,
      q: row.q,
      r: row.r,
      terrainKey: row.terrain_key,
      terrainName: row.terrain_name,
      terrainColor: row.terrain_color,
      regionId: row.region_id,
      regionName: row.region_name,
      controllerCountryId: row.controller_country_id,
      controllerCountryName: row.controller_country_name,
      controllerColor: row.controller_color,
      passable: row.passable,
      movementCost: Number(row.movement_cost),
      cities: cities.get(row.id) ?? [],
      armies: armies.get(row.id) ?? [],
    }));
    return {
      mapId: map.id,
      worldVersion: map.currentWorldVersion,
      bounds: {
        minQ: input.minQ,
        maxQ: input.maxQ,
        minR: input.minR,
        maxR: input.maxR,
      },
      tiles,
    };
  }

  async getTile(
    gameId: string,
    userId: string,
    tileId: string,
  ): Promise<TileDetails> {
    const role = await this.requireMember(gameId, userId);
    const location = await this.database.query<{ q: number; r: number }>(
      'SELECT q, r FROM hex_tiles WHERE game_id = $1 AND id = $2',
      [gameId, tileId],
    );
    const point = location.rows[0];
    if (!point) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该地块。');
    const viewport = await this.getViewport({
      gameId,
      userId,
      minQ: point.q,
      maxQ: point.q,
      minR: point.r,
      maxR: point.r,
    });
    const tile = viewport.tiles[0];
    if (!tile) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该地块。');
    const extra = await this.database.query<{
      province_name: string | null;
      legal_owner_name: string | null;
      occupier_name: string | null;
      elevation: number;
      road_level: number;
      notes: string;
    }>(
      `SELECT p.name AS province_name, legal.name AS legal_owner_name,
              occupier.name AS occupier_name, t.elevation, t.road_level, t.notes
       FROM hex_tiles t LEFT JOIN regions r ON r.id = t.region_id
       LEFT JOIN provinces p ON p.id = r.province_id
       LEFT JOIN countries legal ON legal.id = t.legal_owner_country_id
       LEFT JOIN countries occupier ON occupier.id = t.occupier_country_id
       WHERE t.game_id = $1 AND t.id = $2`,
      [gameId, tileId],
    );
    const row = extra.rows[0]!;
    return {
      ...tile,
      provinceName: row.province_name,
      legalOwnerCountryName: row.legal_owner_name,
      occupierCountryName: row.occupier_name,
      elevation: row.elevation,
      roadLevel: row.road_level,
      ...(role === 'Host' || role === 'Administrator'
        ? { notes: row.notes }
        : {}),
    };
  }

  async getNeighbors(
    gameId: string,
    userId: string,
    tileId: string,
  ): Promise<MapTileSummary[]> {
    const tile = await this.getTile(gameId, userId, tileId);
    const coordinates = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    const result = await this.getViewport({
      gameId,
      userId,
      minQ: tile.q - 1,
      maxQ: tile.q + 1,
      minR: tile.r - 1,
      maxR: tile.r + 1,
    });
    return result.tiles.filter((candidate) =>
      coordinates.some(
        ([dq, dr]) =>
          candidate.q === tile.q + dq! && candidate.r === tile.r + dr!,
      ),
    );
  }

  async search(
    gameId: string,
    userId: string,
    query: string,
  ): Promise<MapSearchResult[]> {
    await this.requireMember(gameId, userId);
    const result = await this.database.query<MapSearchResult>(
      `SELECT * FROM (
         SELECT ci.id, 'City'::text AS type, ci.name, ci.tile_id AS "tileId", t.q, t.r FROM cities ci JOIN hex_tiles t ON t.id = ci.tile_id WHERE ci.game_id = $1
         UNION ALL SELECT a.id, 'Army', a.name, a.tile_id, t.q, t.r FROM armies a JOIN hex_tiles t ON t.id = a.tile_id WHERE a.game_id = $1
         UNION ALL SELECT r.id, 'Region', r.name, NULL::uuid, NULL::integer, NULL::integer FROM regions r WHERE r.game_id = $1
       ) objects WHERE LOWER(name) LIKE LOWER($2) ORDER BY name LIMIT 20`,
      [gameId, `%${query}%`],
    );
    return result.rows;
  }

  async updateTile(input: {
    gameId: string;
    userId: string;
    tileId: string;
    terrainTypeId?: string;
    controllerCountryId?: string | null;
    notes?: string;
  }): Promise<TileDetails> {
    await this.requireHost(input.gameId, input.userId);
    const result = await this.database.query(
      `UPDATE hex_tiles t SET
         terrain_type_id = COALESCE($3, terrain_type_id),
         controller_country_id = CASE WHEN $4::boolean THEN $5::uuid ELSE controller_country_id END,
         notes = COALESCE($6, notes), updated_at = NOW()
       WHERE t.game_id = $1 AND t.id = $2
         AND ($3::uuid IS NULL OR EXISTS (SELECT 1 FROM terrain_types tt WHERE tt.game_id = $1 AND tt.id = $3))
         AND (NOT $4::boolean OR $5::uuid IS NULL OR EXISTS (SELECT 1 FROM countries c WHERE c.game_id = $1 AND c.id = $5))`,
      [
        input.gameId,
        input.tileId,
        input.terrainTypeId ?? null,
        input.controllerCountryId !== undefined,
        input.controllerCountryId ?? null,
        input.notes ?? null,
      ],
    );
    if (result.rowCount !== 1)
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到地块或引用对象。');
    return this.getTile(input.gameId, input.userId, input.tileId);
  }

  async createCity(input: {
    gameId: string;
    userId: string;
    tileId: string;
    name: string;
    countryId?: string | null;
  }): Promise<TileDetails> {
    await this.requireHost(input.gameId, input.userId);
    const result = await this.database.query(
      `INSERT INTO cities (id, game_id, tile_id, region_id, name, controller_country_id)
       SELECT $1, $2, t.id, t.region_id, $4, $5 FROM hex_tiles t
       WHERE t.game_id = $2 AND t.id = $3
         AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM countries c WHERE c.game_id = $2 AND c.id = $5))`,
      [
        randomUUID(),
        input.gameId,
        input.tileId,
        input.name.trim(),
        input.countryId ?? null,
      ],
    );
    if (result.rowCount !== 1)
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到有效地块或国家。');
    return this.getTile(input.gameId, input.userId, input.tileId);
  }

  async createArmy(input: {
    gameId: string;
    userId: string;
    tileId: string;
    countryId: string;
    name: string;
    strength: number;
  }): Promise<TileDetails> {
    await this.requireHost(input.gameId, input.userId);
    const result = await this.database.query(
      `INSERT INTO armies (id, game_id, country_id, tile_id, name, strength)
       SELECT $1, $2, $4, t.id, $5, $6 FROM hex_tiles t
       WHERE t.game_id = $2 AND t.id = $3 AND t.passable = TRUE
         AND EXISTS (SELECT 1 FROM countries c WHERE c.game_id = $2 AND c.id = $4)`,
      [
        randomUUID(),
        input.gameId,
        input.tileId,
        input.countryId,
        input.name.trim(),
        input.strength,
      ],
    );
    if (result.rowCount !== 1)
      throw new ApiFault(
        404,
        'OBJECT_NOT_FOUND',
        '未找到有效的可通行地块或国家。',
      );
    return this.getTile(input.gameId, input.userId, input.tileId);
  }

  async moveArmy(input: {
    gameId: string;
    userId: string;
    armyId: string;
    tileId: string;
  }): Promise<TileDetails> {
    await this.requireHost(input.gameId, input.userId);
    const result = await this.database.query(
      `UPDATE armies a SET tile_id = $3 WHERE a.game_id = $1 AND a.id = $2
         AND EXISTS (SELECT 1 FROM hex_tiles t WHERE t.game_id = $1 AND t.id = $3 AND t.passable = TRUE)`,
      [input.gameId, input.armyId, input.tileId],
    );
    if (result.rowCount !== 1)
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到军队或有效目标地块。');
    return this.getTile(input.gameId, input.userId, input.tileId);
  }
}
