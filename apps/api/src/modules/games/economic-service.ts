import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type {
  EconomicRules,
  EconomicRulesData,
  SetEconomicRulesInput,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { mapTransaction, requireMapHost } from '../world/map-mutations.js';
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
