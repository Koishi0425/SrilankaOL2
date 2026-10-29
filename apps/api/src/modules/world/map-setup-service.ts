import { randomUUID } from 'node:crypto';

import type {
  MapBatchInput,
  MapHistoryEntry,
  MapKnowledgeInput,
  MapSetupData,
  CreateMapInput,
  MapGenerationOptions,
  TileTagChange,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import {
  applyObservation,
  captureArmyReports,
  revealSummary,
  type ArmyReport,
  type RevealRow,
} from './map-discovery.js';
import {
  captureTiles,
  lockMap,
  mapTransaction,
  recordMapChange,
  requireMapHost,
  requireInstantCorrection,
} from './map-mutations.js';

import { tagBaseline, applyTileTag } from './tile-tags.js';
import { applyGeneration, generationBlocked } from './map-generation.js';

export class MapSetupService {
  constructor(private readonly database: DatabasePool) {}

  async get(gameId: string, userId: string): Promise<MapSetupData> {
    await requireMapHost(this.database, gameId, userId);
    const [maps, terrains, regions, provinces] = await Promise.all([
      this.database.query<{
        id: string;
        name: string;
        width: number;
        height: number;
        asset_version: string;
        current_world_version: string;
      }>(
        `SELECT m.*, g.current_world_version FROM world_maps m JOIN games g ON g.id = m.game_id WHERE m.game_id = $1`,
        [gameId],
      ),
      this.database.query<{
        id: string;
        name: string;
        color: string;
        passable: boolean;
        movement_cost: string;
      }>('SELECT * FROM terrain_types WHERE game_id = $1 ORDER BY name', [
        gameId,
      ]),
      this.database.query<{
        id: string;
        name: string;
        provinceName: string | null;
      }>(
        'SELECT r.id, r.name, p.name AS "provinceName" FROM regions r LEFT JOIN provinces p ON p.id = r.province_id WHERE r.game_id = $1 ORDER BY r.name',
        [gameId],
      ),
      this.database.query<{ id: string; name: string }>(
        'SELECT id,name FROM provinces WHERE game_id=$1 ORDER BY name,id',
        [gameId],
      ),
    ]);
    const map = maps.rows[0];
    return {
      generationBlockedReason:
        map && (await generationBlocked(this.database, gameId))
          ? '已有国家归属、地区、城市、军队、道路或已知情报，请使用笔刷与批量工具调整。'
          : undefined,
      map: map
        ? {
            id: map.id,
            name: map.name,
            width: map.width,
            height: map.height,
            orientation: 'Pointy',
            minZoom: 0.5,
            maxZoom: 3,
            currentWorldVersion: Number(map.current_world_version),
            revision: Number(map.asset_version),
            availableLayers: [
              'political',
              'terrain',
              'knowledge',
              'city',
              'army',
            ],
          }
        : null,
      terrains: terrains.rows.map((row) => ({
        id: row.id,
        name: row.name,
        color: row.color,
        passable: row.passable,
        movementCost: Number(row.movement_cost),
      })),
      regions: regions.rows,
      provinces: provinces.rows,
    };
  }

  async create(gameId: string, userId: string, input: CreateMapInput) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const quarter = await db.query<{
        state: string;
        sequence_number: number;
      }>(
        'SELECT state,sequence_number FROM quarters WHERE game_id = $1 AND is_current FOR UPDATE',
        [gameId],
      );
      if (quarter.rows[0]?.state !== 'Preparing')
        throw new ApiFault(
          409,
          'MAP_SETUP_LOCKED',
          '请在回合准备阶段创建地图。',
        );
      const game = await db.query<{
        current_world_version: string;
        status: string;
      }>(
        'SELECT current_world_version,status FROM games WHERE id = $1 FOR UPDATE',
        [gameId],
      );
      if (
        (
          await db.query('SELECT id FROM world_maps WHERE game_id = $1', [
            gameId,
          ])
        ).rowCount
      )
        throw new ApiFault(
          409,
          'MAP_ALREADY_EXISTS',
          '地图已存在，请直接编辑现有地块。',
        );
      if (
        input.generation &&
        (quarter.rows[0]?.sequence_number !== 1 ||
          game.rows[0]?.status !== 'Preparing')
      )
        throw new ApiFault(
          409,
          'MAP_GENERATION_LOCKED',
          '仅开局准备阶段可自动生成地图。',
        );
      const mapId = randomUUID();
      await db.query(
        'INSERT INTO world_maps (id, game_id, name, width, height) VALUES ($1,$2,$3,$4,$5)',
        [mapId, gameId, input.name, input.width, input.height],
      );
      const countries = await db.query<{ id: string }>(
        'SELECT id FROM countries WHERE game_id=$1 ORDER BY created_at,id',
        [gameId],
      );
      const palette = [
        '#c65d4b',
        '#4f7cac',
        '#d5a848',
        '#705d9e',
        '#4f8f67',
        '#b95b91',
        '#528b89',
        '#986b4e',
      ];
      for (const [index, country] of countries.rows.entries())
        await db.query(
          "UPDATE countries SET map_color=$2 WHERE id=$1 AND map_color='#64748b'",
          [country.id, palette[index % palette.length]],
        );
      for (const [key, name, color, cost, passable] of [
        ['plains', '平原', '#b9c98f', 1, true],
        ['hills', '丘陵', '#a68b5b', 2, true],
        ['mountains', '山地', '#a6a3a0', 3, true],
        ['forest', '森林', '#5f8a62', 2, true],
        ['water', '水域', '#5a8fb8', 3, false],
      ] as const) {
        await db.query(
          'INSERT INTO terrain_types (id, game_id, key, name, color, movement_cost, passable) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (game_id,key) DO NOTHING',
          [randomUUID(), gameId, key, name, color, cost, passable],
        );
      }
      await db.query(
        `INSERT INTO hex_tiles (id, game_id, map_id, q, r, terrain_type_id, passable, movement_cost)
        SELECT gen_random_uuid(), $1, $2, q,r,tt.id,tt.passable,tt.movement_cost FROM generate_series(0,$3::int-1) q CROSS JOIN generate_series(0,$4::int-1) r
        JOIN terrain_types tt ON tt.game_id = $1 AND tt.key = 'plains'`,
        [gameId, mapId, input.width, input.height],
      );
      if (input.generation)
        await applyGeneration(
          db,
          gameId,
          input.width,
          input.height,
          input.generation,
        );
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'CreateMap',
        truth: true,
        worldVersion: Number(game.rows[0]!.current_world_version),
        tileIds: [],
        note: input.generation
          ? `${input.name} · 自动地形 · 种子 ${input.generation.seed}`
          : input.name,
        details: {
          ...input,
          ...(input.generation ? { generatorVersion: 1 } : {}),
        },
      });
    });
    return this.get(gameId, userId);
  }

  async generate(
    gameId: string,
    userId: string,
    input: MapGenerationOptions & { expectedRevision: number },
  ) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const locked = await lockMap(db, gameId, input.expectedRevision);
      if (
        locked.gameStatus !== 'Preparing' ||
        locked.quarter.state !== 'Preparing' ||
        locked.quarter.sequence_number !== 1
      )
        throw new ApiFault(
          409,
          'MAP_GENERATION_LOCKED',
          '仅开局准备阶段可重新生成地图。',
        );
      if (await generationBlocked(db, gameId))
        throw new ApiFault(
          409,
          'MAP_GENERATION_HAS_CONTENT',
          '已有国家归属、地区、城市、军队、道路或已知情报，不能重新生成，请使用批量工具调整。',
        );
      const maps = await db.query<{ width: number; height: number }>(
        'SELECT width,height FROM world_maps WHERE game_id=$1',
        [gameId],
      );
      const ids = await db.query<{ id: string }>(
        'SELECT id FROM hex_tiles WHERE game_id=$1 ORDER BY r,q',
        [gameId],
      );
      const tileIds = ids.rows.map((t) => t.id);
      const before = await captureTiles(db, gameId, tileIds);
      await applyGeneration(
        db,
        gameId,
        maps.rows[0]!.width,
        maps.rows[0]!.height,
        input,
      );
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'GenerateMap',
        truth: true,
        worldVersion: locked.worldVersion,
        tileIds,
        note: `自动生成地形 · 种子 ${input.seed}`,
        details: {
          generatorVersion: 1,
          options: input,
          before,
          after: await captureTiles(db, gameId, tileIds),
        },
      });
    });
    return this.get(gameId, userId);
  }

  async batch(gameId: string, userId: string, input: MapBatchInput) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const map = await lockMap(db, gameId, input.expectedRevision);
      requireInstantCorrection(map, input);
      const before = await captureTiles(db, gameId, input.tileIds);
      for (const id of [
        input.controllerCountryId,
        input.legalOwnerCountryId,
      ].filter(Boolean))
        if (
          !(
            await db.query(
              "SELECT id FROM countries WHERE game_id = $1 AND id = $2 AND status = 'Active'",
              [gameId, id],
            )
          ).rowCount
        )
          throw new ApiFault(
            400,
            'INVALID_MAP_COUNTRY',
            '国家不属于当前游戏。',
          );
      if (
        input.terrainTypeId &&
        !(
          await db.query(
            'SELECT id FROM terrain_types WHERE game_id = $1 AND id = $2',
            [gameId, input.terrainTypeId],
          )
        ).rowCount
      )
        throw new ApiFault(400, 'INVALID_MAP_TERRAIN', '地形不属于当前地图。');
      let regionId: string | null = null;
      if (input.regionName) {
        let provinceId: string | null = null;
        if (input.provinceName) {
          const province = await db.query<{ id: string }>(
            'INSERT INTO provinces (id, game_id, map_id, name) SELECT $1,$2,id,$3 FROM world_maps WHERE game_id = $2 ON CONFLICT (game_id,name) DO UPDATE SET name = EXCLUDED.name RETURNING id',
            [randomUUID(), gameId, input.provinceName],
          );
          provinceId = province.rows[0]!.id;
        }
        const existing = await db.query<{
          id: string;
          province_id: string | null;
        }>(
          'SELECT id, province_id FROM regions WHERE game_id = $1 AND name = $2',
          [gameId, input.regionName],
        );
        if (
          existing.rows[0] &&
          input.provinceName &&
          existing.rows[0].province_id === null
        ) {
          const remaining = await db.query(
            'SELECT id FROM hex_tiles WHERE game_id=$1 AND region_id=$2 AND NOT(id=ANY($3::uuid[])) LIMIT 1',
            [gameId, existing.rows[0].id, input.tileIds],
          );
          if (remaining.rowCount)
            throw new ApiFault(
              409,
              'REGION_PROVINCE_CONFLICT',
              '该地区还有未选择的地块，请选全地区或使用新地区名称。',
            );
          await db.query(
            'UPDATE regions SET province_id=$3 WHERE game_id=$1 AND id=$2',
            [gameId, existing.rows[0].id, provinceId],
          );
        } else if (
          existing.rows[0] &&
          input.provinceName &&
          existing.rows[0].province_id !== provinceId
        )
          throw new ApiFault(
            409,
            'REGION_PROVINCE_CONFLICT',
            '该地区已属于另一省份，请使用新地区名称。',
          );
        regionId = existing.rows[0]?.id ?? randomUUID();
        if (!existing.rowCount)
          await db.query(
            'INSERT INTO regions (id,game_id,map_id,province_id,name) SELECT $1,$2,id,$3,$4 FROM world_maps WHERE game_id = $2',
            [regionId, gameId, provinceId, input.regionName],
          );
      }
      await db.query(
        `UPDATE hex_tiles t SET terrain_type_id = COALESCE($3,t.terrain_type_id),
        passable = COALESCE((SELECT passable FROM terrain_types WHERE id = $3),t.passable), movement_cost = COALESCE((SELECT movement_cost FROM terrain_types WHERE id = $3),t.movement_cost),
        controller_country_id = CASE WHEN $4 THEN $5::uuid ELSE t.controller_country_id END,
        legal_owner_country_id = CASE WHEN $6 THEN $7::uuid ELSE t.legal_owner_country_id END,
        region_id = COALESCE($8,region_id), updated_at = NOW() WHERE game_id = $1 AND id = ANY($2::uuid[])`,
        [
          gameId,
          input.tileIds,
          input.terrainTypeId ?? null,
          input.controllerCountryId !== undefined,
          input.controllerCountryId ?? null,
          input.legalOwnerCountryId !== undefined,
          input.legalOwnerCountryId ?? null,
          regionId,
        ],
      );
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'EditTiles',
        note: input.correctionReason?.trim(),
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: input.tileIds,
        details: {
          before,
          after: await captureTiles(db, gameId, input.tileIds),
        },
      });
    });
    return this.get(gameId, userId);
  }

  async tags(
    gameId: string,
    userId: string,
    input: TileTagChange & {
      expectedRevision: number;
      correctionReason?: string;
    },
  ) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const map = await lockMap(db, gameId, input.expectedRevision);
      requireInstantCorrection(map, input);
      const before = await tagBaseline(db, gameId, input);
      await applyTileTag(db, gameId, map.quarter.sequence_number, input);
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'TileTags',
        truth: true,
        worldVersion: map.worldVersion,
        tileIds: input.tileIds,
        note:
          input.correctionReason ??
          `${input.operation === 'Set' ? '设置' : '移除'} ${input.tag.name}`,
        details: { before, change: input },
      });
    });
    return this.get(gameId, userId);
  }

  async knowledge(gameId: string, userId: string, input: MapKnowledgeInput) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      if (input.sourceActionId)
        await db.query(
          'SELECT q.id FROM quarters q JOIN actions a ON a.quarter_id = q.id AND a.game_id = q.game_id WHERE a.game_id = $1 AND a.id = $2 FOR UPDATE OF q',
          [gameId, input.sourceActionId],
        );
      const map = await lockMap(db, gameId, input.expectedRevision);
      if (
        !(
          await db.query(
            "SELECT id FROM countries WHERE game_id = $1 AND id = $2 AND status = 'Active'",
            [gameId, input.countryId],
          )
        ).rowCount
      )
        throw new ApiFault(400, 'INVALID_MAP_COUNTRY', '国家不属于当前游戏。');
      const tiles = await captureTiles(db, gameId, input.tileIds);
      let reports: ArmyReport[] | null = null;
      if (input.armyErrorPercent !== undefined) {
        reports = await captureArmyReports(
          db,
          gameId,
          input.countryId,
          input.tileIds,
          input.armyErrorPercent,
        );
      }
      if (input.sourceActionId) {
        const action = await db.query<{
          quarter_id: string;
          country_id: string;
          status: string;
        }>(
          'SELECT quarter_id,country_id,status FROM actions WHERE game_id = $1 AND id = $2',
          [gameId, input.sourceActionId],
        );
        const row = action.rows[0];
        if (
          !row ||
          row.country_id !== input.countryId ||
          row.quarter_id !== map.quarter.id ||
          row.status !== 'Approved' ||
          !['ActionSubmission', 'Locked', 'HostReview', 'Resolving'].includes(
            map.quarter.state,
          )
        )
          throw new ApiFault(
            409,
            'INVALID_EXPLORATION_RESULT',
            '请为本回合已批准的本国政策保存探索结果。',
          );
        await db.query(
          `INSERT INTO map_reveal_plans (id,game_id,quarter_id,action_id,country_id,state,note,tile_snapshots,army_reports,army_error_percent,observed_world_version,updated_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10,$11,$12)
          ON CONFLICT (game_id,action_id) DO UPDATE SET state=EXCLUDED.state,note=EXCLUDED.note,tile_snapshots=EXCLUDED.tile_snapshots,
            army_reports=EXCLUDED.army_reports,army_error_percent=EXCLUDED.army_error_percent,observed_world_version=EXCLUDED.observed_world_version,updated_by_user_id=EXCLUDED.updated_by_user_id,updated_at=NOW()
          WHERE map_reveal_plans.published_at IS NULL`,
          [
            randomUUID(),
            gameId,
            row.quarter_id,
            input.sourceActionId,
            input.countryId,
            input.state,
            input.note,
            JSON.stringify(tiles),
            reports === null ? null : JSON.stringify(reports),
            input.armyErrorPercent ?? null,
            map.worldVersion,
            userId,
          ],
        );
      } else {
        const before = await db.query(
          'SELECT tile_id,discovery_state,snapshot,public_note FROM country_tile_knowledge WHERE game_id=$1 AND country_id=$2 AND tile_id=ANY($3::uuid[])',
          [gameId, input.countryId, input.tileIds],
        );
        await applyObservation(db, {
          gameId,
          countryId: input.countryId,
          state: input.state,
          note: input.note,
          tiles,
          reports,
          worldVersion: map.worldVersion,
          observedAt: new Date(),
        });
        await recordMapChange(db, {
          gameId,
          userId,
          kind: 'RevealKnowledge',
          worldVersion: map.worldVersion,
          tileIds: input.tileIds,
          countryId: input.countryId,
          note: input.note,
          details: {
            before: before.rows,
            after: tiles,
            state: input.state,
            reports,
          },
        });
        return;
      }
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'PrepareExploration',
        worldVersion: map.worldVersion,
        tileIds: input.tileIds,
        countryId: input.countryId,
        sourceActionId: input.sourceActionId,
        note: input.note,
        details: { tiles, state: input.state, reports },
      });
    });
    return this.get(gameId, userId);
  }

  async initializeKnowledge(
    gameId: string,
    userId: string,
    input: {
      expectedRevision: number;
      countryId: string;
      mode: 'OwnTerritory' | 'Geography' | 'Unknown';
    },
  ) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const map = await lockMap(db, gameId, input.expectedRevision);
      if (
        map.quarter.sequence_number !== 1 ||
        map.quarter.state !== 'Preparing'
      )
        throw new ApiFault(
          409,
          'INITIAL_KNOWLEDGE_LOCKED',
          '初始范围只能在第一回合准备阶段设置。',
        );
      if (
        !(
          await db.query(
            "SELECT id FROM countries WHERE game_id=$1 AND id=$2 AND status='Active'",
            [gameId, input.countryId],
          )
        ).rowCount
      )
        throw new ApiFault(400, 'INVALID_MAP_COUNTRY', '国家不属于当前游戏。');
      const result = await db.query<{
        id: string;
        controller_country_id: string | null;
      }>(
        'SELECT id,controller_country_id FROM hex_tiles WHERE game_id=$1 ORDER BY r,q',
        [gameId],
      );
      const tiles = await captureTiles(
        db,
        gameId,
        result.rows.map((row) => row.id),
      );
      const byId = new Map(tiles.map((tile) => [tile.tileId, tile]));
      const before = await db.query(
        'SELECT tile_id,discovery_state,snapshot,public_note FROM country_tile_knowledge WHERE game_id=$1 AND country_id=$2',
        [gameId, input.countryId],
      );
      await db.query(
        'DELETE FROM country_army_intelligence WHERE game_id=$1 AND country_id=$2',
        [gameId, input.countryId],
      );
      for (const state of ['Unknown', 'Mapped', 'Observed'] as const) {
        const group = result.rows
          .filter(
            (row) =>
              (input.mode === 'Unknown'
                ? 'Unknown'
                : row.controller_country_id === input.countryId
                  ? 'Observed'
                  : input.mode === 'Geography'
                    ? 'Mapped'
                    : 'Unknown') === state,
          )
          .map((row) => byId.get(row.id)!);
        if (group.length)
          await applyObservation(db, {
            gameId,
            countryId: input.countryId,
            state,
            note: '',
            tiles: group.map((tile) => ({
              ...tile,
              snapshot: {
                ...tile.snapshot,
                administrationKnown: state === 'Observed',
              },
            })),
            reports: null,
            worldVersion: map.worldVersion,
            observedAt: new Date(),
          });
      }
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'InitializeKnowledge',
        worldVersion: map.worldVersion,
        tileIds: tiles.map((tile) => tile.tileId),
        countryId: input.countryId,
        details: { mode: input.mode, before: before.rows, after: tiles },
      });
    });
    return this.get(gameId, userId);
  }

  async plan(gameId: string, userId: string, actionId: string) {
    await requireMapHost(this.database, gameId, userId);
    const result = await this.database.query<RevealRow>(
      'SELECT * FROM map_reveal_plans WHERE game_id=$1 AND action_id=$2',
      [gameId, actionId],
    );
    return result.rows[0] ? revealSummary(result.rows[0]) : null;
  }

  async removePlan(
    gameId: string,
    userId: string,
    actionId: string,
    expectedRevision: number,
  ) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      await db.query(
        'SELECT q.id FROM quarters q JOIN actions a ON a.quarter_id=q.id AND a.game_id=q.game_id WHERE a.game_id=$1 AND a.id=$2 FOR UPDATE OF q',
        [gameId, actionId],
      );
      const map = await lockMap(db, gameId, expectedRevision);
      const result = await db.query<RevealRow>(
        'DELETE FROM map_reveal_plans WHERE game_id=$1 AND action_id=$2 AND published_at IS NULL RETURNING *',
        [gameId, actionId],
      );
      if (!result.rows[0])
        throw new ApiFault(
          409,
          'EXPLORATION_RESULT_LOCKED',
          '未找到可移除的探索计划。',
        );
      await recordMapChange(db, {
        gameId,
        userId,
        kind: 'RemoveExploration',
        worldVersion: map.worldVersion,
        tileIds: result.rows[0].tile_snapshots.map((tile) => tile.tileId),
        countryId: result.rows[0].country_id,
        sourceActionId: actionId,
        details: result.rows[0],
      });
    });
    return this.get(gameId, userId);
  }

  async history(
    gameId: string,
    userId: string,
    previewMemberId?: string,
  ): Promise<MapHistoryEntry[]> {
    const member = await this.database.query<{
      role: string;
      controlled_country_id: string | null;
    }>(
      "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
      [gameId, userId],
    );
    let row = member.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    if (previewMemberId) {
      if (!['Host', 'Administrator'].includes(row.role))
        throw new ApiFault(
          403,
          'PLAYER_VIEW_PREVIEW_FORBIDDEN',
          '只有主持人可以预览玩家视角。',
        );
      const target = await this.database.query<{
        role: string;
        controlled_country_id: string | null;
      }>(
        "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND id=$2 AND status='Active'",
        [gameId, previewMemberId],
      );
      if (!target.rows[0])
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到预览成员。');
      row = {
        ...target.rows[0],
        role: target.rows[0].role === 'Player' ? 'Player' : 'Observer',
      };
    }
    const result = await this.database.query<{
      id: string;
      kind: string;
      country_name: string | null;
      source_action_id: string | null;
      source_action_title: string | null;
      note: string;
      tile_count: number;
      created_at: Date;
    }>(
      `SELECT h.*,c.name AS country_name,a.title AS source_action_title FROM map_history h
      LEFT JOIN countries c ON c.id=h.country_id LEFT JOIN actions a ON a.id=h.source_action_id
      WHERE h.game_id=$1 AND ($2::boolean OR ($3::boolean AND h.country_id=$4 AND h.kind IN ('InitializeKnowledge','RevealKnowledge','PublishExploration')))
      ORDER BY h.created_at DESC,h.id DESC LIMIT 30`,
      [
        gameId,
        ['Host', 'Administrator'].includes(row.role),
        row.role === 'Player',
        row.controlled_country_id,
      ],
    );
    return result.rows.map((item) => ({
      id: item.id,
      kind: item.kind,
      countryName: item.country_name,
      sourceActionId: item.source_action_id,
      sourceActionTitle: item.source_action_title,
      note: item.note,
      tileCount: item.tile_count,
      createdAt: item.created_at.toISOString(),
    }));
  }
}
