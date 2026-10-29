import type {
  AssistantStatus,
  AssistantInput,
  AssistantResult,
  GlobalAssistantSettings,
  SaveGlobalAssistantSettings,
  AssistantConnectionTest,
  ActionCategory,
  AuthOptions,
  AccountAccessCode,
  AccountSecurityEvent,
  ActionDetails,
  ActionObjectRef,
  ActionSecrecy,
  ActionSummary,
  ActionVersion,
  RoundPolicy,
  RoundPolicySummary,
  SaveRoundPolicyInput,
  ReviewRoundPolicyInput,
  ApiErrorBody,
  ApiResponse,
  CurrentUser,
  CountrySummary,
  GameDetails,
  EndGameInput,
  GamePreparation,
  GameRulesData,
  GameMemberSummary,
  HealthResponse,
  MapMetadata,
  MapObjectLocation,
  MapBatchInput,
  MapKnowledgeInput,
  MapSetupData,
  CreateMapInput,
  MapGenerationOptions,
  TileTagChange,
  MapRevealPlan,
  MapHistoryEntry,
  MapSearchResult,
  MapViewportData,
  MapTileContext,
  ConversationMessage,
  ConversationSummary,
  MessagePage,
  MeData,
  TileDetails,
  QuarterSummary,
  QuarterSettlement,
  CorrectSettlementInput,
  SettlementCorrectionOptions,
  SaveSettlementInput,
  SettlementSummary,
  SettlementStateOptions,
  BattleRollInput,
  NationalStatus,
  CountryLedgerPage,
  SetCountryBalancesInput,
  ProvinceData,
  SetProvinceInput,
  EconomicRulesData,
  SetEconomicRulesInput,
  EconomicBill,
  TradeData,
  SetTradeZoneInput,
  DiplomacyData,
  DiplomacyChangeInput,
  GovernmentData,
  GovernmentChangeInput,
} from '@srilanka/contracts';

const apiBaseUrl = import.meta.env.VITE_API_BASE_URL ?? '/api/v1';

export async function fetchGlobalAssistantSettings() {
  return (await apiRequest<GlobalAssistantSettings>('/admin/assistant')).data;
}
export async function saveGlobalAssistantSettings(
  input: SaveGlobalAssistantSettings,
) {
  return (
    await apiRequest<GlobalAssistantSettings>('/admin/assistant', {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function testGlobalAssistantConnection() {
  return (
    await apiRequest<AssistantConnectionTest>('/admin/assistant/test', {
      method: 'POST',
    })
  ).data;
}

export async function fetchAssistantStatus(
  gameId: string,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<AssistantStatus>(`/games/${gameId}/assistant`, { signal })
  ).data;
}
export async function configureAssistant(
  gameId: string,
  enabled: boolean,
  expectedEnabled: boolean,
) {
  return (
    await apiRequest<AssistantStatus>(`/games/${gameId}/assistant`, {
      method: 'PUT',
      body: JSON.stringify({ enabled, expectedEnabled }),
    })
  ).data;
}
export async function generateAssistantResult(
  gameId: string,
  input: AssistantInput,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<AssistantResult>(`/games/${gameId}/assistant/generate`, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    })
  ).data;
}

export async function locateMapReference(
  gameId: string,
  objectType: 'Tile' | 'Province',
  objectId: string,
  options: { previewMemberId?: string; signal?: AbortSignal } = {},
): Promise<MapObjectLocation> {
  const query = new URLSearchParams({ objectType, objectId });
  if (options.previewMemberId)
    query.set('previewMemberId', options.previewMemberId);
  return (
    await apiRequest<MapObjectLocation>(
      `/games/${gameId}/map/locate?${query}`,
      { signal: options.signal },
    )
  ).data;
}
export async function fetchGovernment(
  gameId: string,
  countryId?: string,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<GovernmentData>(
      `/games/${gameId}/government${countryId ? `?countryId=${countryId}` : ''}`,
      { signal },
    )
  ).data;
}
export async function setupGovernment(
  gameId: string,
  changes: GovernmentChangeInput[],
) {
  return (
    await apiRequest<GovernmentData>(`/games/${gameId}/government`, {
      method: 'PUT',
      body: JSON.stringify({ changes }),
    })
  ).data;
}
export async function fetchDiplomacy(gameId: string, signal?: AbortSignal) {
  return (
    await apiRequest<DiplomacyData>(`/games/${gameId}/diplomacy`, { signal })
  ).data;
}
export async function setupDiplomacy(
  gameId: string,
  changes: DiplomacyChangeInput[],
) {
  return (
    await apiRequest<DiplomacyData>(`/games/${gameId}/diplomacy`, {
      method: 'PUT',
      body: JSON.stringify({ changes }),
    })
  ).data;
}
export async function fetchTrade(
  gameId: string,
  countryId: string,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<TradeData>(
      `/games/${gameId}/trade?countryId=${countryId}`,
      { signal },
    )
  ).data;
}
export async function setTradeZone(
  gameId: string,
  zoneId: string,
  input: SetTradeZoneInput,
) {
  return (
    await apiRequest<{ id: string; revision: number }>(
      `/games/${gameId}/trade-zones/${zoneId}`,
      { method: 'PUT', body: JSON.stringify(input) },
    )
  ).data;
}

export async function fetchEconomicRules(gameId: string, signal?: AbortSignal) {
  return (
    await apiRequest<EconomicRulesData>(`/games/${gameId}/economic-rules`, {
      signal,
    })
  ).data;
}
export async function saveEconomicRules(
  gameId: string,
  input: SetEconomicRulesInput,
) {
  return (
    await apiRequest<EconomicRulesData>(`/games/${gameId}/economic-rules`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function fetchEconomicPreview(
  gameId: string,
  quarterId: string,
  expectedVersion: number,
) {
  return (
    await apiRequest<EconomicBill>(
      `/games/${gameId}/quarters/${quarterId}/settlement/economy?expectedVersion=${expectedVersion}`,
    )
  ).data;
}

export async function fetchProvinces(gameId: string, signal?: AbortSignal) {
  return (
    await apiRequest<ProvinceData>(`/games/${gameId}/provinces`, { signal })
  ).data;
}
export async function setProvince(
  gameId: string,
  provinceId: string,
  input: SetProvinceInput,
) {
  return (
    await apiRequest<ProvinceData>(`/games/${gameId}/provinces/${provinceId}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function fetchNationalStatus(
  gameId: string,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<NationalStatus>(`/games/${gameId}/national-status`, {
      signal,
    })
  ).data;
}
export async function fetchCountryLedger(
  gameId: string,
  countryId: string,
  before?: string,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<CountryLedgerPage>(
      `/games/${gameId}/countries/${countryId}/ledger${before ? `?before=${encodeURIComponent(before)}` : ''}`,
      { signal },
    )
  ).data;
}
export async function setCountryBalances(
  gameId: string,
  countryId: string,
  input: SetCountryBalancesInput,
) {
  return (
    await apiRequest<NationalStatus>(
      `/games/${gameId}/countries/${countryId}/balances`,
      { method: 'PUT', body: JSON.stringify(input) },
    )
  ).data;
}

export async function rollSettlementBattle(
  gameId: string,
  quarterId: string,
  battleId: string,
  input: BattleRollInput,
) {
  return (
    await apiRequest<QuarterSettlement>(
      `/games/${gameId}/quarters/${quarterId}/settlement/battles/${battleId}/roll`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  ).data;
}

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

let sessionGeneration = 0;
const expiredListeners = new Set<() => void>();
export function beginSession() {
  sessionGeneration++;
}
export function onSessionExpired(listener: () => void) {
  expiredListeners.add(listener);
  return () => {
    expiredListeners.delete(listener);
  };
}

async function apiRequest<T>(
  path: string,
  init?: RequestInit,
): Promise<ApiResponse<T>> {
  const generation = sessionGeneration;
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
    if (
      response.status === 401 &&
      body?.error.code === 'UNAUTHENTICATED' &&
      generation === sessionGeneration &&
      !['/auth/login', '/auth/register', '/auth/password-reset'].includes(path)
    ) {
      for (const listener of expiredListeners) listener();
    }
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
  inviteCode?: string;
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

export async function fetchAuthOptions(): Promise<AuthOptions> {
  return (await apiRequest<AuthOptions>('/auth/options')).data;
}
export async function changePassword(
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  await apiRequest('/auth/password', {
    method: 'POST',
    body: JSON.stringify({ currentPassword, newPassword }),
  });
}
export async function redeemPasswordReset(
  username: string,
  code: string,
  newPassword: string,
): Promise<void> {
  await apiRequest('/auth/password-reset', {
    method: 'POST',
    body: JSON.stringify({ username, code, newPassword }),
  });
}
export async function issuePasswordReset(
  gameId: string,
  memberId: string,
  currentPassword: string,
  reason: string,
): Promise<AccountAccessCode> {
  return (
    await apiRequest<AccountAccessCode>(
      `/games/${gameId}/members/${memberId}/password-reset`,
      { method: 'POST', body: JSON.stringify({ currentPassword, reason }) },
    )
  ).data;
}
export async function createRegistrationInvitation(
  gameId: string,
  currentPassword: string,
): Promise<AccountAccessCode> {
  return (
    await apiRequest<AccountAccessCode>(
      `/games/${gameId}/registration-invitations`,
      { method: 'POST', body: JSON.stringify({ currentPassword }) },
    )
  ).data;
}
export async function fetchAccountHistory(
  gameId: string,
): Promise<AccountSecurityEvent[]> {
  return (
    await apiRequest<AccountSecurityEvent[]>(`/games/${gameId}/account-history`)
  ).data;
}

export async function createGame(input: {
  name: string;
  countryNames: string[];
  creationId?: string;
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

export async function endGame(
  gameId: string,
  input: EndGameInput,
): Promise<GameDetails> {
  return (
    await apiRequest<GameDetails>(`/games/${gameId}/end`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function fetchPreparation(gameId: string, signal?: AbortSignal) {
  return (
    await apiRequest<GamePreparation>(`/games/${gameId}/preparation`, {
      signal,
    })
  ).data;
}

export async function openFirstQuarter(
  gameId: string,
  input: { quarterId: string; expectedRevision: string },
) {
  return (
    await apiRequest<QuarterSummary>(`/games/${gameId}/preparation/open`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function fetchGameRules(gameId: string): Promise<GameRulesData> {
  return (await apiRequest<GameRulesData>(`/games/${gameId}/rules`)).data;
}

export async function saveGameRules(
  gameId: string,
  rules: GameRulesData,
): Promise<GameRulesData> {
  return (
    await apiRequest<GameRulesData>(`/games/${gameId}/rules`, {
      method: 'PUT',
      body: JSON.stringify({
        quarterId: rules.quarterId,
        expectedVersion: rules.version,
        scenario: rules.scenario,
        quarter: rules.quarter,
      }),
    })
  ).data;
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
  countryId: string | null,
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
  previewMemberId?: string,
): Promise<MapViewportData> {
  const query = new URLSearchParams(
    Object.entries(bounds).map(([key, value]) => [key, String(value)]),
  );
  if (previewMemberId) query.set('previewMemberId', previewMemberId);
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
  previewMemberId?: string,
): Promise<TileDetails> {
  const query = previewMemberId
    ? `?previewMemberId=${encodeURIComponent(previewMemberId)}`
    : '';
  return (
    await apiRequest<TileDetails>(`/games/${gameId}/tiles/${tileId}${query}`)
  ).data;
}

export async function fetchTileContext(
  gameId: string,
  tileId: string,
  options: {
    previewMemberId?: string;
    countryId?: string;
    signal?: AbortSignal;
  } = {},
): Promise<MapTileContext> {
  const query = new URLSearchParams();
  if (options.previewMemberId)
    query.set('previewMemberId', options.previewMemberId);
  if (options.countryId) query.set('countryId', options.countryId);
  return (
    await apiRequest<MapTileContext>(
      `/games/${gameId}/tiles/${tileId}/context?${query}`,
      { signal: options.signal },
    )
  ).data;
}

export async function searchMap(
  gameId: string,
  query: string,
  previewMemberId?: string,
): Promise<MapSearchResult[]> {
  const parameters = new URLSearchParams({ q: query });
  if (previewMemberId) parameters.set('previewMemberId', previewMemberId);
  return (
    await apiRequest<MapSearchResult[]>(
      `/games/${gameId}/map/search?${parameters}`,
    )
  ).data;
}

export async function updateTileControl(
  gameId: string,
  tileId: string,
  controllerCountryId: string | null,
  correction: { correctionReason?: string; expectedRevision?: number } = {},
): Promise<TileDetails> {
  return (
    await apiRequest<TileDetails>(`/games/${gameId}/tiles/${tileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ controllerCountryId, ...correction }),
    })
  ).data;
}

export async function createCity(
  gameId: string,
  input: {
    tileId: string;
    name: string;
    countryId?: string | null;
    correctionReason?: string;
    expectedRevision?: number;
  },
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
  input: {
    tileId: string;
    name: string;
    countryId: string;
    strength: number;
    correctionReason?: string;
    expectedRevision?: number;
  },
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
  correction: { correctionReason?: string; expectedRevision?: number } = {},
): Promise<TileDetails> {
  return (
    await apiRequest<TileDetails>(
      `/games/${gameId}/armies/${armyId}/location`,
      {
        method: 'PATCH',
        body: JSON.stringify({ tileId, ...correction }),
      },
    )
  ).data;
}

export async function fetchActions(
  gameId: string,
  hostQueue = false,
): Promise<ActionSummary[]> {
  const path = hostQueue
    ? `/games/${gameId}/host/actions/review-queue`
    : `/games/${gameId}/actions`;
  return (await apiRequest<ActionSummary[]>(path)).data;
}

export async function fetchRoundPolicies(gameId: string, quarterId: string) {
  return (
    await apiRequest<RoundPolicySummary[]>(
      `/games/${gameId}/quarters/${quarterId}/policy-submissions`,
    )
  ).data;
}
export async function fetchMyRoundPolicy(gameId: string, quarterId: string) {
  return (
    await apiRequest<RoundPolicy>(
      `/games/${gameId}/quarters/${quarterId}/my-policy`,
    )
  ).data;
}
export async function fetchRoundPolicy(
  gameId: string,
  policy: RoundPolicySummary,
  signal?: AbortSignal,
) {
  return (
    await apiRequest<RoundPolicy>(
      `/games/${gameId}/quarters/${policy.quarterId}/policy-submissions/${policy.memberId}?countryId=${policy.countryId}`,
      { signal },
    )
  ).data;
}
export async function fetchRoundPolicyForAction(
  gameId: string,
  actionId: string,
) {
  return (
    await apiRequest<RoundPolicy>(
      `/games/${gameId}/actions/${actionId}/round-policy`,
    )
  ).data;
}
export async function saveRoundPolicy(
  gameId: string,
  quarterId: string,
  input: SaveRoundPolicyInput,
) {
  return (
    await apiRequest<RoundPolicy>(
      `/games/${gameId}/quarters/${quarterId}/my-policy`,
      { method: 'PUT', body: JSON.stringify(input) },
    )
  ).data;
}
export async function reviewRoundPolicy(
  gameId: string,
  policy: RoundPolicySummary,
  input: ReviewRoundPolicyInput,
) {
  return (
    await apiRequest<RoundPolicy>(
      `/games/${gameId}/quarters/${policy.quarterId}/policy-submissions/${policy.memberId}/review?countryId=${policy.countryId}`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  ).data;
}

export async function fetchAction(gameId: string, actionId: string) {
  return (
    await apiRequest<ActionDetails>(`/games/${gameId}/actions/${actionId}`)
  ).data;
}

export async function createAction(
  gameId: string,
  input: {
    creationId?: string;
    quarterId: string;
    title: string;
    originalText: string;
    category: ActionCategory;
    secrecy: ActionSecrecy;
    refs: Array<Omit<ActionObjectRef, 'id'>>;
  },
) {
  return (
    await apiRequest<ActionDetails>(`/games/${gameId}/actions`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function updateAction(
  gameId: string,
  actionId: string,
  input: {
    expectedVersion: number;
    title: string;
    originalText: string;
    category: ActionCategory;
    secrecy: ActionSecrecy;
    refs: Array<Omit<ActionObjectRef, 'id'>>;
  },
) {
  return (
    await apiRequest<ActionDetails>(`/games/${gameId}/actions/${actionId}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function submitAction(gameId: string, actionId: string) {
  return (
    await apiRequest<ActionDetails>(
      `/games/${gameId}/actions/${actionId}/submit`,
      {
        method: 'POST',
        body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
      },
    )
  ).data;
}

export async function withdrawAction(gameId: string, actionId: string) {
  return (
    await apiRequest<ActionDetails>(
      `/games/${gameId}/actions/${actionId}/withdraw`,
      { method: 'POST' },
    )
  ).data;
}

export async function fetchActionVersions(gameId: string, actionId: string) {
  return (
    await apiRequest<ActionVersion[]>(
      `/games/${gameId}/actions/${actionId}/versions`,
    )
  ).data;
}

export async function saveActionVersion(
  gameId: string,
  actionId: string,
  expectedVersion: number,
) {
  return (
    await apiRequest<ActionVersion[]>(
      `/games/${gameId}/actions/${actionId}/versions`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedVersion }),
      },
    )
  ).data;
}

export async function hostInterpretAction(
  gameId: string,
  actionId: string,
  text: string,
) {
  return (
    await apiRequest<ActionDetails>(
      `/games/${gameId}/host/actions/${actionId}/interpretations`,
      { method: 'POST', body: JSON.stringify({ text }) },
    )
  ).data;
}

export async function hostDecideAction(
  gameId: string,
  actionId: string,
  decision: 'request-input' | 'approve' | 'reject',
  reason: string,
) {
  return (
    await apiRequest<ActionDetails>(
      `/games/${gameId}/host/actions/${actionId}/${decision}`,
      { method: 'POST', body: JSON.stringify({ reason }) },
    )
  ).data;
}

export async function transitionQuarter(
  gameId: string,
  state: 'ActionSubmission' | 'Locked' | 'HostReview',
  actionDeadline?: string | null,
) {
  return (
    await apiRequest<QuarterSummary>(
      `/games/${gameId}/quarters/current/state`,
      {
        method: 'PATCH',
        body: JSON.stringify({ state, actionDeadline }),
      },
    )
  ).data;
}

export async function fetchSettlements(gameId: string) {
  return (await apiRequest<SettlementSummary[]>(`/games/${gameId}/settlements`))
    .data;
}

export async function fetchSettlement(gameId: string, quarterId: string) {
  return (
    await apiRequest<QuarterSettlement>(
      `/games/${gameId}/quarters/${quarterId}/settlement`,
    )
  ).data;
}

export async function fetchCorrectionOptions(
  gameId: string,
  quarterId: string,
) {
  return (
    await apiRequest<SettlementCorrectionOptions>(
      `/games/${gameId}/quarters/${quarterId}/settlement/corrections/options`,
    )
  ).data;
}

export async function correctSettlement(
  gameId: string,
  quarterId: string,
  input: CorrectSettlementInput,
) {
  return (
    await apiRequest<QuarterSettlement>(
      `/games/${gameId}/quarters/${quarterId}/settlement/corrections`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  ).data;
}

export async function beginSettlement(gameId: string, quarterId: string) {
  return (
    await apiRequest<QuarterSettlement>(
      `/games/${gameId}/quarters/${quarterId}/settlement/begin`,
      { method: 'POST' },
    )
  ).data;
}

export async function saveSettlement(
  gameId: string,
  quarterId: string,
  input: SaveSettlementInput,
) {
  return (
    await apiRequest<QuarterSettlement>(
      `/games/${gameId}/quarters/${quarterId}/settlement`,
      { method: 'PUT', body: JSON.stringify(input) },
    )
  ).data;
}

export async function fetchSettlementStateOptions(
  gameId: string,
  quarterId: string,
) {
  return (
    await apiRequest<SettlementStateOptions>(
      `/games/${gameId}/quarters/${quarterId}/settlement/options`,
    )
  ).data;
}

export async function publishSettlement(
  gameId: string,
  quarterId: string,
  expectedVersion: number,
  expectedMapRevision?: number,
) {
  return (
    await apiRequest<QuarterSettlement>(
      `/games/${gameId}/quarters/${quarterId}/settlement/publish`,
      {
        method: 'POST',
        body: JSON.stringify({ expectedVersion, expectedMapRevision }),
      },
    )
  ).data;
}

export async function fetchMapSetup(gameId: string) {
  return (await apiRequest<MapSetupData>(`/games/${gameId}/map/setup`)).data;
}
export async function createMap(gameId: string, input: CreateMapInput) {
  return (
    await apiRequest<MapSetupData>(`/games/${gameId}/map`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function generateMapTerrain(
  gameId: string,
  input: MapGenerationOptions & { expectedRevision: number },
) {
  return (
    await apiRequest<MapSetupData>(`/games/${gameId}/map/generate`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function changeTileTags(
  gameId: string,
  input: TileTagChange & {
    expectedRevision: number;
    correctionReason?: string;
  },
) {
  return (
    await apiRequest<MapSetupData>(`/games/${gameId}/map/tags`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function batchMapTiles(gameId: string, input: MapBatchInput) {
  return (
    await apiRequest<MapSetupData>(`/games/${gameId}/map/tiles`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function revealMapKnowledge(
  gameId: string,
  input: MapKnowledgeInput,
) {
  return (
    await apiRequest<MapSetupData>(`/games/${gameId}/map/knowledge`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}
export async function initializeMapKnowledge(
  gameId: string,
  input: {
    expectedRevision: number;
    countryId: string;
    mode: 'OwnTerritory' | 'Geography' | 'Unknown';
  },
) {
  return (
    await apiRequest<MapSetupData>(
      `/games/${gameId}/map/knowledge/initialize`,
      { method: 'POST', body: JSON.stringify(input) },
    )
  ).data;
}
export async function fetchMapReveal(gameId: string, actionId: string) {
  return (
    await apiRequest<MapRevealPlan | null>(
      `/games/${gameId}/actions/${actionId}/map-reveal`,
    )
  ).data;
}
export async function removeMapReveal(
  gameId: string,
  actionId: string,
  expectedRevision: number,
) {
  return (
    await apiRequest<MapSetupData>(
      `/games/${gameId}/actions/${actionId}/map-reveal`,
      { method: 'DELETE', body: JSON.stringify({ expectedRevision }) },
    )
  ).data;
}
export async function fetchMapHistory(
  gameId: string,
  previewMemberId?: string,
) {
  return (
    await apiRequest<MapHistoryEntry[]>(
      `/games/${gameId}/map/history${previewMemberId ? '?previewMemberId=' + encodeURIComponent(previewMemberId) : ''}`,
    )
  ).data;
}

export async function advanceQuarter(gameId: string, quarterId: string) {
  return (
    await apiRequest<QuarterSummary>(
      `/games/${gameId}/quarters/${quarterId}/settlement/advance`,
      { method: 'POST' },
    )
  ).data;
}

export async function fetchConversations(gameId: string) {
  return (
    await apiRequest<ConversationSummary[]>(`/games/${gameId}/conversations`)
  ).data;
}

export async function createConversation(
  gameId: string,
  input: {
    type: ConversationSummary['type'];
    title: string;
    participantCountryIds: string[];
  },
) {
  return (
    await apiRequest<ConversationSummary>(`/games/${gameId}/conversations`, {
      method: 'POST',
      body: JSON.stringify(input),
    })
  ).data;
}

export async function fetchMessages(
  gameId: string,
  conversationId: string,
  cursor?: string,
  after?: string,
) {
  const query = cursor
    ? `?cursor=${encodeURIComponent(cursor)}`
    : after
      ? `?after=${encodeURIComponent(after)}&limit=100`
      : '';
  return (
    await apiRequest<MessagePage>(
      `/games/${gameId}/conversations/${conversationId}/messages${query}`,
    )
  ).data;
}

export async function sendMessage(
  gameId: string,
  conversationId: string,
  content: string,
  clientMessageId: string,
): Promise<ConversationMessage> {
  return (
    await apiRequest<ConversationMessage>(
      `/games/${gameId}/conversations/${conversationId}/messages`,
      {
        method: 'POST',
        body: JSON.stringify({ content, clientMessageId }),
      },
    )
  ).data;
}

export async function openHostConversation(gameId: string, memberId?: string) {
  return (
    await apiRequest<ConversationSummary>(
      `/games/${gameId}/conversations/host`,
      {
        method: 'POST',
        body: JSON.stringify({ memberId }),
      },
    )
  ).data;
}

export async function openPolicyConversation(gameId: string, actionId: string) {
  return (
    await apiRequest<ConversationSummary>(
      `/games/${gameId}/actions/${actionId}/conversation`,
      {
        method: 'POST',
        body: JSON.stringify({}),
      },
    )
  ).data;
}
