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
  email: string;
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
  email: string;
  displayName: string;
  role: GameRole;
  status: 'Invited' | 'Active' | 'Left' | 'Suspended';
  controlledCountryId: string | null;
  controlledCountryName: string | null;
}

export interface CountrySummary {
  id: string;
  name: string;
}
