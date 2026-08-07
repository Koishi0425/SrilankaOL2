import { describe, expect, it } from 'vitest';

import {
  hideUnknownTile,
  projectArmy,
  type PerceivedArmyRow,
  type ViewContext,
} from './perception-service.js';

const army: PerceivedArmyRow = {
  id: 'army-1',
  tile_id: 'tile-1',
  name: 'Royal Guard',
  strength: 1200,
  status: 'Ready',
  country_id: 'country-a',
  perceived_name: 'Northern troops',
  perceived_country_id: 'country-a',
  strength_min: 900,
  strength_max: 1500,
  intelligence_confidence: 65,
  intelligence_world_version: '4',
  intelligence_outdated: false,
};

function view(
  access: ViewContext['access'],
  countryId: string | null,
): ViewContext {
  return { access, countryId, responseMode: access };
}

describe('player perception projection', () => {
  it('returns exact strength only to truth and the owning country', () => {
    expect(projectArmy(army, view('Truth', null))?.strength).toEqual({
      kind: 'Exact',
      value: 1200,
    });
    expect(projectArmy(army, view('Player', 'country-a'))?.strength).toEqual({
      kind: 'Exact',
      value: 1200,
    });
  });

  it('returns recorded ranges to informed enemy countries', () => {
    expect(projectArmy(army, view('Player', 'country-b'))).toMatchObject({
      name: 'Northern troops',
      strength: { kind: 'Range', min: 900, max: 1500 },
      confidence: 65,
      observedWorldVersion: 4,
    });
  });

  it('omits armies from public or uninformed views', () => {
    expect(projectArmy(army, view('Public', null))).toBeNull();
    expect(
      projectArmy(
        { ...army, strength_min: null, strength_max: null },
        view('Player', 'country-b'),
      ),
    ).toBeNull();
  });

  it('removes real geography and control from unknown tiles', () => {
    const hidden = hideUnknownTile(
      {
        id: 'tile-1',
        q: 1,
        r: 2,
        discoveryState: 'Observed',
        confidence: 100,
        observedWorldVersion: 4,
        terrainKey: 'forest',
        terrainName: '森林',
        terrainColor: '#5f8a62',
        regionId: 'region-1',
        regionName: 'North',
        controllerCountryId: 'country-a',
        controllerCountryName: 'A',
        controllerColor: '#ffffff',
        passable: true,
        movementCost: 2,
        cities: [
          { id: 'city-1', name: 'Secret', importance: 3, status: 'Normal' },
        ],
        armies: [],
      },
      'Unknown',
    );

    expect(hidden).toMatchObject({
      discoveryState: 'Unknown',
      terrainKey: null,
      terrainName: null,
      controllerCountryId: null,
      movementCost: null,
      cities: [],
    });
  });
});
