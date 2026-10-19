import { randomUUID } from 'node:crypto';
import type {
  EconomicBill,
  EconomicBillInput,
  EconomicLine,
  EconomicLineKind,
  EconomicRules,
  TradeZoneSnapshot,
  NationalPolicy,
} from '@srilanka/contracts';
import type { DatabaseClient } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { readTradeZones } from '../trade/trade-data.js';
import { calculateTrade } from '../trade/trade-calculation.js';
import { nationalPolicyStatus } from '@srilanka/contracts';
import { readNationalPolicies } from '../government/government-service.js';
import {
  validBalance,
  type StoredResourceChange,
  type ResourceRow,
} from './resources.js';
export const defaultEconomicRules: EconomicRules = {
  enabled: false,
  taxCoefficient: 0,
  productionCoefficient: 0,
  manpowerCoefficient: 0,
  armyMaintenancePer100: 0,
  administrationCost: 0,
  tradeCoefficient: 0,
};
export const economicKinds: EconomicLineKind[] = [
  'Tax',
  'Production',
  'ManpowerGrowth',
  'ArmyMaintenance',
  'Administration',
];
export const economicNames: Record<EconomicLineKind, string> = {
  Tax: '税收',
  Production: '生产收入',
  ManpowerGrowth: '人力恢复',
  ArmyMaintenance: '军队维护',
  Administration: '行政费',
  Trade: '贸易收入',
};
export interface EconomicSnapshot {
  capturedAt: string;
  worldVersion: number;
  rules: EconomicRules;
  rulesRevision: number;
  countries: Array<{ id: string; name: string }>;
  provinces: Array<{
    id: string;
    name: string;
    taxBase: number;
    productionBase: number;
    manpowerBase: number;
    autonomy: number;
    tileCount: number;
    eligible: Array<{ countryId: string; tileCount: number }>;
  }>;
  armies: Array<{
    id: string;
    name: string;
    countryId: string;
    strength: number;
  }>;
  trade?: TradeZoneSnapshot[];
  policies?: NationalPolicy[];
}
export interface StoredEconomicBill {
  bill: EconomicBill;
  costs: StoredResourceChange[];
  baselines: Record<string, StoredResourceChange['baseline']>;
}
export function economicBillInput(bill: EconomicBill): EconomicBillInput {
  return {
    lines: bill.lines.map(
      ({
        id,
        countryId,
        kind,
        amount,
        expectedResourceRevision,
        adjustmentReason,
      }) => ({
        id,
        countryId,
        kind,
        amount,
        expectedResourceRevision,
        adjustmentReason,
      }),
    ),
  };
}
export async function captureEconomicSnapshot(
  db: DatabaseClient,
  gameId: string,
  quarterId: string,
) {
  // Quarter is already locked by opening submissions. Match map → game lock order.
  await db.query('SELECT id FROM world_maps WHERE game_id=$1 FOR UPDATE', [
    gameId,
  ]);
  const game = (
    await db.query<{
      economic_rules: EconomicRules;
      economic_rules_revision: number;
      current_world_version: string;
    }>(
      'SELECT economic_rules,economic_rules_revision,current_world_version FROM games WHERE id=$1 FOR UPDATE',
      [gameId],
    )
  ).rows[0]!;
  const snapshot: EconomicSnapshot = {
    capturedAt: new Date().toISOString(),
    worldVersion: Number(game.current_world_version),
    rules: game.economic_rules,
    rulesRevision: game.economic_rules_revision,
    countries: [],
    provinces: [],
    armies: [],
  };
  if (snapshot.rules.enabled) {
    snapshot.countries = (
      await db.query<{ id: string; name: string }>(
        "SELECT id,name FROM countries WHERE game_id=$1 AND status='Active' ORDER BY created_at,id",
        [gameId],
      )
    ).rows;
    const profiles = (
      await db.query<{
        id: string;
        name: string;
        tax_base: number;
        production_base: number;
        manpower_base: number;
        autonomy: string;
      }>('SELECT * FROM provinces WHERE game_id=$1 ORDER BY name,id', [gameId])
    ).rows;
    const tiles = (
      await db.query<{
        province_id: string;
        legal_owner_country_id: string | null;
        controller_country_id: string | null;
      }>(
        'SELECT r.province_id,t.legal_owner_country_id,t.controller_country_id FROM hex_tiles t JOIN regions r ON r.game_id=t.game_id AND r.id=t.region_id WHERE t.game_id=$1 AND r.province_id IS NOT NULL',
        [gameId],
      )
    ).rows;
    const grouped = new Map<string, typeof tiles>();
    for (const tile of tiles) {
      const group = grouped.get(tile.province_id) ?? [];
      group.push(tile);
      grouped.set(tile.province_id, group);
    }
    snapshot.provinces = profiles.map((p) => {
      const group = grouped.get(p.id) ?? [],
        eligible = new Map<string, number>();
      for (const t of group)
        if (
          t.legal_owner_country_id &&
          t.legal_owner_country_id === t.controller_country_id
        )
          eligible.set(
            t.legal_owner_country_id,
            (eligible.get(t.legal_owner_country_id) ?? 0) + 1,
          );
      return {
        id: p.id,
        name: p.name,
        taxBase: p.tax_base,
        productionBase: p.production_base,
        manpowerBase: p.manpower_base,
        autonomy: Number(p.autonomy),
        tileCount: group.length,
        eligible: [...eligible].map(([countryId, tileCount]) => ({
          countryId,
          tileCount,
        })),
      };
    });
    snapshot.armies = (
      await db.query<{
        id: string;
        name: string;
        countryId: string;
        strength: number;
      }>(
        'SELECT id,name,country_id AS "countryId",strength FROM armies WHERE game_id=$1 ORDER BY name,id',
        [gameId],
      )
    ).rows;
    snapshot.trade = await readTradeZones(db, gameId);
    const sequence = (
      await db.query<{ sequence_number: number }>(
        'SELECT sequence_number FROM quarters WHERE game_id=$1 AND id=$2',
        [gameId, quarterId],
      )
    ).rows[0]!.sequence_number;
    snapshot.policies = (await readNationalPolicies(db, gameId)).filter(
      (p) => nationalPolicyStatus(p, sequence) === 'Active',
    );
  }
  await db.query(
    'UPDATE quarters SET economic_snapshot=$3::jsonb WHERE game_id=$1 AND id=$2 AND economic_snapshot IS NULL',
    [gameId, quarterId, JSON.stringify(snapshot)],
  );
}
function roundDivide(n: bigint, d: bigint) {
  return (n + d / 2n) / d;
}
function rate(value: number) {
  return BigInt(Math.round(value * 100));
}
export function calculateEconomy(
  snapshot: EconomicSnapshot,
): Array<
  Omit<
    EconomicLine,
    'id' | 'amount' | 'expectedResourceRevision' | 'adjustmentReason'
  >
> {
  const lines = [];
  const trade =
    (snapshot.rules.tradeCoefficient ?? 0) > 0 && snapshot.trade?.length
      ? calculateTrade(
          snapshot.trade,
          snapshot.rules.tradeCoefficient!,
          snapshot.countries,
        )
      : [];
  const kinds: EconomicLineKind[] = trade.length
    ? [
        'Tax',
        'Production',
        'ManpowerGrowth',
        'Trade',
        'ArmyMaintenance',
        'Administration',
      ]
    : economicKinds;
  for (const country of snapshot.countries)
    for (const kind of kinds) {
      const sources: EconomicLine['sources'] = [];
      if (
        kind === 'Tax' ||
        kind === 'Production' ||
        kind === 'ManpowerGrowth'
      ) {
        for (const p of snapshot.provinces) {
          const eligible =
            p.eligible.find((e) => e.countryId === country.id)?.tileCount ?? 0;
          if (!eligible || !p.tileCount) continue;
          const base =
            kind === 'Tax'
              ? p.taxBase
              : kind === 'Production'
                ? p.productionBase
                : p.manpowerBase;
          const coefficient =
            kind === 'Tax'
              ? snapshot.rules.taxCoefficient
              : kind === 'Production'
                ? snapshot.rules.productionCoefficient
                : snapshot.rules.manpowerCoefficient;
          const numerator =
            BigInt(base) *
            rate(coefficient) *
            (10000n - rate(p.autonomy)) *
            BigInt(eligible);
          const denominator = 10000n * BigInt(p.tileCount);
          // Monetary outputs round per province to cents; manpower floors per province/country.
          const amount =
            kind === 'ManpowerGrowth'
              ? Number(numerator / (denominator * 100n))
              : Number(roundDivide(numerator, denominator)) / 100;
          sources.push({
            name: p.name,
            calculation: `${base} × ${coefficient} × ${(100 - p.autonomy) / 100} × ${eligible}/${p.tileCount}`,
            amount,
          });
        }
      } else if (kind === 'Trade') {
        for (const item of trade) {
          const allocation = item.allocations.find(
            (i) => i.countryId === country.id,
          );
          if (allocation)
            sources.push({
              name: item.zone.name,
              calculation: `${item.value} × ${allocation.power}/${item.totalPower}（按分分配）`,
              amount: allocation.amount,
            });
        }
      } else if (kind === 'ArmyMaintenance') {
        for (const army of snapshot.armies.filter(
          (a) => a.countryId === country.id && a.strength > 0,
        )) {
          const amount =
            -Number(
              roundDivide(
                BigInt(army.strength) *
                  rate(snapshot.rules.armyMaintenancePer100),
                100n,
              ),
            ) / 100;
          sources.push({
            name: army.name,
            calculation: `${army.strength} ÷ 100 × ${snapshot.rules.armyMaintenancePer100}`,
            amount,
          });
        }
      } else
        sources.push({
          name: '每国每季行政费',
          calculation: String(snapshot.rules.administrationCost),
          amount: -snapshot.rules.administrationCost,
        });
      const resource =
        kind === 'ManpowerGrowth'
          ? ('Manpower' as const)
          : ('Treasury' as const);
      const scale = resource === 'Treasury' ? 100 : 1;
      const baseAmount =
        sources.reduce((sum, s) => sum + Math.round(s.amount * scale), 0) /
        scale;
      const policyEffects = (snapshot.policies ?? [])
        .filter(
          (p) => p.countryId === country.id && (p.effects[kind] ?? 0) !== 0,
        )
        .map((p) => ({
          policyId: p.id,
          title: p.title,
          percent: p.effects[kind]!,
        }));
      let calculatedAmount = baseAmount;
      if (policyEffects.length) {
        const sum = policyEffects.reduce(
            (total, p) => total + Math.round(p.percent * 100),
            0,
          ),
          factor = BigInt(Math.max(0, 10000 + sum));
        const original = BigInt(Math.round(Math.abs(baseAmount) * scale));
        const result =
          kind === 'ManpowerGrowth'
            ? (original * factor) / 10000n
            : roundDivide(original * factor, 10000n);
        calculatedAmount =
          result === 0n
            ? 0
            : (Number(result) / scale) * (baseAmount < 0 ? -1 : 1);
        sources.push({
          name: '长期政策合计',
          calculation: `${baseAmount} × ${Number(factor) / 10000} − ${baseAmount}（${policyEffects.map((p) => `${p.title}：${p.percent > 0 ? '+' : ''}${p.percent}%`).join('；')}${sum < -10000 ? '；合计低于 -100%，按零计算' : ''}）`,
          amount:
            (Math.round(calculatedAmount * scale) -
              Math.round(baseAmount * scale)) /
            scale,
        });
      }
      lines.push({
        countryId: country.id,
        countryName: country.name,
        kind,
        resource,
        calculatedAmount,
        sources,
        ...(policyEffects.length ? { baseAmount, policyEffects } : {}),
      });
    }
  return lines;
}
export async function previewEconomy(
  db: DatabaseClient,
  gameId: string,
  snapshot: EconomicSnapshot,
): Promise<EconomicBill> {
  const rows = (
    await db.query<ResourceRow>(
      'SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1',
      [gameId],
    )
  ).rows;
  const revisions = new Map(rows.map((r) => [r.id, r.resource_revision]));
  return {
    capturedAt: snapshot.capturedAt,
    worldVersion: snapshot.worldVersion,
    rules: snapshot.rules,
    rulesRevision: snapshot.rulesRevision,
    effects: [],
    ...(snapshot.policies?.length ? { policies: snapshot.policies } : {}),
    ...((snapshot.rules.tradeCoefficient ?? 0) > 0 && snapshot.trade?.length
      ? { trade: snapshot.trade }
      : {}),
    lines: calculateEconomy(snapshot).map((line) => ({
      ...line,
      id: randomUUID(),
      amount: line.calculatedAmount,
      expectedResourceRevision: revisions.get(line.countryId) ?? -1,
      adjustmentReason: '',
    })),
  };
}
export async function prepareEconomicBill(
  db: DatabaseClient,
  gameId: string,
  snapshot: EconomicSnapshot | null,
  input: EconomicBillInput | null,
  previous: StoredEconomicBill | null,
): Promise<StoredEconomicBill | null> {
  if (input === null) return null;
  if (!snapshot?.rules.enabled)
    throw new ApiFault(
      409,
      'ECONOMY_UNAVAILABLE',
      '本回合没有启用经济结算的期初快照。',
    );
  const expected = calculateEconomy(snapshot),
    byKey = new Map(expected.map((l) => [`${l.countryId}:${l.kind}`, l]));
  const old = new Map(previous?.bill.lines.map((l) => [l.id, l]) ?? []),
    keys = new Set<string>(),
    ids = new Set<string>();
  if (input.lines.length !== expected.length)
    throw new ApiFault(
      400,
      'INVALID_ECONOMIC_BILL',
      '账单必须包含期初各国的全部结算项目。',
    );
  await db.query('SELECT id FROM world_maps WHERE game_id=$1 FOR UPDATE', [
    gameId,
  ]);
  await db.query('SELECT id FROM games WHERE id=$1 FOR UPDATE', [gameId]);
  const rows = (
    await db.query<ResourceRow>(
      'SELECT id,name,treasury,manpower,resource_revision FROM countries WHERE game_id=$1 ORDER BY id FOR UPDATE',
      [gameId],
    )
  ).rows;
  const countries = new Map(rows.map((r) => [r.id, r]));
  if (
    (
      await db.query(
        'SELECT change_id FROM country_resource_ledger WHERE game_id=$1 AND change_id=ANY($2::uuid[])',
        [gameId, input.lines.map((l) => l.id)],
      )
    ).rowCount
  )
    throw new ApiFault(
      400,
      'INVALID_ECONOMIC_BILL',
      '账单标识已用于正式收支，请移除账单后重新生成。',
    );
  const baselines: StoredEconomicBill['baselines'] = {},
    lines: EconomicLine[] = [],
    costs: StoredResourceChange[] = [];
  for (const line of input.lines) {
    const key = `${line.countryId}:${line.kind}`,
      calculated = byKey.get(key),
      saved = old.get(line.id),
      row = countries.get(line.countryId);
    if (
      !calculated ||
      !row ||
      keys.has(key) ||
      ids.has(line.id) ||
      (saved &&
        (saved.countryId !== line.countryId || saved.kind !== line.kind))
    )
      throw new ApiFault(
        400,
        'INVALID_ECONOMIC_BILL',
        '账单包含重复标识、无效国家或项目，请重新生成。',
      );
    keys.add(key);
    ids.add(line.id);
    const retainsCountryLines = input.lines.some(
      (l) => l.countryId === line.countryId && old.has(l.id),
    );
    const prior = retainsCountryLines
      ? previous?.baselines[line.countryId]
      : undefined;
    if (
      line.expectedResourceRevision !== row.resource_revision ||
      (prior &&
        (prior.revision !== row.resource_revision ||
          prior.treasury !== Number(row.treasury) ||
          prior.manpower !== row.manpower))
    )
      throw new ApiFault(
        409,
        'RESOURCE_VERSION_CONFLICT',
        '国家余额已变化，请移除旧账单，核对余额后重新生成。',
        { countryId: line.countryId },
      );
    const baseline = prior ?? {
      treasury: Number(row.treasury),
      manpower: row.manpower,
      revision: row.resource_revision,
    };
    baselines[line.countryId] = baseline;
    const expense =
      line.kind === 'ArmyMaintenance' || line.kind === 'Administration';
    if (
      !Number.isFinite(line.amount) ||
      (calculated.resource === 'Treasury'
        ? !validBalance('Treasury', line.amount)
        : !validBalance('Manpower', line.amount)) ||
      (expense ? line.amount > 0 : line.amount < 0) ||
      line.adjustmentReason.length > 2000 ||
      (line.amount !== calculated.calculatedAmount &&
        !line.adjustmentReason.trim())
    )
      throw new ApiFault(
        400,
        'INVALID_ECONOMIC_BILL',
        '收入与恢复不能为负，维护费不能为正；修正数值时须填写原因。',
      );
    const full = {
      ...line,
      ...calculated,
      adjustmentReason: line.adjustmentReason.trim(),
    };
    lines.push(full);
    if (line.amount)
      costs.push({
        baseline,
        change: {
          id: line.id,
          actionId: null,
          countryId: line.countryId,
          countryName: calculated.countryName,
          expectedResourceRevision: line.expectedResourceRevision,
          resource: calculated.resource,
          amount: line.amount,
          reason:
            `每季经济结算 · ${economicNames[line.kind]}${full.adjustmentReason ? `（主持人修正：${full.adjustmentReason}）` : ''}`.slice(
              0,
              2000,
            ),
          before: 0,
          after: 0,
        },
      });
  }
  // Always use canonical country/item ordering; a client cannot reorder income behind deductions.
  lines.sort(
    (a, b) =>
      expected.findIndex(
        (l) => l.countryId === a.countryId && l.kind === a.kind,
      ) -
      expected.findIndex(
        (l) => l.countryId === b.countryId && l.kind === b.kind,
      ),
  );
  const ordered = lines.flatMap((l) =>
    costs.filter((c) => c.change.id === l.id),
  );
  return {
    baselines,
    costs: ordered,
    bill: {
      capturedAt: snapshot.capturedAt,
      worldVersion: snapshot.worldVersion,
      rules: snapshot.rules,
      rulesRevision: snapshot.rulesRevision,
      lines,
      effects: ordered.map((c) => c.change),
      ...(snapshot.policies?.length ? { policies: snapshot.policies } : {}),
      ...((snapshot.rules.tradeCoefficient ?? 0) > 0 && snapshot.trade?.length
        ? { trade: snapshot.trade }
        : {}),
    },
  };
}
