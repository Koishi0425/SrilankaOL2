import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  EconomicRules,
  EconomicRulesData,
  SetEconomicRulesInput,
  EconomicSetupPreview,
  SaveOpeningEconomyInput,
  QuarterSummary,
} from '@srilanka/contracts';
import type { DatabasePool, DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import {
  mapTransaction,
  requireMapHost,
  recordMapChange,
} from '../world/map-mutations.js';
import {
  readEconomicSnapshot,
  calculateEconomy,
} from '../settlements/economy.js';
import { readPreparation } from './game-preparation.js';
import {
  insertResourceLedger,
  validBalance,
  type ResourceRow,
} from '../settlements/resources.js';

async function currentQuarter(
  db: DatabaseClient,
  gameId: string,
  lock = false,
) {
  const row = (
    await db.query<{
      id: string;
      state: QuarterSummary['state'];
      game_year: number;
      season: QuarterSummary['season'];
      sequence_number: number;
      action_deadline: Date | null;
      current_world_version: string;
      status: string;
    }>(
      `SELECT q.id,q.state,q.game_year,q.season,q.sequence_number,q.action_deadline,g.status,g.current_world_version
      FROM quarters q JOIN games g ON g.id=q.game_id WHERE q.game_id=$1 AND q.is_current${lock ? ' FOR UPDATE OF q' : ''}`,
      [gameId],
    )
  ).rows[0];
  if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到当前回合。');
  return {
    quarter: {
      id: row.id,
      state: row.state,
      gameYear: row.game_year,
      season: row.season,
      sequenceNumber: row.sequence_number,
      actionDeadline: row.action_deadline?.toISOString() ?? null,
      currentWorldVersion: Number(row.current_world_version),
    } satisfies QuarterSummary,
    status: row.status,
  };
}
export function validEconomicRules(rules: EconomicRules) {
  return (
    typeof rules.enabled === 'boolean' &&
    [
      rules.taxCoefficient,
      rules.productionCoefficient,
      rules.manpowerCoefficient,
      rules.armyMaintenancePer100,
      rules.administrationCost,
      rules.tradeCoefficient ?? 0,
    ].every(
      (v) =>
        Number.isFinite(v) &&
        v >= 0 &&
        v <= 1000000 &&
        Math.abs(v * 100 - Math.round(v * 100)) < 0.0001,
    )
  );
}
export class EconomicService {
  constructor(private readonly database: DatabasePool) {}
  async preview(
    gameId: string,
    userId: string,
    rules?: EconomicRules,
    seedBlankProvinces = false,
  ): Promise<EconomicSetupPreview> {
    if (rules && !validEconomicRules(rules))
      throw new ApiFault(
        400,
        'INVALID_ECONOMIC_RULES',
        '请填写有效的经济系数。',
      );
    const db = await this.database.connect();
    try {
      await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await requireMapHost(db, gameId, userId);
      const { quarter, status } = await currentQuarter(db, gameId);
      if (
        !quarter ||
        quarter.state !== 'Preparing' ||
        ['Archived', 'Completed'].includes(status)
      )
        throw new ApiFault(
          409,
          'ECONOMIC_RULES_LOCKED',
          '请在回合准备阶段进行经济试算。',
        );
      const snapshot = await readEconomicSnapshot(db, gameId, quarter.id, {
        rules,
        includeDisabled: true,
        seedBlankProvinces,
      });
      const lines = snapshot.rules.enabled ? calculateEconomy(snapshot) : [];
      const countries = (
        await db.query<{
          id: string;
          name: string;
          treasury: string;
          manpower: number;
          resource_revision: number;
        }>(
          "SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 AND status='Active' ORDER BY created_at,id",
          [gameId],
        )
      ).rows;
      const result: EconomicSetupPreview = {
        quarterId: quarter.id,
        preparationRevision: (await readPreparation(db, gameId, quarter))
          .revision,
        rules: snapshot.rules,
        rulesVersion: snapshot.rulesRevision,
        worldVersion: snapshot.worldVersion,
        unconfiguredProvinceCount: Number(
          (
            await db.query<{ count: string }>(
              'SELECT count(*) FROM provinces WHERE game_id=$1 AND profile_revision=0 AND tax_base=0 AND production_base=0 AND manpower_base=0',
              [gameId],
            )
          ).rows[0]!.count,
        ),
        countries: countries.map((country) => ({
          id: country.id,
          name: country.name,
          treasury: Number(country.treasury),
          manpower: country.manpower,
          resourceRevision: country.resource_revision,
          armyStrength: snapshot.armies
            .filter((army) => army.countryId === country.id)
            .reduce((sum, army) => sum + army.strength, 0),
          lines: lines
            .filter((line) => line.countryId === country.id)
            .map(({ kind, calculatedAmount, sources }) => ({
              kind,
              calculatedAmount,
              sources,
            })),
        })),
      };
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }
  async saveOpening(
    gameId: string,
    userId: string,
    input: SaveOpeningEconomyInput,
  ) {
    if (
      !validEconomicRules(input.rules) ||
      !input.reason.trim() ||
      input.reason.length > 2000 ||
      !input.countries.length ||
      input.countries.length > 20 ||
      new Set(input.countries.map((country) => country.id)).size !==
        input.countries.length ||
      input.countries.some(
        (country) =>
          !validBalance('Treasury', country.treasury) ||
          !validBalance('Manpower', country.manpower),
      )
    )
      throw new ApiFault(
        400,
        'INVALID_OPENING_SETUP',
        '请填写有效的开局资源、经济系数和修改说明。',
      );
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const { quarter, status } = await currentQuarter(db, gameId, true);
      if (
        quarter.id !== input.quarterId ||
        quarter.state !== 'Preparing' ||
        quarter.sequenceNumber !== 1 ||
        ['Archived', 'Completed'].includes(status)
      )
        throw new ApiFault(
          409,
          'OPENING_SETUP_LOCKED',
          '开局批量设置仅适用于第一回合准备阶段。',
        );
      await db.query('SELECT id FROM world_maps WHERE game_id=$1 FOR UPDATE', [
        gameId,
      ]);
      const saved = (
        await db.query<{
          economic_rules: EconomicRules;
          current_world_version: string;
        }>(
          'SELECT economic_rules,current_world_version FROM games WHERE id=$1 FOR UPDATE',
          [gameId],
        )
      ).rows[0]!;
      await requireMapHost(db, gameId, userId);
      const countries = (
        await db.query<ResourceRow>(
          "SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 AND status='Active' ORDER BY id FOR UPDATE",
          [gameId],
        )
      ).rows;
      const preparation = await readPreparation(db, gameId, quarter);
      if (preparation.revision !== input.expectedPreparationRevision)
        throw new ApiFault(
          409,
          'OPENING_SETUP_CHANGED',
          '准备内容已在其他窗口修改，请重新读取后核对。当前输入仍可保留。',
        );
      const desired = new Map(
        input.countries.map((country) => [country.id, country]),
      );
      if (
        countries.length !== desired.size ||
        countries.some((country) => !desired.has(country.id))
      )
        throw new ApiFault(
          400,
          'INVALID_OPENING_SETUP',
          '国家列表已变化或包含其他游戏的国家，请重新读取。',
        );
      const rules = {
        ...input.rules,
        tradeCoefficient: input.rules.tradeCoefficient ?? 0,
      };
      if (
        !isDeepStrictEqual(
          {
            ...saved.economic_rules,
            tradeCoefficient: saved.economic_rules.tradeCoefficient ?? 0,
          },
          rules,
        )
      ) {
        await db.query(
          'UPDATE games SET economic_rules=$2::jsonb,economic_rules_revision=economic_rules_revision+1 WHERE id=$1',
          [gameId, JSON.stringify(rules)],
        );
        await db.query(
          'INSERT INTO economic_rule_history(id,game_id,quarter_id,actor_user_id,previous_rules,next_rules,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
          [
            randomUUID(),
            gameId,
            quarter.id,
            userId,
            JSON.stringify(saved.economic_rules),
            JSON.stringify(rules),
            input.reason.trim(),
          ],
        );
      }
      if (input.seedBlankProvinces) {
        const blank = (
          await db.query<{ id: string; name: string }>(
            'SELECT id,name FROM provinces WHERE game_id=$1 AND profile_revision=0 AND tax_base=0 AND production_base=0 AND manpower_base=0 ORDER BY id FOR UPDATE',
            [gameId],
          )
        ).rows;
        if (blank.length) {
          await db.query(
            'UPDATE provinces SET tax_base=10,production_base=10,manpower_base=100,profile_revision=profile_revision+1 WHERE game_id=$1 AND id=ANY($2::uuid[])',
            [gameId, blank.map((province) => province.id)],
          );
          await recordMapChange(db, {
            gameId,
            userId,
            kind: 'EditProvince',
            truth: true,
            worldVersion: Number(saved.current_world_version),
            tileIds: [],
            note: input.reason.trim(),
            details: {
              provinces: blank.map((province) => ({
                provinceId: province.id,
                name: province.name,
                before: { taxBase: 0, productionBase: 0, manpowerBase: 0 },
                after: { taxBase: 10, productionBase: 10, manpowerBase: 100 },
              })),
            },
          });
        }
      }
      let resourcesChanged = false;
      for (const country of countries) {
        const next = desired.get(country.id)!;
        if (
          Number(country.treasury) === next.treasury &&
          country.manpower === next.manpower
        )
          continue;
        const changeId = randomUUID();
        for (const [resource, before, after] of [
          ['Treasury', Number(country.treasury), next.treasury],
          ['Manpower', country.manpower, next.manpower],
        ] as const) {
          if (before === after) continue;
          await insertResourceLedger(
            db,
            { gameId, quarterId: quarter.id, userId, kind: 'Setup' },
            {
              id: changeId,
              countryId: country.id,
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
          [gameId, country.id, next.treasury, next.manpower],
        );
        resourcesChanged = true;
      }
      if (resourcesChanged)
        await db.query(
          'UPDATE games SET current_world_version=current_world_version+1 WHERE id=$1',
          [gameId],
        );
    });
    return this.preview(gameId, userId);
  }
  async get(gameId: string, userId: string): Promise<EconomicRulesData> {
    const rows = await this.database.query<{
      role: string;
      state: string;
      economic_rules: EconomicRules;
      economic_rules_revision: number;
    }>(
      `SELECT gm.role,q.state,g.economic_rules,g.economic_rules_revision FROM games g
      JOIN game_members gm ON gm.game_id=g.id AND gm.user_id=$2 AND gm.status='Active'
      JOIN quarters q ON q.game_id=g.id AND q.is_current WHERE g.id=$1`,
      [gameId, userId],
    );
    const row = rows.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return {
      rules: {
        ...row.economic_rules,
        tradeCoefficient: row.economic_rules.tradeCoefficient ?? 0,
      },
      version: row.economic_rules_revision,
      canEdit:
        ['Host', 'Administrator'].includes(row.role) &&
        row.state === 'Preparing',
    };
  }
  async set(gameId: string, userId: string, input: SetEconomicRulesInput) {
    await mapTransaction(this.database, async (db) => {
      await requireMapHost(db, gameId, userId);
      const quarter = (
        await db.query<{ id: string; state: string }>(
          'SELECT id,state FROM quarters WHERE game_id=$1 AND is_current FOR UPDATE',
          [gameId],
        )
      ).rows[0];
      if (quarter?.state !== 'Preparing')
        throw new ApiFault(
          409,
          'ECONOMIC_RULES_LOCKED',
          '经济规则只能在回合准备阶段设置。',
        );
      const row = (
        await db.query<{
          economic_rules: EconomicRules;
          economic_rules_revision: number;
        }>(
          'SELECT economic_rules,economic_rules_revision FROM games WHERE id=$1 FOR UPDATE',
          [gameId],
        )
      ).rows[0]!;
      if (row.economic_rules_revision !== input.expectedVersion)
        throw new ApiFault(
          409,
          'ECONOMIC_RULES_VERSION_CONFLICT',
          '经济规则已变化，请取消编辑、刷新后核对。',
        );
      if (
        !validEconomicRules(input.rules) ||
        !input.reason.trim() ||
        input.reason.length > 2000
      )
        throw new ApiFault(
          400,
          'INVALID_ECONOMIC_RULES',
          '请填写非负系数与修改原因，数值最多两位小数。',
        );
      const next: EconomicRules = {
        enabled: input.rules.enabled,
        taxCoefficient: input.rules.taxCoefficient,
        productionCoefficient: input.rules.productionCoefficient,
        manpowerCoefficient: input.rules.manpowerCoefficient,
        armyMaintenancePer100: input.rules.armyMaintenancePer100,
        administrationCost: input.rules.administrationCost,
        tradeCoefficient:
          input.rules.tradeCoefficient ??
          row.economic_rules.tradeCoefficient ??
          0,
      };
      if (isDeepStrictEqual(row.economic_rules, next))
        throw new ApiFault(400, 'INVALID_ECONOMIC_RULES', '经济规则未变化。');
      await db.query(
        'UPDATE games SET economic_rules=$2::jsonb,economic_rules_revision=economic_rules_revision+1 WHERE id=$1',
        [gameId, JSON.stringify(next)],
      );
      await db.query(
        'INSERT INTO economic_rule_history(id,game_id,quarter_id,actor_user_id,previous_rules,next_rules,reason) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7)',
        [
          randomUUID(),
          gameId,
          quarter.id,
          userId,
          JSON.stringify(row.economic_rules),
          JSON.stringify(next),
          input.reason.trim(),
        ],
      );
    });
    return this.get(gameId, userId);
  }
}
