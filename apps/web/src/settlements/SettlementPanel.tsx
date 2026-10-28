import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import {
  ResultAudienceEditor,
  resultAudienceLabel,
} from './ResultAudienceEditor.js';
import {
  isGameReadOnly,
  toStateChangeInput,
  toDiplomacyInput,
  toGovernmentInput,
} from '@srilanka/contracts';
import {
  GovernmentEditor,
  GovernmentRecord,
} from '../government/GovernmentEditor.js';
import {
  DiplomacyEditor,
  DiplomacyRecord,
} from '../diplomacy/DiplomacyEditor.js';

import type {
  GameSummary,
  QuarterSettlement,
  QuarterSummary,
  SettlementSummary,
  BattleRollInput,
  SaveSettlementInput,
  ResourceChange,
} from '@srilanka/contracts';

import {
  advanceQuarter,
  beginSettlement,
  fetchSettlement,
  fetchSettlements,
  publishSettlement,
  saveSettlement,
  rollSettlementBattle,
  fetchEconomicPreview,
} from '../api.js';
import type { MapRevealSeed } from '../map/MapSetupPanel.js';
import {
  ActionMapLinks,
  type MapActionReference,
} from '../map/ActionMapLinks.js';
import { discoveryNames } from '../map/MapSetupPanel.js';
import { StateChangeEditor, StateChangeRecord } from './StateChangeEditor.js';
import { ResourceEditor } from './ResourceEditor.js';
import {
  RecruitmentEditor,
  RecruitmentCosts,
  toRecruitmentInput,
} from './RecruitmentEditor.js';
import {
  EconomicBillPanel,
  EconomicBillRecord,
  toEconomicBillInput,
} from './EconomicBillPanel.js';
import { resourceNames, signedAmount } from '../countries/resource-labels.js';
import { SettlementCorrections } from './SettlementCorrections.js';
import { AssistantPanel } from '../assistant/AssistantPanel.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import {
  DraftRecovery,
  useDraftKey,
  useLocalDraft,
} from '../drafts/local-drafts.js';

interface SettlementLocalDraft {
  baseVersion: number;
  publicReport: string;
  results: SaveSettlementInput['results'];
}
function isSettlementDraft(value: unknown): value is SettlementLocalDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as SettlementLocalDraft;
  return (
    Number.isInteger(v.baseVersion) &&
    typeof v.publicReport === 'string' &&
    Array.isArray(v.results) &&
    v.results.every(
      (item) =>
        item &&
        typeof item.actionId === 'string' &&
        typeof item.feedback === 'string' &&
        (item.resultAudience === undefined ||
          (item.resultAudience &&
            (['OwnerOnly', 'Public', 'HostOnly'].includes(
              item.resultAudience.kind,
            ) ||
              (item.resultAudience.kind === 'Countries' &&
                Array.isArray(item.resultAudience.countryIds) &&
                item.resultAudience.countryIds.every(
                  (id) => typeof id === 'string',
                ))))),
    )
  );
}
import { BattleEditor, outcomeNames, toBattleInput } from './BattleEditor.js';
import {
  SettlementReport,
  SettlementResourceSummary,
} from './SettlementReport.js';

const seasonNames = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};

export function SettlementPanel({
  game,
  active = true,
  onQuarterChange,
  onDiscussAction,
  onMapReveal,
  onLocateReference,
  focus,
}: {
  game: GameSummary;
  active?: boolean;
  onQuarterChange: (quarter: QuarterSummary) => void;
  onDiscussAction?: (actionId: string) => Promise<void>;
  onMapReveal?: (input: Omit<MapRevealSeed, 'key'>) => void;
  onLocateReference?: (ref: MapActionReference) => Promise<void>;
  focus?: { actionId: string; key: number };
}) {
  const host = ['Host', 'Administrator'].includes(game.role);
  const readOnly = isGameReadOnly(game.status);
  const [rounds, setRounds] = useState<SettlementSummary[]>([]);
  const [data, setData] = useState<QuarterSettlement | null>(null);
  const [selected, setSelected] = useState('public');
  const [queueQuery, setQueueQuery] = useState('');
  const [onlyUnfilled, setOnlyUnfilled] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const localKey = useDraftKey(
    game.id,
    data?.quarter.id ?? game.currentQuarter.id,
    'settlement',
    'text',
  );
  const local = useLocalDraft(localKey, isSettlementDraft);
  const localCandidate = local.candidate;
  useEffect(() => {
    if (
      host &&
      !readOnly &&
      dirty &&
      data &&
      !data.publishedAt &&
      !localCandidate
    )
      local.write({
        baseVersion: data.version,
        publicReport: data.publicReport,
        results: data.actions.map(({ actionId, feedback, resultAudience }) => ({
          actionId,
          feedback,
          ...(resultAudience ? { resultAudience } : {}),
        })),
      });
  }, [host, readOnly, dirty, data, localCandidate, local.write]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [confirmPublish, setConfirmPublish] = useState(false);
  const selectedQuarter = useRef(game.currentQuarter.id);
  const dirtyRef = useRef(false);
  const generation = useRef(0);
  const operationInFlight = useRef(false);
  const handledFocus = useRef<number | undefined>(undefined);
  const detailPane = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (detailPane.current) detailPane.current.scrollTop = 0;
  }, [selected, data?.quarter.id]);

  function saveInput(current: QuarterSettlement): SaveSettlementInput {
    const incomplete = current.actions.find(
      (item) =>
        item.resultAudience?.kind === 'Countries' &&
        !item.resultAudience.countryIds.length,
    );
    if (incomplete)
      throw new Error(
        `“${incomplete.title}”尚未选择可见国家，请至少选择一个国家，或改为“仅主持人”。`,
      );
    return {
      expectedVersion: current.version,
      publicReport: current.publicReport,
      results: current.actions.map(
        ({ actionId, feedback, resultAudience }) => ({
          actionId,
          feedback,
          ...(resultAudience ? { resultAudience } : {}),
        }),
      ),
      ...(current.stateChanges
        ? {
            stateChanges: current.stateChanges.map(toStateChangeInput),
          }
        : {}),
      ...(current.battles
        ? { battles: current.battles.map(toBattleInput) }
        : {}),
      ...(current.diplomacyChanges
        ? { diplomacyChanges: current.diplomacyChanges.map(toDiplomacyInput) }
        : {}),
      ...(current.governmentChanges
        ? {
            governmentChanges: current.governmentChanges.map(toGovernmentInput),
          }
        : {}),
      ...(current.resourceChanges
        ? {
            resourceChanges: current.resourceChanges.map(
              ({
                countryName: _name,
                before: _before,
                after: _after,
                ...input
              }) => {
                void _name;
                void _before;
                void _after;
                return input;
              },
            ),
          }
        : {}),
      ...(current.recruitments
        ? { recruitments: current.recruitments.map(toRecruitmentInput) }
        : {}),
      ...(current.economicBill !== undefined
        ? {
            economicBill: current.economicBill
              ? toEconomicBillInput(current.economicBill)
              : null,
          }
        : {}),
      ...(current.stateChanges?.length ||
      current.battles?.length ||
      current.recruitments?.length
        ? { expectedMapRevision: current.mapRevision }
        : {}),
    };
  }

  function updateMapRevision(revision: number) {
    setData((current) =>
      current &&
      current.mapRevision !== revision &&
      (!dirtyRef.current ||
        (!current.stateChanges?.length &&
          !current.battles?.length &&
          !current.recruitments?.length))
        ? { ...current, mapRevision: revision }
        : current,
    );
    setConfirmPublish(false);
  }

  async function roll(
    battleId: string,
    input: Omit<BattleRollInput, 'expectedVersion' | 'expectedMapRevision'>,
  ) {
    if (!data || busy || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = dirtyRef.current
        ? await saveSettlement(game.id, data.quarter.id, saveInput(data))
        : data;
      if (dirtyRef.current) accept(saved);
      const next = await rollSettlementBattle(
        game.id,
        saved.quarter.id,
        battleId,
        {
          ...input,
          expectedVersion: saved.version,
          expectedMapRevision: saved.mapRevision ?? 0,
        },
      );
      accept(next);
      setMessage('已记录掷骰');
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }

  function modified(next: QuarterSettlement) {
    setData(next);
    setDirty(true);
    dirtyRef.current = true;
    setMessage('');
    setConfirmPublish(false);
  }

  function accept(next: QuarterSettlement) {
    setData(next);
    selectedQuarter.current = next.quarter.id;
    setDirty(false);
    dirtyRef.current = false;
    setConfirmPublish(false);
  }

  const load = useCallback(
    async (quarterId: string) => {
      const request = ++generation.current;
      setBusy(true);
      setError('');
      setData((current) =>
        current?.quarter.id === quarterId ? current : null,
      );
      try {
        const [roundList, settlement] = await Promise.all([
          fetchSettlements(game.id),
          fetchSettlement(game.id, quarterId),
        ]);
        if (request !== generation.current) return;
        setRounds(roundList);
        accept(settlement);
        setSelected((current) =>
          settlement.actions.some((action) => action.actionId === current)
            ? current
            : 'public',
        );
        setMessage('');
      } catch (cause) {
        if (request === generation.current)
          setError(cause instanceof Error ? cause.message : '结算加载失败');
      } finally {
        if (request === generation.current) setBusy(false);
      }
    },
    [game.id],
  );

  useEffect(() => {
    if (active && !dirtyRef.current)
      void load(
        focus && handledFocus.current !== focus.key
          ? game.currentQuarter.id
          : selectedQuarter.current,
      );
  }, [
    active,
    load,
    focus?.key,
    game.currentQuarter.state,
    game.currentQuarter.currentWorldVersion,
  ]);
  useEffect(() => {
    if (!active || !focus || handledFocus.current === focus.key || !data)
      return;
    if (data.quarter.id !== game.currentQuarter.id) {
      if (dirtyRef.current)
        setError('请先保存当前结算草稿，再打开其他回合的政策。');
      return;
    }
    if (data.actions.some((action) => action.actionId === focus.actionId)) {
      setSelected(focus.actionId);
      handledFocus.current = focus.key;
    }
  }, [active, focus, data, game.currentQuarter.id]);

  useEffect(() => {
    if (
      !active ||
      correcting ||
      dirty ||
      !data ||
      (host &&
        data.isCurrent &&
        data.quarter.state === 'Resolving' &&
        !data.publishedAt)
    )
      return;
    let live = true;
    const quarterId = data.quarter.id;
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      const request = generation.current;
      void Promise.all([
        fetchSettlement(game.id, quarterId),
        fetchSettlements(game.id),
      ])
        .then(([next, list]) => {
          if (
            live &&
            request === generation.current &&
            !dirtyRef.current &&
            selectedQuarter.current === quarterId
          ) {
            setData(next);
            setRounds(list);
          }
        })
        .catch(() => undefined);
    }, 5000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [
    active,
    correcting,
    dirty,
    data?.quarter.id,
    data?.quarter.state,
    data?.publishedAt,
    game.id,
    host,
  ]);

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => {
      ++generation.current;
      window.removeEventListener('beforeunload', beforeUnload);
    };
  }, []);

  async function generateEconomy() {
    if (!data || busy || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const economicBill = await fetchEconomicPreview(
        game.id,
        data.quarter.id,
        data.version,
      );
      modified({ ...data, economicBill });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '经济账单生成失败');
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }

  async function perform(operation: 'begin' | 'save' | 'publish' | 'advance') {
    if (!data || busy || operationInFlight.current) return;
    operationInFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      if (operation === 'advance') {
        const next = await advanceQuarter(game.id, data.quarter.id);
        selectedQuarter.current = next.id;
        onQuarterChange(next);
        await load(next.id);
        return;
      }
      const next =
        operation === 'begin'
          ? await beginSettlement(game.id, data.quarter.id)
          : operation === 'save'
            ? await saveSettlement(game.id, data.quarter.id, saveInput(data))
            : await publishSettlement(
                game.id,
                data.quarter.id,
                data.version,
                data.mapRevision,
              );
      if (
        local.session.saved &&
        next.publicReport === local.session.saved.value.publicReport &&
        local.session.saved.value.results.every((result) => {
          const action = next.actions.find(
            (action) => action.actionId === result.actionId,
          );
          return (
            action?.feedback === result.feedback &&
            (result.resultAudience === undefined ||
              JSON.stringify(action.resultAudience) ===
                JSON.stringify(result.resultAudience))
          );
        })
      )
        local.clear();
      accept(next);
      setRounds(await fetchSettlements(game.id));
      if (next.isCurrent) onQuarterChange(next.quarter);
      if (operation === 'save') setMessage('已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '结算操作失败');
      setConfirmPublish(false);
    } finally {
      operationInFlight.current = false;
      setBusy(false);
    }
  }

  const editable =
    host &&
    !readOnly &&
    data?.isCurrent &&
    data.quarter.state === 'Resolving' &&
    !data.publishedAt;
  const action = data?.actions.find((item) => item.actionId === selected);
  const reveal = data?.mapReveals?.find((item) => item.actionId === selected);
  const missing =
    data?.actions.filter((item) => !item.feedback.trim()).length ?? 0;
  const unresolved =
    data?.battles?.filter((item) => !item.resolution).length ?? 0;
  const automaticResources: ResourceChange[] =
    data?.economicBill?.lines.map((line) => ({
      id: line.id,
      actionId: null,
      countryId: line.countryId,
      countryName: line.countryName,
      resource: line.resource,
      amount: line.amount,
      expectedResourceRevision: line.expectedResourceRevision,
      reason: '每季经济结算',
      before: 0,
      after: 0,
    })) ?? [];
  const missingEconomy =
    data?.economyStatus?.status === 'Ready' && !data.economicBill;
  const queueActions =
    data?.actions.filter(
      (item) =>
        (!onlyUnfilled || !item.feedback.trim()) &&
        `${item.title} ${item.countryName}`
          .toLocaleLowerCase()
          .includes(queueQuery.trim().toLocaleLowerCase()),
    ) ?? [];

  return (
    <section className="work-center settlement-panel">
      <header className="center-heading">
        <h3>{host ? '回合结算' : '回合结果'}</h3>
        <div className="settlement-controls">
          {rounds.length > 1 && (
            <select
              aria-label="查看回合"
              disabled={busy || correcting}
              value={data?.quarter.id ?? selectedQuarter.current}
              onChange={(event) => {
                if (dirty) {
                  setError('请先保存草稿，或放弃修改并刷新。');
                  return;
                }
                selectedQuarter.current = event.target.value;
                void load(event.target.value);
              }}
            >
              {rounds.map((round) => (
                <option value={round.quarterId} key={round.quarterId}>
                  第 {round.gameYear} 年 {seasonNames[round.season]}
                  {round.isCurrent ? '（当前）' : ''}
                  {round.correctedAt ? ' · 已更正' : ''}
                </option>
              ))}
            </select>
          )}
          <button
            disabled={busy}
            onClick={() => {
              if (dirty) local.clear();
              void load(selectedQuarter.current);
            }}
          >
            {dirty ? '放弃修改并刷新' : '刷新'}
          </button>
        </div>
      </header>
      {error && (
        <p className="form-error settlement-notice" role="alert">
          {error}
        </p>
      )}
      {host && local.error && (
        <p className="form-error settlement-notice" role="alert">
          {local.error}
        </p>
      )}
      {host && data && localCandidate && (
        <DraftRecovery
          label="结算文字稿"
          savedAt={localCandidate.savedAt}
          canRestore={
            !!editable &&
            localCandidate.value.baseVersion === data.version &&
            localCandidate.value.results.every((result) =>
              data.actions.some(
                (action) => action.actionId === result.actionId,
              ),
            )
          }
          preview={[
            localCandidate.value.publicReport,
            ...localCandidate.value.results.map(
              (result) =>
                `${data.actions.find((action) => action.actionId === result.actionId)?.title ?? '政策反馈'}\n${result.feedback}\n可见范围：${resultAudienceLabel(result.resultAudience, data.resultCountries)}`,
            ),
          ].join('\n\n')}
          onDiscard={local.clear}
          onRestore={() => {
            const saved = localCandidate.value;
            local.resume();
            modified({
              ...data,
              publicReport: saved.publicReport,
              actions: data.actions.map((action) => ({
                ...action,
                resultAudience:
                  saved.results.find(
                    (result) => result.actionId === action.actionId,
                  )?.resultAudience ?? action.resultAudience,
                feedback:
                  saved.results.find(
                    (result) => result.actionId === action.actionId,
                  )?.feedback ?? action.feedback,
              })),
            });
          }}
        />
      )}
      {!data && !error && <LoadingSkeleton label="正在读取回合结算…" />}
      {data && !editable && !data.publishedAt && (
        <div className="center-detail">
          <p className="muted">
            {readOnly
              ? '本回合未发布。'
              : host
                ? '完成政策审核后开始结算。'
                : '本回合尚未发布结果。'}
          </p>
          {rounds.some((round) => round.correctedAt) && (
            <button
              onClick={() => {
                const latest = [...rounds]
                  .filter((round) => round.correctedAt)
                  .sort((a, b) =>
                    b.correctedAt!.localeCompare(a.correctedAt!),
                  )[0]!;
                selectedQuarter.current = latest.quarterId;
                void load(latest.quarterId);
              }}
            >
              查看最近更正
            </button>
          )}
          {host &&
            !readOnly &&
            data.isCurrent &&
            data.quarter.state === 'HostReview' && (
              <button
                className="button button--primary"
                disabled={busy}
                onClick={() => void perform('begin')}
              >
                开始结算
              </button>
            )}
        </div>
      )}
      {data && editable && (
        <>
          <fieldset
            className="draft-fields settlement-editing"
            hidden={confirmPublish}
            disabled={busy || !!localCandidate}
          >
            {data.economyStatus && data.economyStatus.status !== 'Disabled' && (
              <EconomicBillPanel
                key={data.quarter.id}
                status={data.economyStatus}
                bill={data.economicBill ?? null}
                busy={busy}
                onGenerate={generateEconomy}
                onChange={(economicBill) => modified({ ...data, economicBill })}
              />
            )}
            <div className="center-layout">
              <aside className="center-list" aria-label="待结算政策">
                <div className="queue-tools">
                  <input
                    type="search"
                    aria-label="搜索待结算政策"
                    placeholder="搜索政策或国家"
                    value={queueQuery}
                    onChange={(event) => setQueueQuery(event.target.value)}
                  />
                  <label className="queue-checkbox">
                    <input
                      type="checkbox"
                      checked={onlyUnfilled}
                      onChange={(event) =>
                        setOnlyUnfilled(event.target.checked)
                      }
                    />
                    只看未填写
                  </label>
                </div>
                {!!data.actions.length && (
                  <div className="settlement-progress">
                    <span>
                      已填写 {data.actions.length - missing} /{' '}
                      {data.actions.length}
                    </span>
                    <button
                      disabled={busy || !missing}
                      onClick={() => {
                        const current = data.actions.findIndex(
                          (item) => item.actionId === selected,
                        );
                        const ordered = [
                          ...data.actions.slice(current + 1),
                          ...data.actions.slice(0, current + 1),
                        ];
                        const next = ordered.find(
                          (item) => !item.feedback.trim(),
                        );
                        if (next) setSelected(next.actionId);
                      }}
                    >
                      下一项待填写
                    </button>
                  </div>
                )}
                <button
                  className={selected === 'public' ? 'center-list__active' : ''}
                  disabled={busy}
                  onClick={() => setSelected('public')}
                >
                  回合公报
                </button>
                {[...new Set(queueActions.map((item) => item.countryId))].map(
                  (countryId) => (
                    <Fragment key={countryId}>
                      <strong className="settlement-queue-country">
                        {
                          data.actions.find(
                            (item) => item.countryId === countryId,
                          )!.countryName
                        }
                      </strong>
                      {queueActions
                        .filter((item) => item.countryId === countryId)
                        .map((item) => (
                          <button
                            className={
                              selected === item.actionId
                                ? 'center-list__active'
                                : ''
                            }
                            key={item.actionId}
                            aria-label={`${item.title} ${item.countryName} · ${item.feedback.trim() ? '已填写' : '未填写'}`}
                            disabled={busy}
                            onClick={() => setSelected(item.actionId)}
                          >
                            <strong>{item.title}</strong>
                            <small>
                              {item.feedback.trim() ? '已填写' : '未填写'}
                            </small>
                          </button>
                        ))}
                    </Fragment>
                  ),
                )}
                {data.actions.length > 0 && queueActions.length === 0 && (
                  <div className="queue-empty">
                    <p>没有匹配的政策。</p>
                    <button
                      type="button"
                      onClick={() => {
                        setQueueQuery('');
                        setOnlyUnfilled(false);
                      }}
                    >
                      显示全部政策
                    </button>
                  </div>
                )}
              </aside>
              <div className="center-detail" ref={detailPane}>
                {!action ? (
                  <label>
                    回合公报（全员可见）
                    <textarea
                      rows={15}
                      maxLength={20_000}
                      disabled={busy}
                      value={data.publicReport}
                      onChange={(event) =>
                        modified({ ...data, publicReport: event.target.value })
                      }
                    />
                  </label>
                ) : (
                  <div className="action-editor settlement-policy-editor">
                    <div className="settlement-policy-heading">
                      <h4>
                        {action.countryName} · {action.title}
                        {action.status === 'Rejected' ? '（已拒绝）' : ''}
                      </h4>
                      {onDiscussAction && (
                        <button
                          onClick={() =>
                            void onDiscussAction(action.actionId).catch(
                              (cause: unknown) =>
                                setError(
                                  cause instanceof Error
                                    ? cause.message
                                    : '讨论打开失败',
                                ),
                            )
                          }
                        >
                          讨论这份政策
                        </button>
                      )}
                    </div>
                    <ActionMapLinks
                      refs={action.refs}
                      onLocate={onLocateReference}
                    />
                    <details className="settlement-original">
                      <summary>政策原文</summary>
                      <pre className="action-original">
                        {action.submittedText}
                      </pre>
                    </details>
                    {action.reviewReason && (
                      <p className="rules-text settlement-review-note">
                        审核意见：{action.reviewReason}
                      </p>
                    )}
                    <div className="settlement-feedback-tools">
                      {action.status === 'Approved' && onMapReveal && (
                        <div className="settlement-map-result">
                          <button
                            disabled={busy}
                            onClick={() =>
                              onMapReveal({
                                actionId: action.actionId,
                                title: action.title,
                                countryId: action.countryId,
                                tileIds: reveal?.tileIds ?? [],
                              })
                            }
                          >
                            设置探索结果
                          </button>
                          {reveal && (
                            <p className="rules-text">
                              将揭示 {reveal.tileIds.length} 个地块（
                              {discoveryNames[reveal.state]}）
                              {reveal.note && `：${reveal.note}`}
                            </p>
                          )}
                        </div>
                      )}
                      <AssistantPanel
                        key={`assistant:${data.quarter.id}:${action.actionId}`}
                        gameId={game.id}
                        input={{
                          purpose: 'Feedback',
                          quarterId: data.quarter.id,
                          actionId: action.actionId,
                          expectedVersion: data.version,
                          expectedCorrectionVersion:
                            data.corrections?.length ?? 0,
                        }}
                        contextKey={JSON.stringify([data, action.feedback])}
                        disabled={busy || dirty}
                        disabledReason={
                          dirty
                            ? '请先保存本回合草稿，确保起草依据与结算计划一致。'
                            : undefined
                        }
                        onAdopt={(feedback) =>
                          modified({
                            ...data,
                            actions: data.actions.map((item) =>
                              item.actionId === action.actionId
                                ? { ...item, feedback }
                                : item,
                            ),
                          })
                        }
                      />
                    </div>
                    <ResultAudienceEditor
                      value={action.resultAudience}
                      countries={data.resultCountries ?? []}
                      ownerCountryId={action.countryId}
                      disabled={busy}
                      onChange={(resultAudience) =>
                        modified({
                          ...data,
                          actions: data.actions.map((item) =>
                            item.actionId === action.actionId
                              ? { ...item, resultAudience }
                              : item,
                          ),
                        })
                      }
                    />
                    <label>
                      政策结算反馈
                      <textarea
                        rows={12}
                        maxLength={20_000}
                        disabled={busy}
                        value={action.feedback}
                        onChange={(event) =>
                          modified({
                            ...data,
                            actions: data.actions.map((item) =>
                              item.actionId === action.actionId
                                ? { ...item, feedback: event.target.value }
                                : item,
                            ),
                          })
                        }
                      />
                    </label>
                  </div>
                )}
                {(!action || action.status === 'Approved') && (
                  <ResourceEditor
                    key={`resource:${data.quarter.id}:${selected}`}
                    gameId={game.id}
                    actionId={action?.actionId ?? null}
                    initialCountryId={action?.countryId}
                    changes={data.resourceChanges ?? []}
                    automaticResources={automaticResources}
                    busy={busy}
                    active={active}
                    onChange={(resourceChanges) =>
                      modified({ ...data, resourceChanges })
                    }
                  />
                )}
                {(!action || action.status === 'Approved') && (
                  <RecruitmentEditor
                    key={`recruitment:${data.quarter.id}:${selected}`}
                    gameId={game.id}
                    quarterId={data.quarter.id}
                    actionId={action?.actionId ?? null}
                    initialCountryId={action?.countryId}
                    items={data.recruitments ?? []}
                    manualResources={[
                      ...automaticResources,
                      ...(data.resourceChanges ?? []),
                    ]}
                    strengthTargets={[
                      ...(data.stateChanges ?? []),
                      ...(data.battles ?? []).flatMap((b) => b.effects),
                    ].flatMap((item) =>
                      item.kind === 'ArmyStrength' ? [item.armyId] : [],
                    )}
                    revision={data.mapRevision}
                    hasWorldChanges={
                      !!(
                        data.stateChanges?.length ||
                        data.battles?.length ||
                        data.recruitments?.length
                      )
                    }
                    busy={busy}
                    active={active}
                    onChange={(recruitments) =>
                      modified({ ...data, recruitments })
                    }
                    onRevision={updateMapRevision}
                  />
                )}
                {(!action || action.status === 'Approved') && (
                  <BattleEditor
                    key={`battle:${data.quarter.id}:${selected}`}
                    gameId={game.id}
                    quarterId={data.quarter.id}
                    actionId={action?.actionId ?? null}
                    battles={data.battles ?? []}
                    revision={data.mapRevision}
                    busy={busy}
                    active={active}
                    onChange={(battles) => modified({ ...data, battles })}
                    onRevision={updateMapRevision}
                    onRoll={roll}
                  />
                )}
                {(!action || action.status === 'Approved') && (
                  <StateChangeEditor
                    key={`${data.quarter.id}:${selected}`}
                    gameId={game.id}
                    quarterId={data.quarter.id}
                    actionId={action?.actionId ?? null}
                    refs={action?.refs}
                    changes={data.stateChanges ?? []}
                    revision={data.mapRevision}
                    busy={busy}
                    active={active}
                    onChange={(stateChanges) =>
                      modified({ ...data, stateChanges })
                    }
                    onRevision={updateMapRevision}
                  />
                )}
                {(!action || action.status === 'Approved') && (
                  <DiplomacyEditor
                    key={`diplomacy:${data.quarter.id}:${selected}`}
                    gameId={game.id}
                    actionId={action?.actionId ?? null}
                    changes={data.diplomacyChanges ?? []}
                    busy={busy}
                    active={active}
                    onChange={(diplomacyChanges) =>
                      modified({ ...data, diplomacyChanges })
                    }
                  />
                )}
                {(!action || action.status === 'Approved') && (
                  <GovernmentEditor
                    key={`government:${data.quarter.id}:${selected}`}
                    gameId={game.id}
                    actionId={action?.actionId ?? null}
                    initialCountryId={action?.countryId}
                    changes={data.governmentChanges ?? []}
                    busy={busy}
                    active={active}
                    onChange={(governmentChanges) =>
                      modified({ ...data, governmentChanges })
                    }
                  />
                )}
              </div>
            </div>
            <div className="settlement-actions">
              <button
                disabled={busy || !dirty}
                onClick={() => void perform('save')}
              >
                保存草稿
              </button>
              <button
                className="button button--primary"
                disabled={
                  busy ||
                  dirty ||
                  missing > 0 ||
                  missingEconomy ||
                  unresolved > 0 ||
                  (!data.actions.length && !data.publicReport.trim())
                }
                onClick={() => setConfirmPublish(true)}
              >
                发布本回合
              </button>
              <span className="muted" role="status">
                {busy
                  ? '处理中…'
                  : dirty
                    ? localKey && local.session.saved && !local.error
                      ? '文字已在此设备暂存；其他变化请保存草稿'
                      : '尚未保存'
                    : message}
              </span>
              {missing > 0 && (
                <span className="muted">{missing} 项政策尚未填写反馈</span>
              )}
              {unresolved > 0 && (
                <span className="muted">{unresolved} 场战斗待裁决</span>
              )}
              {missingEconomy && (
                <span className="muted">经济账单尚未生成</span>
              )}
            </div>
          </fieldset>
          {confirmPublish && (
            <div
              className="settlement-confirm"
              role="region"
              aria-label="发布前核对"
            >
              <h4>发布前核对</h4>
              <SettlementResourceSummary data={data} />
              <p>
                发布后，全体成员可见回合公报，各项反馈按下方可见范围送达。本回合结果及可见范围将锁定。
              </p>
              <details className="settlement-confirm-stories">
                <summary>公报与政策反馈</summary>
                {data.publicReport && (
                  <article>
                    <h5>回合公报</h5>
                    <p className="rules-text">{data.publicReport}</p>
                  </article>
                )}
                {data.actions.map((item) => (
                  <article key={item.actionId}>
                    <h5>
                      {item.countryName} · {item.title}
                    </h5>
                    <p className="rules-text">{item.feedback}</p>
                    <p>
                      结果可见范围：
                      {resultAudienceLabel(
                        item.resultAudience,
                        data.resultCountries,
                      )}
                    </p>
                  </article>
                ))}
              </details>
              {!!data.governmentChanges?.length && (
                <>
                  <p>
                    同时执行 {data.governmentChanges.length}{' '}
                    项行政变化，长期政策从下季生效：
                  </p>
                  {data.governmentChanges.map((c) => (
                    <GovernmentRecord key={c.id} change={c} />
                  ))}
                </>
              )}
              {!!data.diplomacyChanges?.length && (
                <>
                  <p>同时执行 {data.diplomacyChanges.length} 项外交变化：</p>
                  {data.diplomacyChanges.map((c) => (
                    <DiplomacyRecord key={c.id} change={c} />
                  ))}
                </>
              )}
              {data.economicBill && (
                <details className="settlement-accounting">
                  <summary>每季经济账单</summary>
                  <p>同时执行每季经济账单：</p>
                  <EconomicBillRecord bill={data.economicBill} />
                  <ul>
                    {data.economicBill.effects.map((c) => (
                      <li key={c.id}>
                        {c.countryName} · {resourceNames[c.resource]}{' '}
                        {signedAmount(c.amount)}（{c.before.toLocaleString()} →{' '}
                        {c.after.toLocaleString()}）
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              {!!data.mapReveals?.length && (
                <p>
                  同时发布 {data.mapReveals.length} 项探索结果，共涉及{' '}
                  {data.mapReveals.reduce(
                    (count, item) => count + item.tileIds.length,
                    0,
                  )}{' '}
                  次地块揭示。
                </p>
              )}
              {!!data.stateChanges?.length && (
                <>
                  <p>同时执行 {data.stateChanges.length} 项状态变化：</p>
                  <ul>
                    {data.stateChanges.map((change) => (
                      <li key={change.id}>
                        <StateChangeRecord
                          change={change}
                          prefix={
                            change.actionId
                              ? `${data.actions.find((item) => item.actionId === change.actionId)?.title ?? '政策'} · `
                              : '回合事件 · '
                          }
                        />
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!!data.resourceChanges?.length && (
                <>
                  <p>同时执行 {data.resourceChanges.length} 笔资源收支：</p>
                  <ul>
                    {data.resourceChanges.map((item) => (
                      <li key={item.id}>
                        {item.countryName} · {resourceNames[item.resource]}{' '}
                        {signedAmount(item.amount)}（
                        {item.before.toLocaleString()} →{' '}
                        {item.after.toLocaleString()}）· {item.reason}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {!!data.recruitments?.length && (
                <>
                  <p>同时执行 {data.recruitments.length} 项征兵：</p>
                  <ul>
                    {data.recruitments.map((item) => (
                      <li key={item.id}>{item.summary}</li>
                    ))}
                  </ul>
                  <RecruitmentCosts items={data.recruitments} />
                </>
              )}
              {!!data.battles?.length && (
                <>
                  <p>同时发布 {data.battles.length} 场战斗裁决：</p>
                  <ul>
                    {data.battles.map((battle) => (
                      <li key={battle.id}>
                        {battle.title} ·{' '}
                        {battle.resolution &&
                          outcomeNames[battle.resolution.outcome]}
                        <ul>
                          {battle.effects.map((effect) => (
                            <li key={effect.id}>{effect.summary}</li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <div className="settlement-confirm-actions">
                <button
                  className="button button--primary"
                  disabled={busy || dirty}
                  onClick={() => void perform('publish')}
                >
                  确认发布
                </button>
                <button
                  disabled={busy}
                  onClick={() => setConfirmPublish(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </>
      )}
      {data && (data.publishedAt || (readOnly && host && data.version > 0)) && (
        <div className="center-detail settlement-reading" ref={detailPane}>
          {data.publishedAt && (
            <AssistantPanel
              key={`digest:${game.id}:${data.quarter.id}`}
              gameId={game.id}
              input={{
                purpose: 'Digest',
                quarterId: data.quarter.id,
                expectedVersion: data.version,
                expectedCorrectionVersion: data.corrections?.length ?? 0,
              }}
              contextKey={JSON.stringify(data)}
            />
          )}
          <SettlementReport
            key={data.quarter.id}
            data={data}
            host={host}
            onDiscussAction={onDiscussAction}
            onLocateReference={onLocateReference}
            onError={setError}
          />
          {data.publishedAt && (
            <SettlementCorrections
              key={data.quarter.id}
              gameId={game.id}
              data={data}
              canCorrect={host && !readOnly}
              onCorrected={accept}
              onEditingChange={setCorrecting}
            />
          )}
          {host && !readOnly && data.isCurrent && (
            <button
              className="button button--primary"
              disabled={busy || correcting}
              onClick={() => void perform('advance')}
            >
              进入下一回合
            </button>
          )}
        </div>
      )}
    </section>
  );
}
