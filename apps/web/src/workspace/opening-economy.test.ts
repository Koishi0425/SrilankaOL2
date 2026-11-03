import { expect, it } from 'vitest';
import type { EconomicSetupPreview } from '@srilanka/contracts';
import {
  openingOutlook,
  openingReferenceRules,
  openingRulesKey,
  openingUnitRules,
} from './opening-economy.js';

const country: EconomicSetupPreview['countries'][number] = {
  id: 'north',
  name: '北国',
  treasury: 100,
  manpower: 1000,
  armyStrength: 1000,
  resourceRevision: 0,
  lines: [
    { kind: 'Tax', calculatedAmount: 30, sources: [] },
    { kind: 'Production', calculatedAmount: 20, sources: [] },
    { kind: 'Trade', calculatedAmount: 10, sources: [] },
    { kind: 'ArmyMaintenance', calculatedAmount: -70, sources: [] },
    { kind: 'Administration', calculatedAmount: -10, sources: [] },
    { kind: 'ManpowerGrowth', calculatedAmount: 5, sources: [] },
  ],
};
it('separates cash from manpower and calculates the static deficit and reserve runway', () => {
  expect(openingOutlook(country)).toEqual({
    income: 60,
    maintenance: 70,
    administration: 10,
    net: -20,
    manpowerGrowth: 5,
    afterFourQuarters: 20,
    runway: 5,
  });
  expect(openingOutlook(country, 19).runway).toBe(0);
  expect(openingOutlook(country, -10).runway).toBe(0);
});
it('does not claim a finite exhaustion time for a nonnegative cash flow', () => {
  expect(
    openingOutlook({
      ...country,
      lines: country.lines.filter((line) => line.kind !== 'ArmyMaintenance'),
    }).runway,
  ).toBeNull();
});
it('compares rules independent of server JSON field order and an omitted zero trade coefficient', () => {
  const { tradeCoefficient: _trade, ...withoutTrade } = openingUnitRules;
  expect(openingRulesKey(withoutTrade)).toBe(
    openingRulesKey({ ...openingUnitRules, enabled: true }),
  );
});
it('calibrates a reference economy against real unit-rate income and maintenance without mutating it', () => {
  const unit: EconomicSetupPreview = {
    quarterId: 'q',
    preparationRevision: 'r',
    rules: openingUnitRules,
    rulesVersion: 0,
    worldVersion: 0,
    unconfiguredProvinceCount: 0,
    countries: [
      {
        ...country,
        lines: country.lines.filter((line) => line.kind !== 'Trade'),
      },
    ],
  };
  const before = structuredClone(unit);
  const rules = openingReferenceRules(unit, 100);
  expect(rules.taxCoefficient).toBe(2);
  expect(rules.productionCoefficient).toBe(2);
  expect(rules.armyMaintenancePer100).toBe(0.43);
  expect(rules.administrationCost).toBe(10);
  expect(unit).toEqual(before);
});
it('keeps an empty or zero-production setup finite instead of dividing by zero', () => {
  const empty: EconomicSetupPreview = {
    quarterId: 'q',
    preparationRevision: 'r',
    rules: openingUnitRules,
    rulesVersion: 0,
    worldVersion: 0,
    unconfiguredProvinceCount: 0,
    countries: [{ ...country, lines: [] }],
  };
  const result = openingReferenceRules(empty, 100);
  expect(result.taxCoefficient).toBe(1);
  expect(result.armyMaintenancePer100).toBe(1);
  expect(
    Object.values(result).every(
      (value) => typeof value === 'boolean' || Number.isFinite(value),
    ),
  ).toBe(true);
});
