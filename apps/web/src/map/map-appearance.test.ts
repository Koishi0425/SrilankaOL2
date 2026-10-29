import { describe, expect, it } from 'vitest';
import type { MapTileSummary } from '@srilanka/contracts';
import { fogOpacity, terrainSymbol, tileAppearance } from './map-appearance.js';

const countries = [
  { id: 'north', name: '北国', mapColor: '#112233' },
  { id: 'south', name: '南国', mapColor: '#998877' },
];
const tile = {
  discoveryState: 'Observed',
  terrainKey: 'hills',
  terrainColor: '#ac8866',
  legalOwnerCountryId: 'north',
  legalOwnerCountryName: '北国',
  legalOwnerColor: '#112233',
  controllerCountryId: 'south',
  controllerCountryName: '南国',
  controllerColor: '#998877',
} as MapTileSummary;
describe('map modes and independent terrain symbols', () => {
  it('lights only the current detection area and keeps exchanged or old maps under fog', () => {
    for (const mode of ['political', 'terrain'] as const) {
      expect(fogOpacity(tile, mode)).toBe(0);
      for (const discoveryState of ['Mapped'] as const)
        expect(fogOpacity({ ...tile, discoveryState }, mode)).toBe(0.35);
      expect(
        fogOpacity({ ...tile, discoveryState: 'Unknown' }, mode),
      ).toBeGreaterThan(0.35);
    }
    expect(fogOpacity({ ...tile, discoveryState: 'Mapped' }, 'knowledge')).toBe(
      0,
    );
  });
  it('keeps the owner as the base color and overlays occupation without replacing terrain symbols', () => {
    expect(tileAppearance(tile, 'political', countries)).toEqual({
      color: '#112233',
      group: 'north',
      occupation: { color: '#998877', name: '南国' },
    });
    expect(tileAppearance(tile, 'terrain', countries).color).toBe('#ac8866');
    expect(tileAppearance(tile, 'terrain', countries).occupation).toBeNull();
    expect(tileAppearance(tile, 'knowledge', countries).occupation).toBeNull();
    expect(terrainSymbol(tile)?.name).toBe('丘陵');
  });
  it('does not mark territory controlled by its owner as occupied', () => {
    const home = {
      ...tile,
      controllerCountryId: 'north',
      controllerCountryName: '北国',
      controllerColor: '#112233',
    };
    expect(tileAppearance(home, 'political', countries).occupation).toBeNull();
    expect(
      tileAppearance(
        { ...home, legalOwnerCountryId: undefined, legalOwnerColor: undefined },
        'political',
        countries,
      ).occupation,
    ).toBeNull();
  });
  it('does not reveal control from states that cannot show political information', () => {
    for (const discoveryState of ['Unknown', 'Mapped'] as const) {
      const appearance = tileAppearance(
        { ...tile, discoveryState },
        'political',
        countries,
      );
      expect(appearance.group).toBeNull();
      expect(appearance.occupation).toBeNull();
    }
  });
  it('leaves plains blank and hides terrain marks in unknown or rumored areas', () => {
    expect(
      terrainSymbol({ terrainKey: 'plains', discoveryState: 'Observed' }),
    ).toBeNull();
    for (const state of ['Unknown'] as const) {
      expect(terrainSymbol({ ...tile, discoveryState: state })).toBeNull();
      expect(
        tileAppearance(
          { ...tile, discoveryState: state },
          'political',
          countries,
        ).group,
      ).toBeNull();
    }
    expect(terrainSymbol({ ...tile, terrainKey: 'mountains' })?.name).toBe(
      '山地',
    );
  });
  it('uses recorded ownership only when dynamic knowledge exists', () => {
    expect(
      tileAppearance(
        { ...tile, discoveryState: 'Mapped', dynamicKnown: true },
        'political',
        countries,
      ).group,
    ).toBe('north');
    expect(
      tileAppearance(
        { ...tile, discoveryState: 'Mapped', dynamicKnown: false },
        'political',
        countries,
      ).group,
    ).toBeNull();
    expect(
      tileAppearance(
        { ...tile, legalOwnerCountryId: undefined },
        'political',
        countries,
      ).occupation,
    ).toBeNull();
  });
});
