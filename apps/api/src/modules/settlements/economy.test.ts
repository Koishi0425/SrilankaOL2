import { expect, it } from 'vitest';
import type { NationalPolicy } from '@srilanka/contracts';
import {
  calculateEconomy,
  defaultEconomicRules,
  type EconomicSnapshot,
} from './economy.js';
const snapshot: EconomicSnapshot = {
  capturedAt: '2026-10-13T00:00:00Z',
  worldVersion: 1,
  rulesRevision: 1,
  rules: {
    ...defaultEconomicRules,
    enabled: true,
    taxCoefficient: 0.01,
    productionCoefficient: 0.01,
    manpowerCoefficient: 1.5,
    armyMaintenancePer100: 0.5,
  },
  countries: [{ id: 'north', name: '北国' }],
  provinces: [
    {
      id: 'province',
      name: '边境',
      taxBase: 1,
      productionBase: 1,
      manpowerBase: 3,
      autonomy: 50,
      tileCount: 2,
      eligible: [{ countryId: 'north', tileCount: 1 }],
    },
  ],
  armies: [{ id: 'army', name: '北军', countryId: 'north', strength: 1 }],
};
it('rounds cents exactly at half-cent thresholds and floors fractional manpower', () => {
  const data = {
    ...snapshot,
    provinces: [{ ...snapshot.provinces[0]!, tileCount: 1 }],
  };
  expect(calculateEconomy(data).map((l) => l.calculatedAmount)).toEqual([
    0.01, 0.01, 2, -0.01, 0,
  ]);
});
it('counts only matching legal/control shares and ignores foreign armies and empty provinces', () => {
  const data = {
    ...snapshot,
    provinces: [
      ...snapshot.provinces,
      { ...snapshot.provinces[0]!, id: 'empty', tileCount: 0, eligible: [] },
    ],
    armies: [
      ...snapshot.armies,
      { id: 'enemy', name: '敌军', countryId: 'other', strength: 1000 },
    ],
  };
  const lines = calculateEconomy(data);
  expect(lines.map((l) => l.calculatedAmount)).toEqual([0, 0, 1, -0.01, 0]);
  expect(lines[3]!.sources).toHaveLength(1);
});
const policy = (
  effects: NationalPolicy['effects'],
  countryId = 'north',
): NationalPolicy => ({
  id: crypto.randomUUID(),
  countryId,
  countryName: countryId,
  title: '税制改革',
  type: 'Reform',
  text: '调整税收和维护费',
  effects,
  startsAt: { gameYear: 1, season: 'Spring', sequenceNumber: 1 },
  expiresAt: null,
  endedAt: null,
});
it('adds percentages once after base rounding, floors manpower and discounts expense magnitudes', () => {
  const data = {
    ...snapshot,
    rules: {
      ...snapshot.rules,
      taxCoefficient: 10,
      productionCoefficient: 1,
      manpowerCoefficient: 10,
      armyMaintenancePer100: 1,
      administrationCost: 2,
    },
    provinces: [{ ...snapshot.provinces[0]!, tileCount: 1 }],
    armies: [{ ...snapshot.armies[0]!, strength: 1000 }],
    policies: [
      policy({
        Tax: -10,
        Production: 50,
        ManpowerGrowth: 10,
        ArmyMaintenance: -20,
        Administration: 50,
      }),
      policy({ Tax: 30, ManpowerGrowth: 5 }),
      policy({ Tax: 1000 }, 'other'),
    ],
  };
  const lines = calculateEconomy(data);
  expect(lines.map((l) => l.calculatedAmount)).toEqual([6, 0.75, 17, -8, -3]);
  expect(lines[0]!.baseAmount).toBe(5);
  expect(lines[0]!.policyEffects).toHaveLength(2);
  expect(lines[0]!.sources.map((s) => s.amount)).toEqual([5, 1]);
});
it('rounds fractional cents exactly and floors combined penalties at zero without changing legacy lines', () => {
  const data = {
    ...snapshot,
    provinces: [{ ...snapshot.provinces[0]!, tileCount: 1 }],
    policies: [
      policy({ Tax: 50, Production: -80, ArmyMaintenance: -80 }),
      policy({ Production: -80, ArmyMaintenance: -80 }),
    ],
  };
  const lines = calculateEconomy(data);
  expect(lines.map((l) => l.calculatedAmount)).toEqual([0.02, 0, 2, 0, 0]);
  expect(lines[1]!.sources.at(-1)?.calculation).toContain('合计低于 -100%');
  expect(calculateEconomy({ ...data, policies: undefined })).toEqual(
    calculateEconomy({ ...data, policies: [] }),
  );
});
