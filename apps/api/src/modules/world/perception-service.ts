import type {
  DiscoveryState,
  MapArmyMarker,
  MapTileSummary,
} from '@srilanka/contracts';

export interface ViewContext {
  access: 'Truth' | 'Player' | 'Public';
  responseMode: 'Truth' | 'Player' | 'Public' | 'Preview';
  countryId: string | null;
}

export interface PerceivedArmyRow {
  id: string;
  tile_id: string;
  name: string;
  strength: number;
  status: string;
  country_id: string;
  perceived_name: string | null;
  perceived_country_id: string | null;
  strength_min: number | null;
  strength_max: number | null;
  intelligence_confidence: number | null;
  intelligence_world_version: string | null;
  intelligence_outdated: boolean | null;
}

export function discoveryFor(
  view: ViewContext,
  recorded: DiscoveryState | null,
): DiscoveryState {
  if (view.access === 'Truth') return 'Observed';
  if (view.access === 'Public') return 'Mapped';
  return recorded ?? 'Unknown';
}

export function hasStableGeography(state: DiscoveryState): boolean {
  return state === 'Mapped' || state === 'Observed' || state === 'Outdated';
}

export function hasCurrentState(state: DiscoveryState): boolean {
  return state === 'Observed';
}

export function projectArmy(
  row: PerceivedArmyRow,
  view: ViewContext,
): MapArmyMarker | null {
  const ownsArmy = view.countryId === row.country_id;
  if (view.access === 'Truth' || ownsArmy) {
    return {
      id: row.id,
      name: row.name,
      strength: { kind: 'Exact', value: row.strength },
      status: row.status,
      countryId: row.country_id,
      confidence: 100,
      observedWorldVersion: null,
      outdated: false,
    };
  }
  if (
    view.access !== 'Player' ||
    row.strength_min === null ||
    row.strength_max === null
  ) {
    return null;
  }
  return {
    id: row.id,
    name: row.perceived_name,
    strength: {
      kind: 'Range',
      min: row.strength_min,
      max: row.strength_max,
    },
    status: null,
    countryId: row.perceived_country_id,
    confidence: row.intelligence_confidence,
    observedWorldVersion:
      row.intelligence_world_version === null
        ? null
        : Number(row.intelligence_world_version),
    outdated: row.intelligence_outdated ?? false,
  };
}

export function hideUnknownTile(
  tile: MapTileSummary,
  state: DiscoveryState,
): MapTileSummary {
  const stable = hasStableGeography(state);
  const current = hasCurrentState(state);
  return {
    ...tile,
    discoveryState: state,
    terrainKey: stable ? tile.terrainKey : null,
    terrainName: stable ? tile.terrainName : null,
    terrainColor: stable ? tile.terrainColor : null,
    regionId: stable ? tile.regionId : null,
    regionName: stable ? tile.regionName : null,
    controllerCountryId: current ? tile.controllerCountryId : null,
    controllerCountryName: current ? tile.controllerCountryName : null,
    controllerColor: current ? tile.controllerColor : null,
    passable: stable ? tile.passable : null,
    movementCost: stable ? tile.movementCost : null,
    cities: stable ? tile.cities : [],
    armies: tile.armies,
  };
}
