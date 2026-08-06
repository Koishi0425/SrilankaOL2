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
