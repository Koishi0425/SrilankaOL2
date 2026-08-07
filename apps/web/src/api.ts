import type {
  ApiErrorBody,
  ApiResponse,
  CurrentUser,
  CountrySummary,
  GameDetails,
  GameMemberSummary,
  HealthResponse,
  MapMetadata,
  MapSearchResult,
  MapViewportData,
  MeData,
  TileDetails,
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
  username: string,
  password: string,
): Promise<CurrentUser> {
  return (
    await apiRequest<CurrentUser>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    })
  ).data;
}

export async function register(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<CurrentUser> {
  return (
    await apiRequest<CurrentUser>('/auth/register', {
      method: 'POST',
      body: JSON.stringify(input),
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
  input: { username: string; role: 'Player' | 'Observer' },
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

export async function fetchMap(gameId: string): Promise<MapMetadata> {
  return (await apiRequest<MapMetadata>(`/games/${gameId}/map`)).data;
}

export async function fetchMapViewport(
  gameId: string,
  bounds: { minQ: number; maxQ: number; minR: number; maxR: number },
  signal?: AbortSignal,
): Promise<MapViewportData> {
  const query = new URLSearchParams(
    Object.entries(bounds).map(([key, value]) => [key, String(value)]),
  );
  return (
    await apiRequest<MapViewportData>(
      `/games/${gameId}/map/viewport?${query}`,
      {
        signal,
      },
    )
  ).data;
}

export async function fetchTile(
  gameId: string,
  tileId: string,
): Promise<TileDetails> {
  return (await apiRequest<TileDetails>(`/games/${gameId}/tiles/${tileId}`))
    .data;
}

export async function searchMap(
  gameId: string,
  query: string,
): Promise<MapSearchResult[]> {
  return (
    await apiRequest<MapSearchResult[]>(
      `/games/${gameId}/map/search?q=${encodeURIComponent(query)}`,
    )
  ).data;
}

export async function updateTileControl(
  gameId: string,
  tileId: string,
  controllerCountryId: string | null,
): Promise<TileDetails> {
  return (
    await apiRequest<TileDetails>(`/games/${gameId}/tiles/${tileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controllerCountryId }),
    })
  ).data;
}

export async function createCity(
  gameId: string,
  input: { tileId: string; name: string; countryId?: string | null },
): Promise<TileDetails> {
  return (
    await apiRequest<TileDetails>(`/games/${gameId}/cities`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function createArmy(
  gameId: string,
  input: { tileId: string; name: string; countryId: string; strength: number },
): Promise<TileDetails> {
  return (
    await apiRequest<TileDetails>(`/games/${gameId}/armies`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function moveArmy(
  gameId: string,
  armyId: string,
  tileId: string,
): Promise<TileDetails> {
  return (
    await apiRequest<TileDetails>(
      `/games/${gameId}/armies/${armyId}/location`,
      {
        method: 'PATCH',
        body: JSON.stringify({ tileId }),
      },
    )
  ).data;
}
