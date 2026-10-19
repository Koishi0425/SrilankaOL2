import { expect, it } from 'vitest';
import type { TradeZoneSnapshot } from '@srilanka/contracts';
import { calculateTrade } from './trade-calculation.js';
const countries = [
  { id: 'a', name: '北国' },
  { id: 'b', name: '南国' },
  { id: 'c', name: '山国' },
];
const zone: TradeZoneSnapshot = {
  id: 'zone',
  name: '海湾',
  revision: 0,
  provinces: [{ id: 'p', name: '北境', productionBase: 10, tileCount: 1 }],
  influences: [
    { countryId: 'a', power: 60 },
    { countryId: 'b', power: 40 },
  ],
};
it('uses regional production and apportions the full value by influence', () => {
  const result = calculateTrade([zone], 10, countries)[0]!;
  expect(result.value).toBe(100);
  expect(result.allocations.map((i) => i.amount)).toEqual([60, 40]);
});
it('conserves cents using deterministic largest remainders, independently of input order', () => {
  const shared = {
    ...zone,
    provinces: [{ ...zone.provinces[0]!, productionBase: 1 }],
    influences: [
      { countryId: 'c', power: 1 },
      { countryId: 'b', power: 1 },
      { countryId: 'a', power: 1 },
    ],
  };
  const first = calculateTrade([shared], 0.01, countries)[0]!,
    second = calculateTrade(
      [{ ...shared, influences: [...shared.influences].reverse() }],
      0.01,
      [...countries].reverse(),
    )[0]!;
  expect(first.allocations.reduce((n, i) => n + i.amount, 0)).toBe(0.01);
  expect(first.allocations.find((i) => i.countryId === 'a')!.amount).toBe(0.01);
  expect(
    new Map(first.allocations.map((i) => [i.countryId, i.amount])),
  ).toEqual(new Map(second.allocations.map((i) => [i.countryId, i.amount])));
});
it('excludes provinces without tiles, ignores inactive countries and leaves zero-influence pools unallocated', () => {
  const data = {
    ...zone,
    provinces: [
      ...zone.provinces,
      { ...zone.provinces[0]!, id: 'empty', productionBase: 999, tileCount: 0 },
    ],
    influences: [
      { countryId: 'other', power: 100 },
      { countryId: 'a', power: 0 },
    ],
  };
  const value = calculateTrade([data], 10, countries)[0]!;
  expect(value.value).toBe(100);
  expect(value.allocations).toEqual([]);
  expect(
    calculateTrade([zone], 0, countries)[0]!.allocations.every(
      (i) => i.amount === 0,
    ),
  ).toBe(true);
});
