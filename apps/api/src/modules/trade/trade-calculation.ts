import type { TradeZoneSnapshot } from '@srilanka/contracts';
export function calculateTrade(
  zones: TradeZoneSnapshot[],
  coefficient: number,
  countries: Array<{ id: string; name: string }>,
) {
  const ids = new Set(countries.map((c) => c.id));
  return zones.map((zone) => {
    const valueCents =
      zone.provinces
        .filter((p) => p.tileCount > 0)
        .reduce((sum, p) => sum + BigInt(p.productionBase), 0n) *
      BigInt(Math.round(coefficient * 100));
    const powers = zone.influences
      .filter((i) => ids.has(i.countryId) && i.power > 0)
      .map((i) => ({ ...i, weight: BigInt(Math.round(i.power * 100)) }));
    const total = powers.reduce((sum, i) => sum + i.weight, 0n);
    const allocations = powers.map((i) => ({
      ...i,
      cents: total ? (valueCents * i.weight) / total : 0n,
      remainder: total ? (valueCents * i.weight) % total : 0n,
    }));
    if (total) {
      const remaining = Number(
        valueCents - allocations.reduce((sum, i) => sum + i.cents, 0n),
      );
      const order = [...allocations].sort((a, b) =>
        a.remainder === b.remainder
          ? a.countryId.localeCompare(b.countryId)
          : a.remainder > b.remainder
            ? -1
            : 1,
      );
      for (let i = 0; i < remaining; i++) order[i]!.cents += 1n;
    }
    return {
      zone,
      value: Number(valueCents) / 100,
      totalPower: Number(total) / 100,
      allocations: allocations.map((i) => ({
        countryId: i.countryId,
        power: i.power,
        amount: Number(i.cents) / 100,
      })),
    };
  });
}
