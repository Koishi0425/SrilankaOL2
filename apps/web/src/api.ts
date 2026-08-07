import type {
  ApiErrorBody,
  ApiResponse,
  CurrentUser,
  CountrySummary,
  GameDetails,
  GameMemberSummary,
  HealthResponse,
  MeData,
} from '@srilanka/contracts';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      ...(init?.body ? { 'content-type': 'application/json' } : {}),
      ...init?.headers,
    },
  });

  if (!response.ok) {
    const body = (await response
      .json()
      .catch(() => null)) as ApiErrorBody | null;
    throw new ApiRequestError(
      response.status,
      body?.error.code ?? 'REQUEST_FAILED',
      body?.error.message ?? `请求失败（${response.status}）`,
    );
  }

  return (await response.json()) as ApiResponse<T>;
}

export async function fetchHealth(
  signal?: AbortSignal,
): Promise<HealthResponse> {
  return apiRequest('/health', { signal });
}

export async function fetchMe(): Promise<MeData> {
  return (await apiRequest<MeData>('/me')).data;
}

export async function login(
  email: string,
  password: string,
): Promise<CurrentUser> {
  return (
    await apiRequest<CurrentUser>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    })
  ).data;
}

export async function logout(): Promise<void> {
  await apiRequest('/auth/logout', { method: 'POST' });
}

export async function createGame(input: {
  name: string;
  countryNames: string[];
}): Promise<GameDetails> {
  return (
    await apiRequest<GameDetails>('/games', {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function fetchGame(gameId: string): Promise<GameDetails> {
  return (await apiRequest<GameDetails>(`/games/${gameId}`)).data;
}

export async function fetchCountries(
  gameId: string,
): Promise<CountrySummary[]> {
  return (await apiRequest<CountrySummary[]>(`/games/${gameId}/countries`))
    .data;
}

export async function fetchMembers(
  gameId: string,
): Promise<GameMemberSummary[]> {
  return (await apiRequest<GameMemberSummary[]>(`/games/${gameId}/members`))
    .data;
}

export async function addMember(
  gameId: string,
  input: { email: string; role: 'Player' | 'Observer' },
): Promise<GameMemberSummary> {
  return (
    await apiRequest<GameMemberSummary>(`/games/${gameId}/members`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function assignCountry(
  gameId: string,
  memberId: string,
  countryId: string,
): Promise<GameMemberSummary> {
  return (
    await apiRequest<GameMemberSummary>(
      `/games/${gameId}/country-assignments`,
      {
        method: 'POST',
        body: JSON.stringify({
          memberId,
          countryId,
          role: 'PrimaryController',
        }),
      },
    )
  ).data;
}
