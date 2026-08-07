export type DependencyStatus = 'up' | 'down';

export interface ResponseMeta {
  requestId: string;
  worldVersion?: number;
}

export interface ApiResponse<T> {
  data: T;
  meta: ResponseMeta;
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    retryable: boolean;
  };
  meta: ResponseMeta;
}

export interface HealthData {
  status: 'ok' | 'degraded';
  service: 'api';
  version: string;
  dependencies: {
    database: DependencyStatus;
    redis: DependencyStatus;
  };
}

export type HealthResponse = ApiResponse<HealthData>;

export type SystemRole = 'User' | 'Administrator';
export type GameRole = 'Host' | 'Player' | 'Observer' | 'Administrator';
export type GameStatus =
  'Preparing' | 'Running' | 'Paused' | 'Correcting' | 'Completed' | 'Archived';
export type Season = 'Spring' | 'Summer' | 'Autumn' | 'Winter';
export type QuarterState =
  | 'Preparing'
  | 'EventResponse'
  | 'ActionSubmission'
  | 'Locked'
  | 'HostReview'
  | 'AIProcessing'
  | 'Resolving'
  | 'PendingPublication'
  | 'Published'
  | 'DisputeReview'
  | 'Correcting'
  | 'Completed';

export interface CurrentUser {
  id: string;
  username: string;
  displayName: string;
  systemRole: SystemRole;
}

export interface MeData extends CurrentUser {
  games: GameSummary[];
  unreadNotificationCount: number;
}

export interface QuarterSummary {
  id: string;
  gameYear: number;
  season: Season;
  sequenceNumber: number;
  state: QuarterState;
  actionDeadline: string | null;
  currentWorldVersion: number;
}

export interface GameSummary {
  id: string;
  name: string;
  status: GameStatus;
  role: GameRole;
  currentQuarter: QuarterSummary;
}

export interface GameDetails extends GameSummary {
  allowNewPlayers: boolean;
  aiEnabled: boolean;
  createdAt: string;
}

export interface GameMemberSummary {
  id: string;
  userId: string;
  username: string;
  displayName: string;
  role: GameRole;
  status: 'Invited' | 'Active' | 'Left' | 'Suspended';
  controlledCountryId: string | null;
  controlledCountryName: string | null;
}

export interface CountrySummary {
  id: string;
  name: string;
  mapColor: string;
}

export interface MapMetadata {
  id: string;
  name: string;
  width: number;
  height: number;
  orientation: 'Pointy' | 'Flat';
  minZoom: number;
  maxZoom: number;
  currentWorldVersion: number;
  availableLayers: Array<'terrain' | 'control' | 'city' | 'army'>;
}

export interface MapCityMarker {
  id: string;
  name: string;
  importance: number;
  status: string;
}

export type DiscoveryState =
  'Unknown' | 'Rumored' | 'Discovered' | 'Mapped' | 'Observed' | 'Outdated';

export type ArmyStrengthKnowledge =
  | { kind: 'Exact'; value: number }
  | { kind: 'Range'; min: number; max: number }
  | { kind: 'Unknown' };

export interface MapArmyMarker {
  id: string;
  name: string | null;
  strength: ArmyStrengthKnowledge;
  status: string | null;
  countryId: string | null;
  confidence: number | null;
  observedWorldVersion: number | null;
  outdated: boolean;
}

export interface MapTileSummary {
  id: string;
  q: number;
  r: number;
  discoveryState: DiscoveryState;
  confidence: number | null;
  observedWorldVersion: number | null;
  terrainKey: string | null;
  terrainName: string | null;
  terrainColor: string | null;
  regionId: string | null;
  regionName: string | null;
  controllerCountryId: string | null;
  controllerCountryName: string | null;
  controllerColor: string | null;
  passable: boolean | null;
  movementCost: number | null;
  cities: MapCityMarker[];
  armies: MapArmyMarker[];
}

export interface MapViewportData {
  mapId: string;
  worldVersion: number;
  bounds: { minQ: number; maxQ: number; minR: number; maxR: number };
  viewMode: 'Truth' | 'Player' | 'Public' | 'Preview';
  viewCountryId: string | null;
  tiles: MapTileSummary[];
}

export interface TileDetails extends MapTileSummary {
  provinceName: string | null;
  legalOwnerCountryName: string | null;
  occupierCountryName: string | null;
  elevation: number | null;
  roadLevel: number | null;
  notes?: string;
}

export interface MapSearchResult {
  id: string;
  type: 'Tile' | 'Region' | 'City' | 'Army';
  name: string;
  tileId: string | null;
  q: number | null;
  r: number | null;
}
