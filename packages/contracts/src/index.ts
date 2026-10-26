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
export function isGameReadOnly(status: GameStatus): boolean {
  return status === 'Completed' || status === 'Archived';
}
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

export type RegistrationMode = 'Open' | 'InviteOnly' | 'Closed';
export const MINIMUM_PASSWORD_LENGTH = 6;
export interface AuthOptions {
  registrationMode: RegistrationMode;
  minimumPasswordLength: number;
}
export interface AccountAccessCode {
  code: string;
  expiresAt: string;
  username?: string;
  displayName?: string;
}
export interface AccountSecurityEvent {
  id: string;
  kind:
    | 'PasswordChanged'
    | 'ResetIssued'
    | 'PasswordReset'
    | 'InviteIssued'
    | 'InviteUsed'
    | 'OperatorResetIssued';
  actorName: string | null;
  targetName: string | null;
  reason: string;
  createdAt: string;
}

export interface MeData extends CurrentUser {
  games: GameSummary[];
  canCreateGame?: boolean;
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
  endedAt?: string | null;
  endingReason?: string | null;
}

export interface EndGameInput {
  expectedQuarterId: string;
  expectedQuarterState: QuarterState;
  reason: string;
}

export interface GameDetails extends GameSummary {
  allowNewPlayers: boolean;
  aiEnabled: boolean;
  createdAt: string;
}

export interface GamePreparation {
  quarter: QuarterSummary;
  revision: string;
  canOpen: boolean;
  countryCount: number;
  playerCount: number;
  assignedPlayerCount: number;
  unassignedPlayers: Array<{ id: string; displayName: string }>;
  rulesSaved: boolean;
  map: { name: string; tileCount: number; controlledTileCount: number } | null;
  resourceCountryCount: number;
  automaticEconomy: boolean;
  governmentCountryCount: number;
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

export type CountryResource = 'Treasury' | 'Manpower';
export interface CountryStatus extends CountrySummary {
  treasury: number;
  manpower: number;
  resourceRevision: number;
  controlledTileCount: number;
  legalTileCount: number;
  cities: Array<{ id: string; name: string; q: number; r: number }>;
  armies: Array<{
    id: string;
    name: string;
    strength: number;
    q: number;
    r: number;
  }>;
}
export interface NationalStatus {
  countries: CountryStatus[];
  canSetBalances: boolean;
}
export interface ProvinceValues {
  description: string;
  taxBase: number;
  productionBase: number;
  manpowerBase: number;
  autonomy: number;
  unrest: number;
}
export type ProvinceStats = Omit<ProvinceValues, 'description'>;
export const provinceStatFields = [
  'taxBase',
  'productionBase',
  'manpowerBase',
  'autonomy',
  'unrest',
] as const;
export interface EconomicRules {
  enabled: boolean;
  taxCoefficient: number;
  productionCoefficient: number;
  manpowerCoefficient: number;
  armyMaintenancePer100: number;
  administrationCost: number;
  tradeCoefficient?: number;
}
export interface TradeZoneSnapshot {
  id: string;
  name: string;
  revision: number;
  provinces: Array<{
    id: string;
    name: string;
    productionBase: number;
    tileCount: number;
  }>;
  influences: Array<{ countryId: string; power: number }>;
}
export interface TradeIncomeReport {
  gameYear: number;
  season: Season;
  calculatedIncome: number;
  actualIncome: number;
  adjustmentReason: string;
  sources: Array<{ name: string; amount: number }>;
}
export interface TradeData {
  economicEnabled: boolean;
  coefficient: number;
  canEdit: boolean;
  mapRevision: number;
  zones: Array<{
    id: string;
    name: string;
    ownInfluence: number;
    setup?: TradeZoneSnapshot & {
      value: number;
      allocations: Array<{ countryId: string; amount: number }>;
    };
  }>;
  options?: {
    provinces: Array<{ id: string; name: string }>;
    countries: Array<{ id: string; name: string }>;
  };
  lastIncome: TradeIncomeReport | null;
}
export interface SetTradeZoneInput {
  expectedRevision: number | null;
  expectedMapRevision: number;
  name: string;
  provinceIds: string[];
  influences: Array<{ countryId: string; power: number }>;
  reason: string;
}
export interface EconomicRulesData {
  rules: EconomicRules;
  version: number;
  canEdit: boolean;
}
export interface SetEconomicRulesInput {
  rules: EconomicRules;
  expectedVersion: number;
  reason: string;
}
export type EconomicLineKind =
  | 'Tax'
  | 'Production'
  | 'ManpowerGrowth'
  | 'Trade'
  | 'ArmyMaintenance'
  | 'Administration';
export interface EconomicLineInput {
  id: string;
  countryId: string;
  kind: EconomicLineKind;
  amount: number;
  expectedResourceRevision: number;
  adjustmentReason: string;
}
export interface EconomicBillInput {
  lines: EconomicLineInput[];
}
export interface EconomicLine extends EconomicLineInput {
  countryName: string;
  resource: CountryResource;
  calculatedAmount: number;
  sources: Array<{ name: string; calculation: string; amount: number }>;
  baseAmount?: number;
  policyEffects?: Array<{ policyId: string; title: string; percent: number }>;
}
export interface EconomicBill {
  capturedAt: string;
  worldVersion: number;
  rules: EconomicRules;
  rulesRevision: number;
  lines: EconomicLine[];
  effects: ResourceChange[];
  trade?: TradeZoneSnapshot[];
  policies?: NationalPolicy[];
}
export interface EconomicStatus {
  status: 'Disabled' | 'MissingSnapshot' | 'Ready';
  capturedAt: string | null;
}
export interface ProvinceSummary {
  id: string;
  name: string;
  values: ProvinceValues | null;
  /** Only host responses carry the edit revision. */
  revision?: number;
  /** Player responses contain only their own legal territory. */
  partial: boolean;
  tileCount: number;
  legalOwners: Array<{
    countryId: string | null;
    countryName: string | null;
    tileCount: number;
  }>;
  controllers: Array<{
    countryId: string | null;
    countryName: string | null;
    tileCount: number;
  }>;
  tiles: Array<{ id: string; q: number; r: number; regionName: string }>;
}
export interface ProvinceData {
  provinces: ProvinceSummary[];
  mapRevision: number;
  canEdit: boolean;
}
export interface SetProvinceInput extends ProvinceValues {
  name: string;
  expectedRevision: number;
  expectedMapRevision: number;
  reason: string;
}
export interface SetCountryBalancesInput {
  expectedRevision: number;
  treasury: number;
  manpower: number;
  reason: string;
}
export interface ResourceChangeInput {
  id: string;
  actionId: string | null;
  countryId: string;
  expectedResourceRevision: number;
  resource: CountryResource;
  amount: number;
  reason: string;
}
export interface ResourceChange extends ResourceChangeInput {
  countryName: string;
  before: number;
  after: number;
}

export type RecruitmentInput = {
  id: string;
  actionId: string | null;
  strength: number;
  treasuryCost: number;
  manpowerCost: number;
  expectedResourceRevision: number;
  note: string;
} & (
  | { kind: 'Create'; countryId: string; name: string; tileId: string }
  | { kind: 'Reinforce'; armyId: string }
);
export type SettlementRecruitment = RecruitmentInput & {
  countryId: string;
  countryName: string;
  armyName: string;
  q: number;
  r: number;
  beforeStrength: number;
  afterStrength: number;
  summary: string;
  costs: ResourceChange[];
};
export interface CountryLedgerEntry {
  id: string;
  kind: 'Setup' | 'Settlement' | 'Correction';
  quarterId: string;
  gameYear: number;
  season: Season;
  resource: CountryResource;
  amount: number;
  before: number;
  after: number;
  reason: string;
  createdAt: string;
}
export interface CountryLedgerPage {
  entries: CountryLedgerEntry[];
  nextCursor: string | null;
}

export interface MapMetadata {
  viewCountryId?: string | null;
  id: string;
  name: string;
  width: number;
  height: number;
  orientation: 'Pointy' | 'Flat';
  minZoom: number;
  maxZoom: number;
  currentWorldVersion: number;
  availableLayers: Array<
    'political' | 'terrain' | 'knowledge' | 'city' | 'army'
  >;
  revision?: number;
}

export interface MapSetupData {
  map: MapMetadata | null;
  terrains: Array<{
    id: string;
    name: string;
    color: string;
    passable: boolean;
    movementCost: number;
  }>;
  regions: Array<{ id: string; name: string; provinceName: string | null }>;
  provinces?: Array<{ id: string; name: string }>;
}

export interface MapBatchInput {
  correctionReason?: string;
  expectedRevision: number;
  tileIds: string[];
  terrainTypeId?: string;
  controllerCountryId?: string | null;
  legalOwnerCountryId?: string | null;
  regionName?: string;
  provinceName?: string;
}

export interface MapKnowledgeInput {
  expectedRevision: number;
  countryId: string;
  tileIds: string[];
  state: DiscoveryState;
  note: string;
  armyErrorPercent?: number;
  sourceActionId?: string;
}

export interface MapRevealPlan {
  actionId: string;
  countryId: string;
  tileIds: string[];
  state: DiscoveryState;
  note: string;
  armyErrorPercent?: number;
  publishedAt: string | null;
}

export interface MapHistoryEntry {
  id: string;
  kind: string;
  countryName: string | null;
  sourceActionId: string | null;
  sourceActionTitle: string | null;
  note: string;
  tileCount: number;
  createdAt: string;
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
  legalOwnerCountryId?: string | null;
  legalOwnerCountryName?: string | null;
  legalOwnerColor?: string | null;
  passable: boolean | null;
  movementCost: number | null;
  cities: MapCityMarker[];
  armies: MapArmyMarker[];
  knowledgeNote?: string;
  observedAt?: string | null;
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

export interface MapTileContext {
  tileId: string;
  province: {
    id: string | null;
    name: string;
    /** Only geography already available to this view. */
    tiles: Array<{ id: string; q: number; r: number }>;
    knownOnly: boolean;
    values: ProvinceValues | null;
  } | null;
  economy: {
    enabled: boolean;
    countryName: string;
    tax: number;
    production: number;
    manpower: number;
  } | null;
  tradeZones: Array<{ id: string; name: string }> | null;
  government: { profile: GovernmentProfile; policies: NationalPolicy[] } | null;
  diplomacy: {
    referenceCountryId: string | null;
    referenceCountryName: string | null;
    relations: DiplomaticRelation[];
    treaties: DiplomaticTreaty[];
  } | null;
}

export interface MapSearchResult {
  id: string;
  type: 'Tile' | 'Region' | 'City' | 'Army';
  name: string;
  tileId: string | null;
  q: number | null;
  r: number | null;
}

export interface MapObjectLocation {
  id: string;
  q: number;
  r: number;
  scope?: Array<{ id: string; q: number; r: number }>;
}

export type ActionCategory =
  | 'Exploration'
  | 'EventResponse'
  | 'Policy'
  | 'Reform'
  | 'Diplomacy'
  | 'Construction'
  | 'Research'
  | 'Recruitment'
  | 'Military'
  | 'Intelligence'
  | 'Custom';
export type ActionSecrecy = 'OwnerOnly' | 'Participants' | 'Public';
export type ActionStatus =
  | 'Draft'
  | 'Submitted'
  | 'HostReview'
  | 'NeedPlayerInput'
  | 'AIStructuring'
  | 'PendingHostApproval'
  | 'PendingPlayerConfirmation'
  | 'Approved'
  | 'Rejected'
  | 'Resolving'
  | 'Completed'
  | 'Withdrawn'
  | 'Invalidated';

export interface ActionObjectRef {
  id: string;
  refKind: 'Actor' | 'Target' | 'Context';
  objectType:
    'Tile' | 'City' | 'Army' | 'Country' | 'Character' | 'Region' | 'Province';
  objectId: string;
  label: string;
}

export interface ActionSummary {
  id: string;
  quarterId: string;
  countryId: string;
  countryName: string;
  createdByMemberId: string;
  title: string;
  category: ActionCategory;
  secrecy: ActionSecrecy;
  status: ActionStatus;
  version: number;
  submittedAt: string | null;
  updatedAt: string;
}

export interface ActionVersion {
  version: number;
  title: string;
  originalText: string;
  category: ActionCategory;
  secrecy: ActionSecrecy;
  createdAt: string;
}

export interface ActionSubmission {
  id: string;
  version: number;
  title: string;
  text: string;
  category: ActionCategory;
  secrecy: ActionSecrecy;
  refs: Array<Omit<ActionObjectRef, 'id'>>;
  submittedAt: string;
}

export type PlayerPerspective = 'CountryWill' | 'Character' | 'Flexible';

export interface ScenarioRules {
  title: string;
  playerPerspective: PlayerPerspective;
  premise: string;
  commonRules: string;
}

export interface QuarterRules {
  briefing: string;
  actionGuidelines: string;
  suggestedLimits: Array<{ category: ActionCategory; limit: number }>;
}

export interface GameRulesData {
  quarterId: string;
  version: number;
  scenario: ScenarioRules;
  quarter: QuarterRules;
}

export interface ActionStatusEntry {
  fromStatus: ActionStatus | null;
  toStatus: ActionStatus;
  reason: string;
  createdAt: string;
}

export interface ActionDetails extends ActionSummary {
  currentText: string;
  submittedOriginalText: string | null;
  refs: ActionObjectRef[];
  latestInterpretation: string | null;
  pendingInputRequest: string | null;
  history: ActionStatusEntry[];
  submissions: ActionSubmission[];
}

export interface RoundPolicySectionInput {
  id: string;
  title: string;
  text: string;
  category: ActionCategory;
  secrecy: ActionSecrecy;
  refs: Array<Omit<ActionObjectRef, 'id'>>;
}
export interface RoundPolicySection extends RoundPolicySectionInput {
  status: ActionStatus;
  reviewReason: string;
}
export interface RoundPolicySummary {
  quarterId: string;
  memberId: string;
  countryId: string;
  countryName: string;
  playerName: string;
  status: ActionStatus | 'Mixed';
  sectionCount: number;
  submittedAt: string | null;
}
export interface RoundPolicy extends RoundPolicySummary {
  revision: string;
  quarter: QuarterSummary;
  canEdit: boolean;
  canSubmit: boolean;
  sections: RoundPolicySection[];
  draftSections?: RoundPolicySectionInput[];
  pendingInputRequest: string | null;
  interpretation: string;
  history: Array<{
    id: string;
    submittedAt: string;
    whole: boolean;
    sections: RoundPolicySectionInput[];
  }>;
}
export interface SaveRoundPolicyInput {
  requestId: string;
  expectedRevision: string;
  sections: RoundPolicySectionInput[];
  submit: boolean;
}
export interface ReviewRoundPolicyInput {
  requestId: string;
  expectedRevision: string;
  target: 'NeedPlayerInput' | 'Approved' | 'Rejected' | 'Interpretation';
  reason: string;
}

export interface SettlementSummary {
  correctedAt?: string | null;
  quarterId: string;
  gameYear: number;
  season: Season;
  sequenceNumber: number;
  state: QuarterState;
  isCurrent: boolean;
  publishedAt: string | null;
}

export type SettlementResultAudience =
  | { kind: 'OwnerOnly' | 'Public' | 'HostOnly' }
  | { kind: 'Countries'; countryIds: string[] };

export interface SettlementAction {
  actionId: string;
  countryId: string;
  countryName: string;
  title: string;
  submittedText: string;
  status: 'Approved' | 'Rejected' | 'Completed';
  reviewReason: string;
  feedback: string;
  /** Host chooses at settlement; legacy snapshots default to OwnerOnly. */
  resultAudience?: SettlementResultAudience;
  /** False for recipients who can read the result but not the original policy. */
  canViewPolicy?: boolean;
  /** Formal submission targets; absent in older published snapshots. */
  refs?: Array<Omit<ActionObjectRef, 'id'>>;
}

export interface QuarterSettlement {
  /** Audience choices are returned only to the host. */
  resultCountries?: Array<{ id: string; name: string }>;
  correctionVersion?: number;
  corrections?: SettlementCorrection[];
  quarter: QuarterSummary;
  isCurrent: boolean;
  version: number;
  publishedAt: string | null;
  publicReport: string;
  actions: SettlementAction[];
  mapReveals?: MapRevealPlan[];
  mapRevision?: number;
  /** Structured world changes are visible only to the host. */
  stateChanges?: SettlementStateChange[];
  /** Battle details contain host-only army truth and are never sent to players. */
  battles?: SettlementBattle[];
  /** Drafts and full multi-country resource changes are host-only. */
  resourceChanges?: ResourceChange[];
  /** Recruitment plans and fees contain private national data. */
  recruitments?: SettlementRecruitment[];
  /** Period accounting contains private multi-country values; host-only. */
  economyStatus?: EconomicStatus;
  economicBill?: EconomicBill | null;
  /** Full diplomatic plans and their original state are host-only. */
  diplomacyChanges?: DiplomacyChange[];
  governmentChanges?: GovernmentChange[];
}

export type SettlementCorrectionChange =
  | { kind: 'PublicReport'; text: string }
  | { kind: 'ActionFeedback'; actionId: string; text: string }
  | {
      kind: 'Resource';
      countryId: string;
      resource: 'Treasury' | 'Manpower';
      amount: number;
      expectedResourceRevision: number;
    }
  | {
      kind: 'ArmyStrength';
      armyId: string;
      strength: number;
      expectedStrength: number;
      expectedMapRevision: number;
    };

export interface CorrectSettlementInput {
  id: string;
  expectedCorrectionVersion: number;
  expectedCurrentQuarterId: string;
  reason: string;
  change: SettlementCorrectionChange;
}

export interface SettlementCorrection {
  id: string;
  sequenceNumber: number;
  reason: string;
  actorName: string;
  createdAt: string;
  appliedQuarter: Pick<QuarterSummary, 'id' | 'gameYear' | 'season'>;
  change:
    | { kind: 'PublicReport'; before: string; after: string }
    | {
        kind: 'ActionFeedback';
        actionId: string;
        title: string;
        countryId: string;
        before: string;
        after: string;
      }
    | {
        kind: 'Resource';
        countryId: string;
        countryName: string;
        resource: 'Treasury' | 'Manpower';
        amount: number;
        before: number;
        after: number;
      }
    | {
        kind: 'ArmyStrength';
        countryId: string;
        countryName: string;
        armyId: string;
        armyName: string;
        before: number;
        after: number;
      };
}

export interface SettlementCorrectionOptions {
  currentQuarter: Pick<QuarterSummary, 'id' | 'gameYear' | 'season'>;
  correctionVersion: number;
  mapRevision: number;
  countries: Array<{
    id: string;
    name: string;
    treasury: number;
    manpower: number;
    resourceRevision: number;
  }>;
  armies: Array<{
    id: string;
    name: string;
    countryId: string;
    countryName: string;
    strength: number;
  }>;
}

export interface BattleParticipantInput {
  armyId: string;
  committedStrength: number;
}
export interface BattleResolution {
  outcome: 'AttackerVictory' | 'DefenderVictory' | 'Draw' | 'Inconclusive';
  narrative: string;
  armies: Array<{
    armyId: string;
    casualties: number;
    destinationTileId: string | null;
  }>;
  occupyCountryId: string | null;
}
export interface SettlementBattleInput {
  id: string;
  actionId: string | null;
  title: string;
  kind: 'Field' | 'Siege';
  tileId: string;
  attackers: BattleParticipantInput[];
  defenders: BattleParticipantInput[];
  resolution: BattleResolution | null;
}
export interface BattleRollInput {
  expectedVersion: number;
  expectedMapRevision: number;
  idempotencyKey: string;
  phase: 'Fire' | 'Shock' | 'Siege' | 'Custom';
  count: number;
  sides: number;
  zeroBased: boolean;
  attackerModifier: number;
  defenderModifier: number;
  modifierNote: string;
  note: string;
}
export interface BattleRoll {
  id: string;
  sequence: number;
  createdAt: string;
  phase: BattleRollInput['phase'];
  count: number;
  sides: number;
  zeroBased: boolean;
  attackerModifier: number;
  defenderModifier: number;
  modifierNote: string;
  note: string;
  attackerDice: number[];
  defenderDice: number[];
  attackerTotal: number;
  defenderTotal: number | null;
}
export interface SettlementBattle extends SettlementBattleInput {
  q: number;
  r: number;
  participants: Array<
    BattleParticipantInput & {
      name: string;
      countryId: string;
      countryName: string;
      originalStrength: number;
      originalTileId: string;
      q: number;
      r: number;
    }
  >;
  effects: SettlementStateChange[];
  rolls: BattleRoll[];
}

export type SettlementStateChangeInput = {
  id: string;
  actionId: string | null;
} & (
  | { kind: 'ArmyMove'; armyId: string; destinationTileId: string }
  | { kind: 'ArmyStrength'; armyId: string; strength: number }
  | {
      kind: 'TradeInfluence';
      zoneId: string;
      countryId: string;
      power: number;
      expectedZoneRevision: number;
      reason: string;
    }
  | {
      kind: 'Province';
      provinceId: string;
      expectedProfileRevision: number;
      values: Partial<ProvinceStats>;
      reason: string;
    }
  | {
      kind: 'Territory';
      tileIds: string[];
      controllerCountryId?: string | null;
      legalOwnerCountryId?: string | null;
    }
);

export type SettlementStateChange =
  | (Exclude<
      SettlementStateChangeInput,
      { kind: 'Province' | 'TradeInfluence' }
    > & {
      summary: string;
    })
  | (Extract<SettlementStateChangeInput, { kind: 'Province' }> & {
      summary: string;
      provinceName: string;
      beforeValues: Partial<ProvinceStats>;
    })
  | (Extract<SettlementStateChangeInput, { kind: 'TradeInfluence' }> & {
      summary: string;
      zoneName: string;
      countryName: string;
      beforePower: number;
    });

export function toStateChangeInput(
  change: SettlementStateChangeInput,
): SettlementStateChangeInput {
  const base = { id: change.id, actionId: change.actionId };
  switch (change.kind) {
    case 'TradeInfluence':
      return {
        ...base,
        kind: change.kind,
        zoneId: change.zoneId,
        countryId: change.countryId,
        power: change.power,
        expectedZoneRevision: change.expectedZoneRevision,
        reason: change.reason,
      };
    case 'ArmyMove':
      return {
        ...base,
        kind: change.kind,
        armyId: change.armyId,
        destinationTileId: change.destinationTileId,
      };
    case 'ArmyStrength':
      return {
        ...base,
        kind: change.kind,
        armyId: change.armyId,
        strength: change.strength,
      };
    case 'Territory':
      return {
        ...base,
        kind: change.kind,
        tileIds: change.tileIds,
        ...(change.controllerCountryId === undefined
          ? {}
          : { controllerCountryId: change.controllerCountryId }),
        ...(change.legalOwnerCountryId === undefined
          ? {}
          : { legalOwnerCountryId: change.legalOwnerCountryId }),
      };
    case 'Province':
      return {
        ...base,
        kind: change.kind,
        provinceId: change.provinceId,
        expectedProfileRevision: change.expectedProfileRevision,
        values: Object.fromEntries(
          provinceStatFields
            .filter((key) => change.values[key] !== undefined)
            .map((key) => [key, change.values[key]]),
        ),
        reason: change.reason,
      };
  }
}

export interface SettlementStateOptions {
  mapRevision: number;
  countries: Array<{ id: string; name: string }>;
  tiles: Array<{ id: string; q: number; r: number; passable: boolean }>;
  provinces?: Array<{
    id: string;
    name: string;
    revision: number;
    values: ProvinceStats;
  }>;
  tradeZones?: Array<{
    id: string;
    name: string;
    revision: number;
    influences: Array<{ countryId: string; power: number }>;
  }>;
  armies: Array<{
    id: string;
    name: string;
    countryId: string;
    countryName: string;
    tileId: string;
    q: number;
    r: number;
    strength: number;
  }>;
}

export interface SaveSettlementInput {
  expectedVersion: number;
  publicReport: string;
  results: Array<{
    actionId: string;
    feedback: string;
    resultAudience?: SettlementResultAudience;
  }>;
  stateChanges?: SettlementStateChangeInput[];
  battles?: SettlementBattleInput[];
  resourceChanges?: ResourceChangeInput[];
  recruitments?: RecruitmentInput[];
  economicBill?: EconomicBillInput | null;
  diplomacyChanges?: DiplomacyChangeInput[];
  governmentChanges?: GovernmentChangeInput[];
  expectedMapRevision?: number;
}

export const policyEffectNames: Record<EconomicLineKind, string> = {
  Tax: '税收',
  Production: '生产收入',
  Trade: '贸易收入',
  ManpowerGrowth: '人力恢复',
  ArmyMaintenance: '军队维护费',
  Administration: '行政费',
};
export interface GovernmentProfile {
  countryId: string;
  countryName: string;
  regime: string;
  authority: string;
  description: string;
}
export interface NationalPolicy {
  id: string;
  countryId: string;
  countryName: string;
  title: string;
  type: 'Policy' | 'Reform';
  text: string;
  effects: Partial<Record<EconomicLineKind, number>>;
  startsAt: DiplomacyQuarter;
  expiresAt: DiplomacyQuarter | null;
  endedAt: DiplomacyQuarter | null;
}
export type GovernmentChangeInput = {
  id: string;
  actionId: string | null;
  expectedRevision: number;
  expectedQuarterSequence: number;
  reason: string;
} & (
  | {
      kind: 'Government';
      countryId: string;
      regime: string;
      authority: string;
      description: string;
    }
  | {
      kind: 'Policy';
      policyId: string;
      countryId: string;
      title: string;
      type: 'Policy' | 'Reform';
      text: string;
      effects: Partial<Record<EconomicLineKind, number>>;
      durationQuarters: number | null;
    }
  | { kind: 'EndPolicy'; policyId: string }
);
export type GovernmentChange = GovernmentChangeInput & {
  countryId: string;
  countryName: string;
  summary: string;
  before: GovernmentProfile | NationalPolicy | null;
  after: GovernmentProfile | NationalPolicy;
};
export interface GovernmentData {
  revision: number;
  quarter: DiplomacyQuarter;
  canEdit: boolean;
  countries?: Array<{ id: string; name: string }>;
  profiles: GovernmentProfile[];
  policies: NationalPolicy[];
  lastBill: {
    quarter: DiplomacyQuarter;
    capturedAt: string;
    lines: Array<{
      kind: EconomicLineKind;
      baseAmount: number;
      calculatedAmount: number;
      actualAmount: number;
      adjustmentReason: string;
      policyEffects: Array<{
        policyId: string;
        title: string;
        percent: number;
      }>;
    }>;
  } | null;
  history?: Array<{
    id: string;
    quarter: DiplomacyQuarter;
    operation: 'Setup' | 'Settlement';
    summary: string;
    reason: string;
    before: GovernmentProfile | NationalPolicy | null;
    after: GovernmentProfile | NationalPolicy;
  }>;
}
export function nationalPolicyStatus(
  policy: NationalPolicy,
  sequence: number,
): 'Upcoming' | 'Active' | 'Expired' | 'Ended' {
  if (policy.endedAt && sequence >= policy.endedAt.sequenceNumber)
    return 'Ended';
  if (sequence < policy.startsAt.sequenceNumber) return 'Upcoming';
  if (policy.expiresAt && sequence >= policy.expiresAt.sequenceNumber)
    return 'Expired';
  return 'Active';
}
export function toGovernmentInput(
  change: GovernmentChangeInput,
): GovernmentChangeInput {
  const base = {
    id: change.id,
    actionId: change.actionId,
    expectedRevision: change.expectedRevision,
    expectedQuarterSequence: change.expectedQuarterSequence,
    reason: change.reason,
  };
  if (change.kind === 'Government')
    return {
      ...base,
      kind: change.kind,
      countryId: change.countryId,
      regime: change.regime,
      authority: change.authority,
      description: change.description,
    };
  if (change.kind === 'EndPolicy')
    return { ...base, kind: change.kind, policyId: change.policyId };
  return {
    ...base,
    kind: change.kind,
    policyId: change.policyId,
    countryId: change.countryId,
    title: change.title,
    type: change.type,
    text: change.text,
    effects: Object.fromEntries(
      Object.keys(policyEffectNames)
        .filter((key) => change.effects[key as EconomicLineKind] !== undefined)
        .map((key) => [key, change.effects[key as EconomicLineKind]]),
    ),
    durationQuarters: change.durationQuarters,
  };
}

export type TreatyKind =
  'Alliance' | 'Truce' | 'PeaceTreaty' | 'Guarantee' | 'Trade' | 'Custom';
export const treatyKindNames: Record<TreatyKind, string> = {
  Alliance: '同盟',
  Truce: '停战',
  PeaceTreaty: '和平条约',
  Guarantee: '独立保障',
  Trade: '贸易协定',
  Custom: '其他协议',
};
/** Removed categories remain readable in existing records. */
export type RecordedTreatyKind = TreatyKind | 'MilitaryAccess' | 'FleetBasing';
export function currentTreatyKind(type: RecordedTreatyKind): TreatyKind {
  return type === 'MilitaryAccess' || type === 'FleetBasing' ? 'Custom' : type;
}
export function treatyKindLabel(type: RecordedTreatyKind): string {
  return type === 'MilitaryAccess' || type === 'FleetBasing'
    ? '其他协议（旧记录）'
    : treatyKindNames[type];
}
export interface DiplomacyQuarter {
  sequenceNumber: number;
  gameYear: number;
  season: Season;
}
export interface DiplomaticRelation {
  countryIds: [string, string];
  countryNames: [string, string];
  state: 'Peace' | 'War';
  effectiveQuarter: DiplomacyQuarter;
  reason: string;
}
export interface DiplomaticTreaty {
  id: string;
  title: string;
  type: RecordedTreatyKind;
  countryIds: string[];
  countryNames: string[];
  terms: string;
  visibility: 'Public' | 'Participants';
  grantorCountryId: string | null;
  startQuarter: DiplomacyQuarter;
  updatedQuarter: DiplomacyQuarter;
  expiresAt: DiplomacyQuarter | null;
  endedAt: DiplomacyQuarter | null;
}
export type DiplomacyChangeInput = {
  id: string;
  actionId: string | null;
  expectedRevision: number;
  expectedQuarterSequence: number;
  reason: string;
} & (
  | { kind: 'WarStatus'; countryIds: [string, string]; state: 'Peace' | 'War' }
  | {
      kind: 'Treaty';
      treatyId: string;
      title: string;
      type: TreatyKind;
      countryIds: string[];
      terms: string;
      visibility: 'Public' | 'Participants';
      durationQuarters: number | null;
      grantorCountryId: string | null;
    }
  | { kind: 'EndTreaty'; treatyId: string }
);
export type DiplomacyChange = (
  | Exclude<DiplomacyChangeInput, { kind: 'Treaty' }>
  | (Omit<Extract<DiplomacyChangeInput, { kind: 'Treaty' }>, 'type'> & {
      type: RecordedTreatyKind;
    })
) & {
  summary: string;
  before: DiplomaticRelation | DiplomaticTreaty | null;
  after: DiplomaticRelation | DiplomaticTreaty;
};
export interface DiplomacyData {
  revision: number;
  quarter: DiplomacyQuarter;
  canEdit: boolean;
  relations: DiplomaticRelation[];
  treaties: DiplomaticTreaty[];
  history?: Array<{
    id: string;
    operation: 'Setup' | 'Settlement';
    quarter: DiplomacyQuarter;
    summary: string;
    reason: string;
    before: DiplomaticRelation | DiplomaticTreaty | null;
    after: DiplomaticRelation | DiplomaticTreaty;
  }>;
  countries?: Array<{ id: string; name: string }>;
}
export function toDiplomacyInput(
  change: DiplomacyChangeInput | DiplomacyChange,
): DiplomacyChangeInput {
  const base = {
    id: change.id,
    actionId: change.actionId,
    expectedRevision: change.expectedRevision,
    expectedQuarterSequence: change.expectedQuarterSequence,
    reason: change.reason,
  };
  if (change.kind === 'WarStatus')
    return {
      ...base,
      kind: change.kind,
      countryIds: [...change.countryIds],
      state: change.state,
    };
  if (change.kind === 'EndTreaty')
    return { ...base, kind: change.kind, treatyId: change.treatyId };
  return {
    ...base,
    kind: change.kind,
    treatyId: change.treatyId,
    title: change.title,
    type: currentTreatyKind(change.type),
    countryIds: [...change.countryIds],
    terms: change.terms,
    visibility: change.visibility,
    durationQuarters: change.durationQuarters,
    grantorCountryId:
      change.type === 'MilitaryAccess' || change.type === 'FleetBasing'
        ? null
        : change.grantorCountryId,
  };
}
export function treatyStatus(
  treaty: DiplomaticTreaty,
  sequence: number,
): 'Active' | 'Expired' | 'Ended' {
  return treaty.endedAt
    ? 'Ended'
    : treaty.expiresAt && sequence >= treaty.expiresAt.sequenceNumber
      ? 'Expired'
      : 'Active';
}

export interface ConversationSummary {
  id: string;
  type: 'HostPlayer' | 'BilateralDiplomacy' | 'Multilateral' | 'ActionReview';
  title: string;
  participantNames: string[];
  unreadCount: number;
  latestMessage: string | null;
  lastMessageAt: string | null;
  linkedActionId?: string | null;
}

export interface ConversationMessage {
  id: string;
  conversationId: string;
  senderDisplayName: string;
  content: string;
  sentAt: string;
  invalidated: boolean;
}

export interface MessagePage {
  items: ConversationMessage[];
  nextCursor: string | null;
}

export interface AssistantStatus {
  configured: boolean;
  enabled: boolean;
  canManage: boolean;
  provider: string;
  scope?: 'Global';
  model?: string;
}

export interface GlobalAssistantSettings {
  revision: number;
  enabled: boolean;
  configured: boolean;
  provider: 'deepseek' | 'glm' | 'compatible';
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  jsonMode: boolean;
  disableThinking: boolean;
  timeoutMs: number;
  source: 'Database' | 'Environment';
  updatedAt: string | null;
}

export interface SaveGlobalAssistantSettings {
  expectedRevision: number;
  enabled: boolean;
  provider: GlobalAssistantSettings['provider'];
  baseUrl: string;
  model: string;
  apiKey?: string;
  jsonMode: boolean;
  disableThinking: boolean;
  timeoutMs: number;
}

export interface AssistantConnectionTest {
  provider: string;
  model: string;
  latencyMs: number;
}

export interface AssistantInput {
  purpose: 'Digest' | 'Feedback';
  quarterId: string;
  expectedVersion: number;
  expectedCorrectionVersion: number;
  length: 'Brief' | 'Normal' | 'Detailed';
  actionId?: string;
  ruling?: string;
}

export interface AssistantSource {
  id: string;
  label: string;
  text: string;
}

export interface AssistantAnswer {
  overview: string;
  highlights: Array<{
    title?: string;
    category?: 'Outcome' | 'Cost' | 'Pending' | 'Correction';
    text: string;
    sourceIds: string[];
  }>;
  notices: string[];
  draft: string | null;
}

export interface AssistantResult {
  purpose: AssistantInput['purpose'];
  answer: AssistantAnswer;
  sources: AssistantSource[];
  resourceTotals: Array<{
    countryName: string;
    resource: CountryResource;
    amount: number;
  }>;
  generatedAt: string;
}
