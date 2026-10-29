import {
  type FormEvent,
  useCallback,
  useEffect,
  useState,
  useRef,
  useLayoutEffect,
  type CSSProperties,
} from 'react';
import type {
  CountrySummary,
  GameMemberSummary,
  GameSummary,
  GameRulesData,
  QuarterSummary,
  TileDetails,
  MapObjectLocation,
} from '@srilanka/contracts';
import {
  addMember,
  assignCountry,
  fetchCountries,
  fetchGameRules,
  fetchMembers,
  openPolicyConversation,
  locateMapReference,
} from '../api.js';
import { type ActionDraftSeed } from '../actions/ActionCenter.js';
import { RoundPolicyCenter } from '../actions/RoundPolicyCenter.js';
import { HexMap } from '../map/HexMap.js';
import { mapActionSeed, type MapActionIntent } from '../map/map-actions.js';
import type { MapActionReference } from '../map/ActionMapLinks.js';
import type { MapRevealSeed } from '../map/MapSetupPanel.js';
import {
  MessageCenter,
  type ConversationTarget,
} from '../messages/MessageCenter.js';
import { GameRulesPanel } from '../rules/GameRulesPanel.js';
import { EconomicRulesPanel } from '../rules/EconomicRulesPanel.js';
import { SettlementPanel } from '../settlements/SettlementPanel.js';
import {
  CountryPanel,
  type CountrySection,
} from '../countries/CountryPanel.js';
import { quarterStateNames, roleNames, seasonNames } from '../game-labels.js';
import { TurnOverview, useWorkspaceOverview } from './WorkspaceOverview.js';
import {
  GamePreparationPanel,
  type PreparationTarget,
} from './GamePreparationPanel.js';
import { isGameReadOnly } from '@srilanka/contracts';
import { GameLifecyclePanel } from './GameLifecyclePanel.js';
import { AccountManagement } from '../accounts/AccountPanels.js';
import { WorkspaceSplitHandle } from './WorkspaceSplitHandle.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import { useMobileViewport } from '../ui/mobile.js';
import {
  MobileNavigation,
  MobileDirectory,
  type WorkspacePage,
} from './MobileNavigation.js';
export function GameWorkspace({
  game,
  onGameChange,
}: {
  game: GameSummary;
  onGameChange?: (game: GameSummary) => void;
}) {
  const mobile = useMobileViewport();
  const [mobileMore, setMobileMore] = useState(false);
  function mobileNavigate(page: WorkspacePage) {
    setMobileMore(false);
    setOverviewOpen(false);
    if (page === 'actions') setActionsOpened(true);
    if (page === 'settlement') setSettlementOpened(true);
    setWorkspaceTab(page);
  }
  const readOnly = isGameReadOnly(game.status);
  const [members, setMembers] = useState<GameMemberSummary[]>([]);
  const [accountTarget, setAccountTarget] = useState<GameMemberSummary | null>(
    null,
  );
  const closeAccountAssistance = useCallback(() => setAccountTarget(null), []);
  const [countries, setCountries] = useState<CountrySummary[]>([]);
  const [rules, setRules] = useState<GameRulesData | null>(null);
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<'Player' | 'Observer'>('Player');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [previewMemberId, setPreviewMemberId] = useState('');
  const [workspaceTab, setWorkspaceTab] = useState<
    | 'map'
    | 'actions'
    | 'messages'
    | 'rules'
    | 'settlement'
    | 'country'
    | 'members'
    | 'preparation'
  >(
    !readOnly &&
      (game.role === 'Host' || game.role === 'Administrator') &&
      game.currentQuarter.sequenceNumber === 1 &&
      game.currentQuarter.state === 'Preparing'
      ? 'preparation'
      : 'map',
  );
  const [settlementOpened, setSettlementOpened] = useState(false);
  const [countryOpened, setCountryOpened] = useState(false);
  const [tileFocus, setTileFocus] = useState<
    MapObjectLocation & { key: number }
  >();
  const [settlementFocus, setSettlementFocus] = useState<{
    actionId: string;
    key: number;
  }>();
  const mapLocationRequest = useRef<AbortController | null>(null);
  const [mapReturn, setMapReturn] = useState<
    'actions' | 'settlement' | 'country' | null
  >(null);
  useEffect(
    () => () => mapLocationRequest.current?.abort(),
    [game.id, previewMemberId, workspaceTab],
  );
  const [actionsOpened, setActionsOpened] = useState(false);
  const [conversationTarget, setConversationTarget] =
    useState<ConversationTarget>();
  const [actionFocus, setActionFocus] = useState<{
    actionId: string;
    key: number;
  }>();
  const [unreadMessages, setUnreadMessages] = useState(0);
  const [actionSeed, setActionSeed] = useState<ActionDraftSeed>();
  const [mapRevealSeed, setMapRevealSeed] = useState<MapRevealSeed>();
  const [currentQuarter, setCurrentQuarter] = useState(game.currentQuarter);
  const canManage = game.role === 'Host' || game.role === 'Administrator';
  const preparingOpening =
    canManage &&
    !readOnly &&
    currentQuarter.sequenceNumber === 1 &&
    currentQuarter.state === 'Preparing';
  const [countrySection, setCountrySection] =
    useState<CountrySection>('overview');
  const [selectedCountryId, setSelectedCountryId] = useState('');
  const [countryEditing, setCountryEditing] = useState(false);
  const [overviewOpen, setOverviewOpen] = useState(false);
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [panelShare, setPanelShare] = useState(52);
  const navigationRef = useRef<HTMLElement | null>(null);
  const panelContent = useRef<HTMLDivElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const scrollPositions = useRef<Record<string, number>>({});
  const panelKey = workspaceTab === 'country' ? countrySection : workspaceTab;
  useLayoutEffect(() => {
    if (panelContent.current)
      panelContent.current.scrollTop = scrollPositions.current[panelKey] ?? 0;
    if (workspaceTab !== 'map' && !previewMemberId)
      panelHeading.current?.focus({ preventScroll: true });
  }, [panelKey, previewMemberId]);
  useEffect(() => {
    const navigation = navigationRef.current;
    const revealCurrent = () =>
      navigation
        ?.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
        ?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    revealCurrent();
    if (!navigation || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(revealCurrent);
    observer.observe(navigation);
    return () => observer.disconnect();
  }, [panelKey, loading, previewMemberId]);
  const overview = useWorkspaceOverview(
    { ...game, currentQuarter },
    !previewMemberId,
  );
  useEffect(() => {
    const next = overview.currentGame;
    if (
      next &&
      next.id === game.id &&
      ((next.status !== game.status && !readOnly) || next.role !== game.role)
    )
      onGameChange?.(next);
  }, [
    overview.currentGame,
    game.id,
    game.status,
    game.role,
    readOnly,
    onGameChange,
  ]);
  useEffect(() => {
    if (!canManage) {
      setPreviewMemberId('');
      setAccountTarget(null);
      if (['members', 'preparation'].includes(workspaceTab))
        setWorkspaceTab('map');
    }
  }, [canManage, workspaceTab]);
  const selectedCountry =
    overview.national?.countries.find((c) => c.id === selectedCountryId) ??
    overview.national?.countries[0];
  function openCountry(section: CountrySection = 'overview') {
    setMobileMore(false);
    setCountrySection(section);
    setCountryOpened(true);
    setWorkspaceTab('country');
  }
  function closePanel() {
    if (
      mobile &&
      ['country', 'rules', 'members', 'preparation'].includes(workspaceTab)
    ) {
      setMobileMore(true);
      return;
    }
    const origin = workspaceTab === 'country' ? countrySection : workspaceTab;
    setWorkspaceTab('map');
    navigationRef.current
      ?.querySelector<HTMLButtonElement>(`[data-panel="${origin}"]`)
      ?.focus();
  }
  useEffect(() => {
    setPanelExpanded(false);
    if (workspaceTab !== 'map') {
      setOverviewOpen(false);
      setMapReturn(null);
    }
  }, [workspaceTab]);
  useEffect(() => {
    const close = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' &&
        !event.defaultPrevented &&
        workspaceTab !== 'map' &&
        (event.target as HTMLElement)?.tagName !== 'SELECT'
      ) {
        event.preventDefault();
        closePanel();
      }
    };
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  });
  const panelTitle = {
    map: '地图',
    actions: readOnly ? '政策记录' : canManage ? '行动审核' : '政策与行动',
    messages: '消息与讨论',
    rules: '剧本与规则',
    settlement: canManage && !readOnly ? '回合结算' : '回合结果',
    country: {
      overview: '国家概况',
      economy: '经济与贸易',
      diplomacy: '外交',
      military: '军事',
      government: '政府与长期政策',
    }[countrySection],
    members: '本局管理',
    preparation: '开局准备',
  }[workspaceTab];

  useEffect(() => {
    setCurrentQuarter(game.currentQuarter);
  }, [game.currentQuarter, game.id]);

  useEffect(() => {
    if (workspaceTab === 'preparation' && !preparingOpening) {
      setActionsOpened(true);
      setWorkspaceTab('actions');
    }
  }, [preparingOpening, workspaceTab]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [countryList, gameRules] = await Promise.all([
        fetchCountries(game.id),
        fetchGameRules(game.id),
      ]);
      setCountries(countryList);
      setRules(gameRules);
      if (canManage) setMembers(await fetchMembers(game.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '游戏上下文加载失败');
    } finally {
      setLoading(false);
    }
  }, [canManage, game.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function updateQuarter(quarter: QuarterSummary) {
    setCurrentQuarter(quarter);
    if (
      quarter.id !== currentQuarter.id ||
      ['Published', 'Completed'].includes(quarter.state)
    )
      setMapRevealSeed(undefined);
    if (quarter.id !== currentQuarter.id) {
      try {
        setRules(await fetchGameRules(game.id));
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : '回合规则加载失败');
      }
    }
  }

  function openSettlement(actionId?: string) {
    if (typeof actionId === 'string')
      setSettlementFocus((current) => ({
        actionId,
        key: (current?.key ?? 0) + 1,
      }));
    setSettlementOpened(true);
    setWorkspaceTab('settlement');
  }
  async function locateReference(ref: MapActionReference) {
    if (ref.objectType !== 'Tile' && ref.objectType !== 'Province') return;
    mapLocationRequest.current?.abort();
    const controller = new AbortController();
    mapLocationRequest.current = controller;
    try {
      const location = await locateMapReference(
        game.id,
        ref.objectType,
        ref.objectId,
        {
          previewMemberId: previewMemberId || undefined,
          signal: controller.signal,
        },
      );
      if (controller.signal.aborted) return;
      setTileFocus((current) => ({
        ...location,
        key: (current?.key ?? 0) + 1,
      }));
      if (workspaceTab === 'actions' || workspaceTab === 'settlement')
        setMapReturn(workspaceTab);
      setWorkspaceTab('map');
    } catch (cause) {
      if (!controller.signal.aborted) throw cause;
    }
  }
  useEffect(() => {
    const next = overview.quarter;
    if (
      next &&
      next.sequenceNumber >= currentQuarter.sequenceNumber &&
      (next.id !== currentQuarter.id ||
        next.state !== currentQuarter.state ||
        next.currentWorldVersion !== currentQuarter.currentWorldVersion ||
        next.actionDeadline !== currentQuarter.actionDeadline)
    )
      void updateQuarter(next);
  }, [overview.quarter]);

  function openMapReveal(input: Omit<MapRevealSeed, 'key'>) {
    setMapRevealSeed({ ...input, key: Date.now() });
    setPreviewMemberId('');
    setWorkspaceTab('map');
  }

  async function discussAction(actionId: string) {
    const conversation = await openPolicyConversation(game.id, actionId);
    setConversationTarget((current) => ({
      conversation,
      key: (current?.key ?? 0) + 1,
    }));
    setWorkspaceTab('messages');
  }

  function openPolicy(actionId: string) {
    setActionFocus((current) => ({ actionId, key: (current?.key ?? 0) + 1 }));
    setActionsOpened(true);
    setWorkspaceTab('actions');
  }

  async function submitMember(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await addMember(game.id, { username, role });
      setUsername('');
      setMembers(await fetchMembers(game.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '添加成员失败');
    }
  }

  async function changeCountry(memberId: string, countryId: string) {
    setError('');
    try {
      await assignCountry(game.id, memberId, countryId || null);
      setMembers(await fetchMembers(game.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '国家分配失败');
    }
  }

  function addTileToAction(tile: TileDetails, intent?: MapActionIntent) {
    setActionSeed(mapActionSeed(tile, Date.now(), intent));
    setActionsOpened(true);
    setWorkspaceTab('actions');
  }

  function navigatePreparation(target: PreparationTarget) {
    if (target === 'economy' || target === 'government') openCountry(target);
    else setWorkspaceTab(target);
  }

  return (
    <section
      data-mobile-more={mobile && mobileMore}
      className={`workspace-card strategy-workspace${canManage ? ' strategy-workspace--host' : ''}`}
    >
      {mobile && (
        <header className="mobile-game-heading">
          <div>
            <strong>{game.name}</strong>
            <span>
              {roleNames[game.role]} · 第 {currentQuarter.gameYear} 年{' '}
              {seasonNames[currentQuarter.season]}
            </span>
          </div>
          <span className="mobile-phase">
            {readOnly
              ? '已结束 · 只读'
              : quarterStateNames[currentQuarter.state]}
          </span>
        </header>
      )}
      {mobile && (
        <div className="mobile-editor-bar">
          <span>正在编辑 · {panelTitle}</span>
          <button
            type="button"
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (document.activeElement instanceof HTMLElement)
                document.activeElement.blur();
            }}
          >
            完成输入
          </button>
        </div>
      )}
      <header className="strategy-topbar">
        <div className="strategy-identity">
          <h2>{game.name}</h2>
          <span>{roleNames[game.role]}</span>
        </div>
        {!previewMemberId &&
          selectedCountry &&
          (canManage ? (
            <select
              className="strategy-country-select"
              aria-label="当前查看国家"
              disabled={countryEditing}
              value={selectedCountry.id}
              onChange={(event) => setSelectedCountryId(event.target.value)}
            >
              {overview.national?.countries.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <button
              className="strategy-country-button"
              onClick={() => openCountry()}
            >
              {selectedCountry.name}
            </button>
          ))}
        {!previewMemberId && selectedCountry && (
          <dl className="strategy-resources">
            <div>
              <dt>国库</dt>
              <dd>
                {selectedCountry.treasury.toLocaleString('zh-CN', {
                  maximumFractionDigits: 2,
                })}
              </dd>
            </div>
            <div>
              <dt>人力</dt>
              <dd>{selectedCountry.manpower.toLocaleString('zh-CN')}</dd>
            </div>
          </dl>
        )}
        <div className="quarter-chip">
          <span>
            第 {currentQuarter.gameYear} 年 ·{' '}
            {seasonNames[currentQuarter.season]}
          </span>
          <span className="quarter-status">
            {readOnly
              ? '已结束 · 只读'
              : quarterStateNames[currentQuarter.state]}
          </span>
        </div>
        {canManage && !loading && (
          <div className="preview-control">
            <label>
              <span className="sr-only">玩家视角预览</span>
              <select
                value={previewMemberId}
                onChange={(event) => {
                  setPreviewMemberId(event.target.value);
                  setWorkspaceTab('map');
                }}
              >
                <option value="">主持人真实视角</option>
                {members
                  .filter((m) => ['Player', 'Observer'].includes(m.role))
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.displayName} ·{' '}
                      {m.controlledCountryName ?? roleNames[m.role]}
                    </option>
                  ))}
              </select>
            </label>
            {previewMemberId && <strong>只读预览</strong>}
          </div>
        )}
      </header>
      {loading && <LoadingSkeleton label="正在加载游戏面板…" layout="map" />}
      {error && (
        <p className="form-error" role="alert">
          {error}
          <button disabled={loading} onClick={() => void load()}>
            重试
          </button>
        </p>
      )}
      {!previewMemberId && overview.nationalError && (
        <p className="form-error" role="alert">
          {overview.nationalError}
          <button onClick={overview.refresh}>重试国家资料</button>
        </p>
      )}
      {!loading && !mobile && (
        <>
          <nav
            ref={navigationRef}
            className="workspace-tabs strategy-navigation"
            aria-label="游戏工作区"
          >
            {preparingOpening && !previewMemberId && (
              <button
                data-panel="preparation"
                aria-pressed={workspaceTab === 'preparation'}
                onClick={() => setWorkspaceTab('preparation')}
              >
                开局准备
              </button>
            )}
            <button
              data-panel="map"
              aria-pressed={workspaceTab === 'map'}
              onClick={() => setWorkspaceTab('map')}
            >
              地图
            </button>
            {!previewMemberId && (
              <>
                <div className="strategy-country-menu">
                  <button
                    data-panel="overview"
                    aria-pressed={
                      workspaceTab === 'country' &&
                      countrySection === 'overview'
                    }
                    onClick={() => openCountry()}
                  >
                    国家
                  </button>
                  {(game.role === 'Observer'
                    ? (['diplomacy'] as const)
                    : ([
                        'economy',
                        'diplomacy',
                        'military',
                        'government',
                      ] as const)
                  ).map((section) => (
                    <button
                      key={section}
                      data-panel={section}
                      aria-pressed={
                        workspaceTab === 'country' && countrySection === section
                      }
                      onClick={() => openCountry(section)}
                    >
                      {
                        {
                          economy: '经济',
                          diplomacy: '外交',
                          military: '军事',
                          government: '政府',
                        }[section]
                      }
                    </button>
                  ))}
                </div>
                {game.role !== 'Observer' && (
                  <button
                    data-panel="actions"
                    aria-pressed={workspaceTab === 'actions'}
                    onClick={() => {
                      setActionsOpened(true);
                      setWorkspaceTab('actions');
                    }}
                  >
                    {readOnly ? '政策记录' : canManage ? '行动审核' : '政策'}
                  </button>
                )}
                <button
                  data-panel="settlement"
                  aria-pressed={workspaceTab === 'settlement'}
                  onClick={() => openSettlement()}
                >
                  {canManage && !readOnly ? '回合结算' : '回合结果'}
                </button>
                <button
                  data-panel="messages"
                  aria-pressed={workspaceTab === 'messages'}
                  onClick={() => setWorkspaceTab('messages')}
                >
                  消息
                  {unreadMessages > 0 && (
                    <span
                      className="unread-badge"
                      aria-label={`${unreadMessages} 条未读消息`}
                    >
                      {unreadMessages}
                    </span>
                  )}
                </button>
                <button
                  data-panel="rules"
                  aria-pressed={workspaceTab === 'rules'}
                  onClick={() => setWorkspaceTab('rules')}
                >
                  剧本与规则
                </button>
                {canManage && (
                  <button
                    data-panel="members"
                    aria-pressed={workspaceTab === 'members'}
                    onClick={() => setWorkspaceTab('members')}
                  >
                    本局管理
                  </button>
                )}
                {!readOnly && (
                  <button
                    className="strategy-overview-toggle"
                    aria-expanded={overviewOpen}
                    aria-controls="turn-overview"
                    onClick={() => {
                      setWorkspaceTab('map');
                      setOverviewOpen((open) => !open);
                    }}
                  >
                    回合事务
                  </button>
                )}
              </>
            )}
          </nav>
        </>
      )}
      {mobile && mobileMore && (
        <MobileDirectory
          host={canManage}
          observer={game.role === 'Observer'}
          preparing={preparingOpening}
          readOnly={readOnly}
          preview={!!previewMemberId}
          onNavigate={mobileNavigate}
          onCountry={openCountry}
          onOverview={() => {
            mobileNavigate('map');
            setOverviewOpen(true);
          }}
          onExitPreview={() => {
            setPreviewMemberId('');
            mobileNavigate('map');
          }}
        />
      )}
      <div
        className={`strategy-body${!previewMemberId && overviewOpen && workspaceTab === 'map' ? ' strategy-body--overview' : ''}${workspaceTab === 'preparation' && !previewMemberId ? ' strategy-body--preparing' : ''}`}
        hidden={loading || (mobile && mobileMore)}
      >
        <div
          className={`strategy-main${workspaceTab !== 'map' && !previewMemberId ? ' strategy-main--panel' : ''}${panelExpanded || workspaceTab === 'preparation' ? ' strategy-main--expanded' : ''}`}
          style={
            { '--workspace-panel-width': `${panelShare}%` } as CSSProperties
          }
        >
          <div
            className="strategy-map"
            aria-label="世界地图"
            inert={mobile && workspaceTab !== 'map' && !previewMemberId}
            hidden={workspaceTab === 'preparation' && !previewMemberId}
          >
            <HexMap
              overlay
              showDetails={workspaceTab === 'map'}
              showSetupWhenMissing={workspaceTab === 'map'}
              game={{ ...game, currentQuarter }}
              countries={countries}
              countryId={selectedCountry?.id}
              previewMemberId={previewMemberId || undefined}
              onCreateAction={
                game.role === 'Player' && !previewMemberId && !readOnly
                  ? addTileToAction
                  : undefined
              }
              tileFocus={tileFocus}
              returnTarget={
                mapReturn && workspaceTab === 'map' && !previewMemberId
                  ? {
                      label:
                        mapReturn === 'country'
                          ? `返回${{ overview: '国家概况', economy: '经济', diplomacy: '外交', military: '军事', government: '政府' }[countrySection]}`
                          : mapReturn === 'settlement'
                            ? canManage
                              ? '返回结算'
                              : '返回回合结果'
                            : '返回政策',
                      onReturn: () => {
                        setWorkspaceTab(mapReturn);
                        setMapReturn(null);
                      },
                    }
                  : undefined
              }
              active={
                !loading &&
                !(mobile && mobileMore) &&
                workspaceTab !== 'preparation' &&
                (!mobile || workspaceTab === 'map')
              }
              revealSeed={mapRevealSeed}
              onReturnSettlement={openSettlement}
              onInspectTile={() => setWorkspaceTab('map')}
            />
          </div>
          <section
            className={`workspace-drawer${workspaceTab === 'settlement' ? ' workspace-drawer--wide' : ''}${workspaceTab === 'preparation' ? ' workspace-drawer--preparation' : ''}`}
            aria-label={panelTitle}
            hidden={loading || workspaceTab === 'map' || !!previewMemberId}
          >
            <header className="workspace-drawer__heading">
              <h3 ref={panelHeading} tabIndex={-1}>
                {panelTitle}
              </h3>
              <div className="workspace-panel-tools">
                {workspaceTab !== 'preparation' && (
                  <button
                    className="workspace-expand"
                    aria-label={panelExpanded ? '还原面板' : '展开面板'}
                    aria-pressed={panelExpanded}
                    onClick={() => setPanelExpanded((expanded) => !expanded)}
                  >
                    {panelExpanded ? '还原' : '展开'}
                  </button>
                )}
                <button aria-label="关闭面板" onClick={closePanel}>
                  {mobile &&
                  ['country', 'rules', 'members', 'preparation'].includes(
                    workspaceTab,
                  )
                    ? '返回全部功能'
                    : '返回地图'}
                </button>
              </div>
            </header>
            {!panelExpanded &&
              workspaceTab !== 'preparation' &&
              workspaceTab !== 'map' &&
              !previewMemberId && (
                <WorkspaceSplitHandle
                  value={panelShare}
                  onChange={setPanelShare}
                />
              )}
            <div
              className="workspace-drawer__content"
              ref={panelContent}
              onScroll={(event) => {
                scrollPositions.current[panelKey] =
                  event.currentTarget.scrollTop;
              }}
            >
              {preparingOpening && (
                <div hidden={workspaceTab !== 'preparation'}>
                  <GamePreparationPanel
                    gameId={game.id}
                    active={
                      !loading &&
                      workspaceTab === 'preparation' &&
                      !previewMemberId
                    }
                    onNavigate={navigatePreparation}
                    onOpened={(quarter) => {
                      void updateQuarter(quarter);
                      setActionsOpened(true);
                      setWorkspaceTab('actions');
                      overview.refresh();
                    }}
                  />
                </div>
              )}
              {actionsOpened && (
                <div hidden={workspaceTab !== 'actions'}>
                  <RoundPolicyCenter
                    game={{ ...game, currentQuarter }}
                    active={
                      !loading &&
                      workspaceTab === 'actions' &&
                      !previewMemberId &&
                      !(mobile && mobileMore)
                    }
                    rules={rules}
                    seed={actionSeed}
                    focus={actionFocus}
                    onQuarterChange={setCurrentQuarter}
                    onPrepareOpening={
                      preparingOpening
                        ? () => setWorkspaceTab('preparation')
                        : undefined
                    }
                    onOpenSettlement={openSettlement}
                    onLocateReference={locateReference}
                    onDiscussAction={readOnly ? undefined : discussAction}
                    onMapReveal={readOnly ? undefined : openMapReveal}
                    onSeedConsumed={(key) =>
                      setActionSeed((current) =>
                        current?.key === key ? undefined : current,
                      )
                    }
                  />
                </div>
              )}
              <div hidden={workspaceTab !== 'messages'}>
                <MessageCenter
                  game={{ ...game, currentQuarter }}
                  countries={countries}
                  members={members}
                  active={
                    !loading &&
                    workspaceTab === 'messages' &&
                    !previewMemberId &&
                    !(mobile && mobileMore)
                  }
                  target={conversationTarget}
                  onUnreadChange={setUnreadMessages}
                  onOpenPolicy={openPolicy}
                />
              </div>
              {settlementOpened && (
                <div hidden={workspaceTab !== 'settlement'}>
                  <SettlementPanel
                    game={{ ...game, currentQuarter }}
                    active={
                      !loading &&
                      workspaceTab === 'settlement' &&
                      !previewMemberId
                    }
                    onQuarterChange={(quarter) => void updateQuarter(quarter)}
                    onDiscussAction={readOnly ? undefined : discussAction}
                    onMapReveal={readOnly ? undefined : openMapReveal}
                    onLocateReference={locateReference}
                    focus={settlementFocus}
                  />
                </div>
              )}
              {countryOpened && (
                <div hidden={workspaceTab !== 'country'}>
                  <CountryPanel
                    game={{ ...game, currentQuarter }}
                    section={countrySection}
                    compact
                    selectedCountryId={selectedCountry?.id}
                    onCountryChange={setSelectedCountryId}
                    onEditingChange={setCountryEditing}
                    active={
                      !loading && workspaceTab === 'country' && !previewMemberId
                    }
                    onLocate={(tile) => {
                      setTileFocus({ ...tile, key: Date.now() });
                      setMapReturn('country');
                      setWorkspaceTab('map');
                    }}
                  />
                </div>
              )}
              {rules && (
                <div hidden={workspaceTab !== 'rules'}>
                  <GameRulesPanel
                    gameId={game.id}
                    rules={rules}
                    canManage={canManage && !readOnly}
                    onSaved={setRules}
                  />
                  <EconomicRulesPanel
                    gameId={game.id}
                    active={
                      !loading && workspaceTab === 'rules' && !previewMemberId
                    }
                    canManage={canManage && !readOnly}
                  />
                </div>
              )}
              {canManage && (
                <div
                  hidden={workspaceTab !== 'members'}
                  className="member-management"
                >
                  <GameLifecyclePanel
                    game={{ ...game, currentQuarter }}
                    onEnded={(next) => {
                      setCountryEditing(false);
                      setOverviewOpen(false);
                      onGameChange?.(next);
                    }}
                  />
                  {!readOnly && (
                    <form
                      className="member-form"
                      onSubmit={(event) => void submitMember(event)}
                    >
                      <input
                        required
                        aria-label="成员用户名"
                        maxLength={64}
                        placeholder="成员用户名"
                        value={username}
                        onChange={(event) => setUsername(event.target.value)}
                      />
                      <select
                        aria-label="成员身份"
                        value={role}
                        onChange={(event) =>
                          setRole(event.target.value as 'Player' | 'Observer')
                        }
                      >
                        <option value="Player">玩家</option>
                        <option value="Observer">观察者</option>
                      </select>
                      <button type="submit">添加</button>
                    </form>
                  )}
                  <div className="member-list">
                    {members.map((member) => (
                      <div className="member-row" key={member.id}>
                        <span>
                          <strong>{member.displayName}</strong>
                          <small>
                            {member.username} · {roleNames[member.role]}
                          </small>
                        </span>
                        {member.role === 'Player' && !readOnly ? (
                          <select
                            aria-label={`为 ${member.displayName} 分配国家`}
                            value={member.controlledCountryId ?? ''}
                            onChange={(event) =>
                              void changeCountry(member.id, event.target.value)
                            }
                          >
                            <option value="">未分配国家</option>
                            {countries.map((c) => (
                              <option key={c.id} value={c.id}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <span className="muted">
                            {member.controlledCountryName ?? '—'}
                          </span>
                        )}
                        {!readOnly &&
                          member.status === 'Active' &&
                          ['Player', 'Observer'].includes(member.role) && (
                            <button
                              className="button button--quiet"
                              type="button"
                              onClick={() => setAccountTarget(member)}
                            >
                              重置登录
                            </button>
                          )}
                      </div>
                    ))}
                  </div>
                  <AccountManagement
                    gameId={game.id}
                    active={
                      !loading && workspaceTab === 'members' && !previewMemberId
                    }
                    readOnly={readOnly}
                    target={accountTarget}
                    onClose={closeAccountAssistance}
                  />
                </div>
              )}
            </div>
          </section>
        </div>
        {!previewMemberId && overviewOpen && workspaceTab === 'map' && (
          <TurnOverview
            game={{ ...game, currentQuarter }}
            actions={overview.actions}
            country={selectedCountry}
            unread={unreadMessages}
            error={overview.actionError}
            onRetry={overview.refresh}
            onClose={() => setOverviewOpen(false)}
            onOpenAction={openPolicy}
            onOpenMilitary={() => openCountry('military')}
            onOpenMessages={() => setWorkspaceTab('messages')}
            onOpenSettlement={openSettlement}
          />
        )}
      </div>
      {mobile && !loading && (
        <MobileNavigation
          page={workspaceTab}
          more={mobileMore}
          host={canManage}
          observer={game.role === 'Observer'}
          preview={!!previewMemberId}
          readOnly={readOnly}
          unread={unreadMessages}
          onNavigate={mobileNavigate}
          onMore={() => {
            setOverviewOpen(false);
            setMobileMore(true);
          }}
        />
      )}
    </section>
  );
}
