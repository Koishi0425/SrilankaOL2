import { randomUUID } from 'node:crypto';
import { requireInstantCorrection } from './map-mutations.js';

import type {
  MapArmyMarker,
  MapCityMarker,
  MapMetadata,
  MapObjectLocation,
  MapSearchResult,
  MapTileSummary,
  MapViewportData,
  TileDetails,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { MapSetupService } from './map-setup-service.js';
import { ProvinceService } from './province-service.js';
import { readMapTileContext } from './map-tile-context.js';
import {
  captureTiles,
  lockMap,
  mapTransaction,
  recordMapChange,
  requireMapHost,
} from './map-mutations.js';
import {
  discoveryFor,
  hideUnknownTile,
  knowsAdministration,
  knownAdministrationSql,
  projectArmy,
  type PerceivedArmyRow,
  type ViewContext,
} from './perception-service.js';
import { refreshCountryVision } from './map-vision.js';

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
  legal_owner_country_id: string | null;
  legal_owner_country_name: string | null;
  legal_owner_color: string | null;
  passable: boolean;
  movement_cost: string;
  discovery_state: MapTileSummary['discoveryState'] | null;
  knowledge_confidence: number | null;
  observed_world_version: string | null;
  snapshot: (Partial<TileDetails> & { administrationKnown?: boolean }) | null;
  public_note: string;
  observed_at: Date | null;
}

interface CityRow extends MapCityMarker {
  tile_id: string;
}

export class WorldService {
  readonly setup: MapSetupService;
  readonly provinces: ProvinceService;
  constructor(private readonly database: DatabasePool) {
    this.setup = new MapSetupService(database);
    this.provinces = new ProvinceService(database);
  }

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

  private async resolveView(
    gameId: string,
    userId: string,
    previewMemberId?: string,
    db: DatabasePool | DatabaseClient = this.database,
  ): Promise<ViewContext> {
    const actor = await db.query<{
      role: 'Host' | 'Player' | 'Observer' | 'Administrator';
      controlled_country_id: string | null;
    }>(
      `SELECT role, controlled_country_id FROM game_members
       WHERE game_id = $1 AND user_id = $2 AND status = 'Active'`,
      [gameId, userId],
    );
    const member = actor.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    if (previewMemberId) {
      if (member.role !== 'Host' && member.role !== 'Administrator') {
        throw new ApiFault(
          403,
          'PLAYER_VIEW_PREVIEW_FORBIDDEN',
          '只有主持人可以预览玩家视角。',
        );
      }
      const target = await db.query<{
        role: 'Host' | 'Player' | 'Observer' | 'Administrator';
        controlled_country_id: string | null;
      }>(
        `SELECT role, controlled_country_id FROM game_members
         WHERE game_id = $1 AND id = $2 AND status = 'Active'`,
        [gameId, previewMemberId],
      );
      const preview = target.rows[0];
      if (!preview)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到预览成员。');
      return {
        access:
          preview.role === 'Player' && preview.controlled_country_id
            ? 'Player'
            : 'Public',
        responseMode: 'Preview',
        countryId:
          preview.role === 'Player' ? preview.controlled_country_id : null,
      };
    }
    if (member.role === 'Host' || member.role === 'Administrator') {
      return { access: 'Truth', responseMode: 'Truth', countryId: null };
    }
    if (member.role === 'Player' && member.controlled_country_id) {
      return {
        access: 'Player',
        responseMode: 'Player',
        countryId: member.controlled_country_id,
      };
    }
    return { access: 'Public', responseMode: 'Public', countryId: null };
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
      mountains: randomUUID(),
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
        ['mountains', '山地', '#a6a3a0', 3, true],
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
      await client.query(
        `INSERT INTO country_tile_knowledge (
           id, game_id, country_id, tile_id, discovery_state, confidence,
           observed_world_version, snapshot, observed_at
         )
         SELECT gen_random_uuid(), c.game_id, c.id, t.id,
                CASE WHEN t.controller_country_id = c.id THEN 'Observed' ELSE 'Mapped' END,
                CASE WHEN t.controller_country_id = c.id THEN 100 ELSE 80 END,
                g.current_world_version, map_tile_snapshot(t.id), NOW()
         FROM countries c JOIN games g ON g.id = c.game_id
         JOIN hex_tiles t ON t.game_id = c.game_id
         WHERE c.game_id = $1
         ON CONFLICT (game_id, country_id, tile_id) DO NOTHING`,
        [gameId],
      );
      await client.query(
        `INSERT INTO country_army_intelligence (
           id, game_id, country_id, army_id, perceived_name,
           perceived_country_id, strength_min, strength_max, confidence,
           observed_world_version, observed_tile_id
         )
         SELECT gen_random_uuid(), c.game_id, c.id, a.id, a.name, a.country_id,
                FLOOR(a.strength * 0.75)::integer,
                CEIL(a.strength * 1.25)::integer,
                65, g.current_world_version, a.tile_id
         FROM countries c JOIN games g ON g.id = c.game_id
         JOIN armies a ON a.game_id = c.game_id AND a.country_id <> c.id
         WHERE c.game_id = $1
         ON CONFLICT (game_id, country_id, army_id) DO NOTHING`,
        [gameId],
      );
      await refreshCountryVision(client, gameId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.getMap(gameId, userId);
  }

  async getMap(
    gameId: string,
    userId: string,
    db: DatabasePool | DatabaseClient = this.database,
  ): Promise<MapMetadata> {
    const view = await this.resolveView(gameId, userId, undefined, db);
    const result = await db.query<{
      id: string;
      name: string;
      width: number;
      height: number;
      orientation: 'Pointy' | 'Flat';
      min_zoom: string;
      max_zoom: string;
      current_world_version: string;
      asset_version: string;
    }>(
      `SELECT m.id, m.name, m.width, m.height, m.orientation, m.min_zoom,
              m.max_zoom, m.asset_version, g.current_world_version
       FROM world_maps m JOIN games g ON g.id = m.game_id WHERE m.game_id = $1`,
      [gameId],
    );
    const row = result.rows[0];
    if (!row)
      throw new ApiFault(404, 'MAP_NOT_FOUND', '该游戏尚未初始化地图。');
    return {
      id: row.id,
      name: row.name,
      viewCountryId: view.access === 'Player' ? view.countryId : null,
      width: row.width,
      height: row.height,
      orientation: row.orientation,
      minZoom: Number(row.min_zoom),
      maxZoom: Number(row.max_zoom),
      currentWorldVersion: Number(row.current_world_version),
      revision: Number(row.asset_version),
      availableLayers: ['political', 'terrain', 'knowledge', 'city', 'army'],
    };
  }

  async getViewport(input: {
    gameId: string;
    userId: string;
    previewMemberId?: string;
    minQ: number;
    maxQ: number;
    minR: number;
    maxR: number;
  }): Promise<MapViewportData> {
    return this.readSnapshot((db) => this.readViewport(input, db));
  }

  private async readSnapshot<T>(
    operation: (db: DatabaseClient) => Promise<T>,
  ): Promise<T> {
    const db = await this.database.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
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

  private async readViewport(
    input: {
      gameId: string;
      userId: string;
      previewMemberId?: string;
      minQ: number;
      maxQ: number;
      minR: number;
      maxR: number;
    },
    db: DatabaseClient,
  ): Promise<MapViewportData> {
    const view = await this.resolveView(
      input.gameId,
      input.userId,
      input.previewMemberId,
      db,
    );
    if ((input.maxQ - input.minQ + 1) * (input.maxR - input.minR + 1) > 2500) {
      throw new ApiFault(
        400,
        'VIEWPORT_TOO_LARGE',
        '地图视口最多包含 2500 个坐标。',
      );
    }
    const map = await this.getMap(input.gameId, input.userId, db);
    const tilesResult = await db.query<TileRow>(
      `SELECT t.id, t.q, t.r, tt.key AS terrain_key, tt.name AS terrain_name,
                tt.color AS terrain_color, t.region_id, r.name AS region_name,
                t.controller_country_id, c.name AS controller_country_name,
                c.map_color AS controller_color, t.legal_owner_country_id,
                legal.name AS legal_owner_country_name, legal.map_color AS legal_owner_color,
                t.passable, t.movement_cost,
                ctk.discovery_state, ctk.confidence AS knowledge_confidence,
                ctk.observed_world_version, ctk.snapshot, ctk.public_note, ctk.observed_at
         FROM hex_tiles t
         JOIN terrain_types tt ON tt.id = t.terrain_type_id
         LEFT JOIN regions r ON r.id = t.region_id
         LEFT JOIN countries c ON c.id = t.controller_country_id
         LEFT JOIN countries legal ON legal.id = t.legal_owner_country_id
         LEFT JOIN country_tile_knowledge ctk
           ON ctk.game_id = t.game_id AND ctk.tile_id = t.id
          AND ctk.country_id = $6
         WHERE t.game_id = $1 AND t.q BETWEEN $2 AND $3 AND t.r BETWEEN $4 AND $5
         ORDER BY t.r, t.q`,
      [
        input.gameId,
        input.minQ,
        input.maxQ,
        input.minR,
        input.maxR,
        view.countryId,
      ],
    );
    const citiesResult = await db.query<CityRow>(
      `SELECT ci.id, ci.tile_id, ci.name, ci.importance, ci.status
         FROM cities ci JOIN hex_tiles t ON t.id = ci.tile_id
         WHERE ci.game_id = $1 AND t.q BETWEEN $2 AND $3 AND t.r BETWEEN $4 AND $5`,
      [input.gameId, input.minQ, input.maxQ, input.minR, input.maxR],
    );
    const armiesResult = await db.query<PerceivedArmyRow>(
      `SELECT a.id, CASE WHEN $7::boolean OR a.country_id = $6 THEN a.tile_id ELSE cai.observed_tile_id END AS tile_id, a.name, a.strength, a.status, a.country_id,
                cai.perceived_name, cai.perceived_country_id,
                cai.strength_min, cai.strength_max,
                cai.confidence AS intelligence_confidence,
                cai.observed_world_version AS intelligence_world_version,
                cai.is_outdated AS intelligence_outdated
         FROM armies a
         LEFT JOIN country_army_intelligence cai
           ON cai.game_id = a.game_id AND cai.army_id = a.id
          AND cai.country_id = $6
         JOIN hex_tiles t ON t.id = CASE WHEN $7::boolean OR a.country_id = $6 THEN a.tile_id ELSE cai.observed_tile_id END
         WHERE a.game_id = $1 AND t.q BETWEEN $2 AND $3 AND t.r BETWEEN $4 AND $5`,
      [
        input.gameId,
        input.minQ,
        input.maxQ,
        input.minR,
        input.maxR,
        view.countryId,
        view.access === 'Truth',
      ],
    );
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
      const army = projectArmy(row, view);
      if (!army) continue;
      const list = armies.get(row.tile_id) ?? [];
      list.push(army);
      armies.set(row.tile_id, list);
    }
    const tiles: MapTileSummary[] = tilesResult.rows.map((row) => {
      const discoveryState = discoveryFor(view, row.discovery_state);
      const truth: MapTileSummary = {
        id: row.id,
        q: row.q,
        r: row.r,
        discoveryState,
        confidence: view.access === 'Truth' ? 100 : row.knowledge_confidence,
        observedWorldVersion:
          row.observed_world_version === null
            ? null
            : Number(row.observed_world_version),
        terrainKey: row.terrain_key,
        terrainName: row.terrain_name,
        terrainColor: row.terrain_color,
        regionId: row.region_id,
        regionName: row.region_name,
        controllerCountryId: row.controller_country_id,
        controllerCountryName: row.controller_country_name,
        controllerColor: row.controller_color,
        legalOwnerCountryId: row.legal_owner_country_id,
        legalOwnerCountryName: row.legal_owner_country_name,
        legalOwnerColor: row.legal_owner_color,
        passable: row.passable,
        movementCost: Number(row.movement_cost),
        cities: cities.get(row.id) ?? [],
        armies: armies.get(row.id) ?? [],
      };
      return hideUnknownTile(
        view.access === 'Player'
          ? {
              ...truth,
              terrainKey: row.snapshot?.terrainKey ?? null,
              terrainName: row.snapshot?.terrainName ?? null,
              terrainColor: row.snapshot?.terrainColor ?? null,
              regionId: knowsAdministration(discoveryState, row.snapshot)
                ? (row.snapshot?.regionId ?? null)
                : null,
              regionName: knowsAdministration(discoveryState, row.snapshot)
                ? (row.snapshot?.regionName ?? null)
                : null,
              controllerCountryId: row.snapshot?.controllerCountryId ?? null,
              controllerCountryName:
                row.snapshot?.controllerCountryName ?? null,
              controllerColor: row.snapshot?.controllerColor ?? null,
              legalOwnerCountryId: row.snapshot?.legalOwnerCountryId ?? null,
              legalOwnerCountryName:
                row.snapshot?.legalOwnerCountryName ?? null,
              legalOwnerColor: row.snapshot?.legalOwnerColor ?? null,
              passable: row.snapshot?.passable ?? null,
              movementCost: row.snapshot?.movementCost ?? null,
              cities: row.snapshot?.cities ?? [],
              id: row.id,
              q: row.q,
              r: row.r,
              armies: truth.armies,
              discoveryState,
              confidence: row.knowledge_confidence,
              observedWorldVersion:
                row.observed_world_version === null
                  ? null
                  : Number(row.observed_world_version),
              knowledgeNote: row.public_note ?? '',
              observedAt: row.observed_at?.toISOString() ?? null,
            }
          : truth,
        discoveryState,
      );
    });
    return {
      mapId: map.id,
      worldVersion: map.currentWorldVersion,
      bounds: {
        minQ: input.minQ,
        maxQ: input.maxQ,
        minR: input.minR,
        maxR: input.maxR,
      },
      viewMode: view.responseMode,
      viewCountryId: view.countryId,
      tiles,
    };
  }

  async getTile(
    gameId: string,
    userId: string,
    tileId: string,
    previewMemberId?: string,
  ): Promise<TileDetails> {
    return this.readSnapshot((db) =>
      this.readTile(gameId, userId, tileId, previewMemberId, db),
    );
  }

  async getTileContext(
    gameId: string,
    userId: string,
    tileId: string,
    previewMemberId?: string,
    referenceCountryId?: string,
  ) {
    return this.readSnapshot(async (db) => {
      const view = await this.resolveView(gameId, userId, previewMemberId, db);
      const tile = await this.readTile(
        gameId,
        userId,
        tileId,
        previewMemberId,
        db,
      );
      return readMapTileContext(db, gameId, tile, view, referenceCountryId);
    });
  }

  async locateReference(
    gameId: string,
    userId: string,
    objectType: 'Tile' | 'Province',
    objectId: string,
    previewMemberId?: string,
  ): Promise<MapObjectLocation> {
    return this.readSnapshot(async (db) => {
      const view = await this.resolveView(gameId, userId, previewMemberId, db);
      if (objectType === 'Tile') {
        const tile = await this.readTile(
          gameId,
          userId,
          objectId,
          previewMemberId,
          db,
        );
        return { id: tile.id, q: tile.q, r: tile.r };
      }
      const rows =
        view.access === 'Player'
          ? await db.query<{ id: string; q: number; r: number }>(
              `SELECT t.id,t.q,t.r FROM provinces p JOIN country_tile_knowledge k ON k.game_id=p.game_id AND k.country_id=$3 AND k.discovery_state IN ('Mapped','Observed','Outdated') AND ${knownAdministrationSql} AND k.snapshot->>'provinceName'=p.name JOIN hex_tiles t ON t.game_id=k.game_id AND t.id=k.tile_id WHERE p.game_id=$1 AND p.id=$2 ORDER BY t.r,t.q`,
              [gameId, objectId, view.countryId],
            )
          : await db.query<{ id: string; q: number; r: number }>(
              `SELECT t.id,t.q,t.r FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id WHERE t.game_id=$1 AND r.province_id=$2 ORDER BY t.r,t.q`,
              [gameId, objectId],
            );
      if (!rows.rows.length)
        throw new ApiFault(
          404,
          'OBJECT_NOT_FOUND',
          '该省份暂无可定位的地理记录。',
        );
      const center = rows.rows.reduce(
        (sum, t) => ({
          q: sum.q + t.q / rows.rows.length,
          r: sum.r + t.r / rows.rows.length,
        }),
        { q: 0, r: 0 },
      );
      const tile = rows.rows.reduce((nearest, t) =>
        Math.hypot(t.q - center.q, t.r - center.r) <
        Math.hypot(nearest.q - center.q, nearest.r - center.r)
          ? t
          : nearest,
      );
      return { ...tile, scope: rows.rows };
    });
  }

  private async readTile(
    gameId: string,
    userId: string,
    tileId: string,
    previewMemberId: string | undefined,
    db: DatabaseClient,
  ): Promise<TileDetails> {
    const view = await this.resolveView(gameId, userId, previewMemberId, db);
    const location = await db.query<{ q: number; r: number }>(
      'SELECT q, r FROM hex_tiles WHERE game_id = $1 AND id = $2',
      [gameId, tileId],
    );
    const point = location.rows[0];
    if (!point) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该地块。');
    const viewport = await this.readViewport(
      {
        gameId,
        userId,
        minQ: point.q,
        maxQ: point.q,
        minR: point.r,
        maxR: point.r,
        previewMemberId,
      },
      db,
    );
    const tile = viewport.tiles[0];
    if (!tile) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该地块。');
    if (view.access === 'Player') {
      const knowledge = await db.query<{
        snapshot:
          (Partial<TileDetails> & { administrationKnown?: boolean }) | null;
      }>(
        'SELECT snapshot FROM country_tile_knowledge WHERE game_id=$1 AND country_id=$2 AND tile_id=$3',
        [gameId, view.countryId, tileId],
      );
      const snapshot = knowledge.rows[0]?.snapshot;
      const geography = ['Mapped', 'Observed', 'Outdated'].includes(
        tile.discoveryState,
      );
      const current = ['Observed', 'Outdated'].includes(tile.discoveryState);
      return {
        ...tile,
        provinceName: knowsAdministration(tile.discoveryState, snapshot)
          ? (snapshot?.provinceName ?? null)
          : null,
        legalOwnerCountryName: current
          ? (snapshot?.legalOwnerCountryName ?? null)
          : null,
        occupierCountryName: current
          ? (snapshot?.occupierCountryName ?? null)
          : null,
        elevation: geography ? (snapshot?.elevation ?? null) : null,
        roadLevel: geography ? (snapshot?.roadLevel ?? null) : null,
      };
    }
    const extra = await db.query<{
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
    const hasGeography =
      view.access === 'Truth' ||
      tile.discoveryState === 'Mapped' ||
      tile.discoveryState === 'Observed' ||
      tile.discoveryState === 'Outdated';
    const hasCurrentState =
      view.access === 'Truth' || tile.discoveryState === 'Observed';
    return {
      ...tile,
      provinceName: hasGeography ? row.province_name : null,
      legalOwnerCountryName: hasCurrentState ? row.legal_owner_name : null,
      occupierCountryName: hasCurrentState ? row.occupier_name : null,
      elevation: hasGeography ? row.elevation : null,
      roadLevel: hasGeography ? row.road_level : null,
      ...(view.access === 'Truth' ? { notes: row.notes } : {}),
    };
  }

  async getNeighbors(
    gameId: string,
    userId: string,
    tileId: string,
    previewMemberId?: string,
  ): Promise<MapTileSummary[]> {
    const tile = await this.getTile(gameId, userId, tileId, previewMemberId);
    // q/r uses an odd-row offset grid, so diagonal neighbors depend on row parity.
    const coordinates =
      Math.abs(tile.r % 2) === 1
        ? [
            [1, 0],
            [-1, 0],
            [0, -1],
            [1, -1],
            [0, 1],
            [1, 1],
          ]
        : [
            [1, 0],
            [-1, 0],
            [-1, -1],
            [0, -1],
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
      previewMemberId,
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
    previewMemberId?: string,
  ): Promise<MapSearchResult[]> {
    const view = await this.resolveView(gameId, userId, previewMemberId);
    if (view.access === 'Player') {
      const result = await this.database.query<MapSearchResult>(
        `SELECT * FROM (
        SELECT (city->>'id')::uuid AS id, 'City'::text AS type, city->>'name' AS name, k.tile_id AS "tileId", t.q, t.r
        FROM country_tile_knowledge k JOIN hex_tiles t ON t.id=k.tile_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(k.snapshot->'cities','[]'::jsonb)) city
        WHERE k.game_id=$1 AND k.country_id=$3 AND k.discovery_state IN ('Discovered','Mapped','Observed','Outdated')
        UNION ALL
        SELECT a.id,'Army',a.name,a.tile_id,t.q,t.r FROM armies a JOIN hex_tiles t ON t.id=a.tile_id WHERE a.game_id=$1 AND a.country_id=$3
        UNION ALL
        SELECT i.army_id,'Army',i.perceived_name,i.observed_tile_id,t.q,t.r FROM country_army_intelligence i
        JOIN armies a ON a.id=i.army_id JOIN hex_tiles t ON t.id=i.observed_tile_id
        JOIN country_tile_knowledge k ON k.game_id=i.game_id AND k.country_id=i.country_id AND k.tile_id=i.observed_tile_id
        WHERE i.game_id=$1 AND i.country_id=$3 AND a.country_id<>$3 AND k.discovery_state IN ('Discovered','Mapped','Observed','Outdated')
        UNION ALL
        SELECT DISTINCT ON (k.snapshot->>'regionId') (k.snapshot->>'regionId')::uuid,'Region',k.snapshot->>'regionName',k.tile_id,t.q,t.r
        FROM country_tile_knowledge k JOIN hex_tiles t ON t.id=k.tile_id WHERE k.game_id=$1 AND k.country_id=$3
          AND k.snapshot->>'regionId' IS NOT NULL AND k.discovery_state IN ('Mapped','Observed','Outdated') AND ${knownAdministrationSql}
      ) objects WHERE LOWER(name) LIKE LOWER($2) ORDER BY name LIMIT 20`,
        [gameId, `%${query}%`, view.countryId],
      );
      return result.rows;
    }
    const result = await this.database.query<MapSearchResult>(
      `SELECT * FROM (
         SELECT ci.id, 'City'::text AS type, ci.name, ci.tile_id AS "tileId", t.q, t.r
         FROM cities ci JOIN hex_tiles t ON t.id = ci.tile_id
         LEFT JOIN country_tile_knowledge ctk ON ctk.game_id = t.game_id
           AND ctk.tile_id = t.id AND ctk.country_id = $3
         WHERE ci.game_id = $1 AND ($4 OR $5 OR ctk.discovery_state IN ('Mapped', 'Observed', 'Outdated'))
         UNION ALL
         SELECT a.id, 'Army',
                CASE WHEN $4 OR a.country_id = $3 THEN a.name ELSE cai.perceived_name END,
                a.tile_id, t.q, t.r
         FROM armies a JOIN hex_tiles t ON t.id = a.tile_id
         LEFT JOIN country_army_intelligence cai ON cai.game_id = a.game_id
           AND cai.army_id = a.id AND cai.country_id = $3
         WHERE a.game_id = $1 AND ($4 OR a.country_id = $3 OR cai.army_id IS NOT NULL)
         UNION ALL
         SELECT r.id, 'Region', r.name, location.id, location.q, location.r
         FROM regions r
         JOIN LATERAL (SELECT t.id,t.q,t.r FROM hex_tiles t WHERE t.game_id=r.game_id AND t.region_id=r.id ORDER BY t.r,t.q LIMIT 1) location ON TRUE
         WHERE r.game_id = $1 AND ($4 OR $5 OR EXISTS (
           SELECT 1 FROM hex_tiles t
           JOIN country_tile_knowledge ctk ON ctk.game_id = t.game_id
             AND ctk.tile_id = t.id AND ctk.country_id = $3
           WHERE t.region_id = r.id AND ctk.discovery_state IN ('Mapped', 'Observed', 'Outdated')
         ))
       ) objects WHERE LOWER(name) LIKE LOWER($2) ORDER BY name LIMIT 20`,
      [
        gameId,
        `%${query}%`,
        view.countryId,
        view.access === 'Truth',
        view.access === 'Public',
      ],
    );
    return result.rows;
  }

  async updateTile(input: {
    correctionReason?: string;
    expectedRevision?: number;
    gameId: string;
    userId: string;
    tileId: string;
    terrainTypeId?: string;
    controllerCountryId?: string | null;
    notes?: string;
  }): Promise<TileDetails> {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, input.gameId, input.userId);
      const map = await lockMap(db, input.gameId, input.expectedRevision);
      requireInstantCorrection(map, input);
      const before = await captureTiles(db, input.gameId, [input.tileId], 404);
      const result = await db.query(
        `UPDATE hex_tiles t SET
         terrain_type_id = COALESCE($3, terrain_type_id),
         passable = COALESCE((SELECT passable FROM terrain_types WHERE id=$3), t.passable),
         movement_cost = COALESCE((SELECT movement_cost FROM terrain_types WHERE id=$3), t.movement_cost),
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
      await recordMapChange(db, {
        gameId: input.gameId,
        userId: input.userId,
        kind: 'EditTile',
        note: input.correctionReason?.trim(),
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: [input.tileId],
        details: {
          before,
          after: await captureTiles(db, input.gameId, [input.tileId]),
        },
      });
    });
    return this.getTile(input.gameId, input.userId, input.tileId);
  }

  async createCity(input: {
    correctionReason?: string;
    expectedRevision?: number;
    gameId: string;
    userId: string;
    tileId: string;
    name: string;
    countryId?: string | null;
  }): Promise<TileDetails> {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, input.gameId, input.userId);
      const map = await lockMap(db, input.gameId, input.expectedRevision);
      requireInstantCorrection(map, input);
      const before = await captureTiles(db, input.gameId, [input.tileId], 404);
      const result = await db.query(
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
      await recordMapChange(db, {
        gameId: input.gameId,
        userId: input.userId,
        kind: 'CreateCity',
        note: input.correctionReason?.trim(),
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: [input.tileId],
        details: {
          before,
          after: await captureTiles(db, input.gameId, [input.tileId]),
        },
      });
    });
    return this.getTile(input.gameId, input.userId, input.tileId);
  }

  async createArmy(input: {
    correctionReason?: string;
    expectedRevision?: number;
    gameId: string;
    userId: string;
    tileId: string;
    countryId: string;
    name: string;
    strength: number;
  }): Promise<TileDetails> {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, input.gameId, input.userId);
      const map = await lockMap(db, input.gameId, input.expectedRevision);
      requireInstantCorrection(map, input);
      const result = await db.query(
        `INSERT INTO armies (id, game_id, country_id, tile_id, name, strength)
       SELECT $1, $2, $4, t.id, $5, $6 FROM hex_tiles t
       WHERE t.game_id = $2 AND t.id = $3 AND t.passable = TRUE
         AND EXISTS (SELECT 1 FROM countries c WHERE c.game_id = $2 AND c.id = $4) RETURNING *`,
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
      await recordMapChange(db, {
        gameId: input.gameId,
        userId: input.userId,
        kind: 'CreateArmy',
        note: input.correctionReason?.trim(),
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: [input.tileId],
        details: { after: result.rows[0] },
      });
    });
    return this.getTile(input.gameId, input.userId, input.tileId);
  }

  async moveArmy(input: {
    correctionReason?: string;
    expectedRevision?: number;
    gameId: string;
    userId: string;
    armyId: string;
    tileId: string;
  }): Promise<TileDetails> {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, input.gameId, input.userId);
      const map = await lockMap(db, input.gameId, input.expectedRevision);
      requireInstantCorrection(map, input);
      const before = await db.query<{ tile_id: string }>(
        'SELECT * FROM armies WHERE game_id=$1 AND id=$2',
        [input.gameId, input.armyId],
      );
      const result = await db.query(
        `UPDATE armies a SET tile_id = $3 WHERE a.game_id = $1 AND a.id = $2
         AND EXISTS (SELECT 1 FROM hex_tiles t WHERE t.game_id = $1 AND t.id = $3 AND t.passable = TRUE) RETURNING *`,
        [input.gameId, input.armyId, input.tileId],
      );
      if (result.rowCount !== 1)
        throw new ApiFault(
          404,
          'OBJECT_NOT_FOUND',
          '未找到军队或有效目标地块。',
        );
      await recordMapChange(db, {
        gameId: input.gameId,
        userId: input.userId,
        kind: 'MoveArmy',
        note: input.correctionReason?.trim(),
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: [...new Set([before.rows[0]!.tile_id, input.tileId])],
        details: { before: before.rows[0], after: result.rows[0] },
      });
    });
    return this.getTile(input.gameId, input.userId, input.tileId);
  }
}
