import type { EconomicRules, EconomicSetupPreview } from '@srilanka/contracts';

export const openingUnitRules: EconomicRules = {
  enabled: true,
  taxCoefficient: 1,
  productionCoefficient: 1,
  manpowerCoefficient: 1,
  armyMaintenancePer100: 1,
  administrationCost: 0,
  tradeCoefficient: 0,
};
export const money = (value: number) =>
  Math.round((value + Number.EPSILON) * 100) / 100;
export function openingRulesKey(rules: EconomicRules | null) {
  return rules
    ? JSON.stringify([
        rules.enabled,
        rules.taxCoefficient,
        rules.productionCoefficient,
        rules.manpowerCoefficient,
        rules.armyMaintenancePer100,
        rules.administrationCost,
        rules.tradeCoefficient ?? 0,
      ])
    : '';
}
export function openingOutlook(
  country: EconomicSetupPreview['countries'][number],
  treasury = country.treasury,
) {
  const sum = (kinds: string[]) =>
    money(
      country.lines
        .filter((line) => kinds.includes(line.kind))
        .reduce((value, line) => value + line.calculatedAmount, 0),
    );
  const income = sum(['Tax', 'Production', 'Trade']);
  const maintenance = Math.abs(sum(['ArmyMaintenance']));
  const administration = Math.abs(sum(['Administration']));
  const net = money(income - maintenance - administration);
  return {
    income,
    maintenance,
    administration,
    net,
    manpowerGrowth: sum(['ManpowerGrowth']),
    afterFourQuarters: money(treasury + net * 4),
    runway:
      net < 0
        ? Math.max(
            0,
            Math.floor(Math.round(treasury * 100) / -Math.round(net * 100)),
          )
        : null,
  };
}

/** Calibrate a trial starting point against actual provinces and existing forces. */
export function openingReferenceRules(
  unit: EconomicSetupPreview,
  targetIncome: number,
): EconomicRules {
  const total = unit.countries.map((country) => openingOutlook(country));
  const income = total.reduce((sum, row) => sum + row.income, 0);
  const maintenance = total.reduce((sum, row) => sum + row.maintenance, 0);
  const budget = targetIncome * total.length;
  const coefficient = (value: number) =>
    Math.min(1_000_000, Math.max(0.01, money(value)));
  return {
    ...openingUnitRules,
    taxCoefficient: income > 0 ? coefficient(budget / income) : 1,
    productionCoefficient: income > 0 ? coefficient(budget / income) : 1,
    armyMaintenancePer100:
      maintenance > 0 ? coefficient((budget * 0.3) / maintenance) : 1,
    administrationCost: money(targetIncome * 0.1),
  };
}
