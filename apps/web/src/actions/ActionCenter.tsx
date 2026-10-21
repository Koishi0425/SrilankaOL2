import { isGameReadOnly } from '@srilanka/contracts';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type {
  ActionCategory,
  ActionDetails,
  ActionObjectRef,
  ActionSecrecy,
  ActionSummary,
  ActionVersion,
  GameSummary,
  GameRulesData,
  QuarterSummary,
} from '@srilanka/contracts';

import {
  ApiRequestError,
  createAction,
  fetchAction,
  fetchActions,
  fetchActionVersions,
  hostDecideAction,
  hostInterpretAction,
  saveActionVersion,
  submitAction,
  transitionQuarter,
  updateAction,
  withdrawAction,
} from '../api.js';
import { categories, categoryName } from './action-labels.js';
import {
  DraftRecovery,
  priorPolicyDraftKey,
  useDraftKey,
  useLocalDraft,
} from '../drafts/local-drafts.js';
import type { MapRevealSeed } from '../map/MapSetupPanel.js';
import {
  ActionMapLinks,
  type MapActionReference,
} from '../map/ActionMapLinks.js';

export interface ActionDraftSeed {
  key: number;
  title: string;
  category?: ActionCategory;
  ref: Omit<ActionObjectRef, 'id'>;
}

type DraftRef = Omit<ActionObjectRef, 'id'>;
interface PolicyLocalDraft {
  creationId?: string;
  quarterId: string;
  baseVersion: number | null;
  baseUpdatedAt: string | null;
  title: string;
  text: string;
  category: ActionCategory;
  secrecy: ActionSecrecy;
  refs: DraftRef[];
}
function isPolicyDraft(value: unknown): value is PolicyLocalDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as PolicyLocalDraft;
  if (typeof v.quarterId !== 'string') return false;
  if (
    v.creationId !== undefined &&
    (typeof v.creationId !== 'string' ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(v.creationId))
  )
    return false;
  return (
    (v.baseVersion === null || Number.isInteger(v.baseVersion)) &&
    (v.baseUpdatedAt === null || typeof v.baseUpdatedAt === 'string') &&
    typeof v.title === 'string' &&
    typeof v.text === 'string' &&
    categories.some(([key]) => key === v.category) &&
    ['OwnerOnly', 'Participants', 'Public'].includes(v.secrecy) &&
    Array.isArray(v.refs) &&
    v.refs.every(
      (ref) =>
        ref &&
        ['Actor', 'Target', 'Context'].includes(ref.refKind) &&
        [
          'Tile',
          'City',
          'Army',
          'Country',
          'Character',
          'Region',
          'Province',
        ].includes(ref.objectType) &&
        typeof ref.objectId === 'string' &&
        typeof ref.label === 'string',
    )
  );
}

export function mergeActionRefs(
  current: DraftRef[],
  incoming: DraftRef,
): DraftRef[] {
  const duplicate = current.some(
    (ref) =>
      ref.refKind === incoming.refKind &&
      ref.objectType === incoming.objectType &&
      ref.objectId === incoming.objectId,
  );
  return duplicate ? current : [...current, incoming];
}

export function applyMapSeedToDraft(
  current: {
    title: string;
    text: string;
    category: ActionCategory;
    refs: DraftRef[];
  },
  seed: ActionDraftSeed,
) {
  return {
    ...current,
    title: current.title || seed.title,
    category:
      !current.title && !current.text && !current.refs.length
        ? (seed.category ??
          (current.category === 'Custom'
            ? ('Policy' as const)
            : current.category))
        : current.category === 'Custom'
          ? ('Policy' as const)
          : current.category,
    refs: mergeActionRefs(current.refs, seed.ref),
  };
}

export function editableFieldsFromVersion(version: ActionVersion) {
  return {
    title: version.title,
    text: version.originalText,
    category: version.category,
    secrecy: version.secrecy,
  };
}

export const statusNames: Record<ActionSummary['status'], string> = {
  Draft: '草稿',
  Submitted: '已提交',
  HostReview: '主持人审核中',
  NeedPlayerInput: '需要补充',
  AIStructuring: 'AI 整理中',
  PendingHostApproval: '待主持人批准',
  PendingPlayerConfirmation: '待玩家确认',
  Approved: '已批准',
  Rejected: '已拒绝',
  Resolving: '结算中',
  Completed: '已完成',
  Withdrawn: '已撤回',
  Invalidated: '已失效',
};

const secrecyNames: Record<ActionSecrecy, string> = {
  OwnerOnly: '仅本国与主持人',
  Participants: '请求告知相关方',
  Public: '请求公开',
};

export function ActionCenter({
  game,
  rules,
  seed,
  onQuarterChange,
  onSeedConsumed,
  onOpenSettlement,
  onDiscussAction,
  onMapReveal,
  onLocateReference,
  onPrepareOpening,
  focus,
  active = true,
  variant = 'standalone',
}: {
  game: GameSummary;
  rules?: GameRulesData | null;
  seed?: ActionDraftSeed;
  onQuarterChange?: (quarter: QuarterSummary) => void;
  onSeedConsumed?: (key: number) => void;
  onOpenSettlement?: (actionId?: string) => void;
  onLocateReference?: (ref: MapActionReference) => Promise<void>;
  onDiscussAction?: (actionId: string) => Promise<void>;
  onMapReveal?: (input: Omit<MapRevealSeed, 'key'>) => void;
  onPrepareOpening?: () => void;
  focus?: { actionId: string; key: number };
  active?: boolean;
  variant?: 'standalone' | 'map';
}) {
  const host = game.role === 'Host' || game.role === 'Administrator';
  const readOnly = isGameReadOnly(game.status);
  const [quarter, setQuarter] = useState<QuarterSummary>(game.currentQuarter);
  const [items, setItems] = useState<ActionSummary[]>([]);
  const [query, setQuery] = useState('');
  const [queueFilter, setQueueFilter] = useState('all');
  const titleInput = useRef<HTMLInputElement>(null);
  const detailPane = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState<ActionDetails | null>(null);
  useEffect(() => {
    if (detailPane.current) detailPane.current.scrollTop = 0;
  }, [selected?.id]);
  const needsAttention = (item: ActionSummary) =>
    (host
      ? ['Submitted', 'HostReview', 'PendingHostApproval']
      : ['NeedPlayerInput', 'PendingPlayerConfirmation']
    ).includes(item.status);
  const visibleItems = items.filter((item) => {
    const matchesText =
      `${item.title} ${item.countryName} ${categoryName(item.category)}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase());
    const matchesStatus =
      queueFilter === 'all' ||
      (queueFilter === 'attention' && needsAttention(item)) ||
      (queueFilter === 'draft' &&
        ['Draft', 'Withdrawn'].includes(item.status)) ||
      (queueFilter === 'finished' &&
        ['Approved', 'Rejected', 'Completed', 'Invalidated'].includes(
          item.status,
        ));
    return matchesText && matchesStatus;
  });
  const [versions, setVersions] = useState<ActionVersion[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState<ActionCategory>('Custom');
  const [secrecy, setSecrecy] = useState<ActionSecrecy>('OwnerOnly');
  const [refs, setRefs] = useState<DraftRef[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [reviewText, setReviewText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [creatingDraft, setCreatingDraft] = useState(false);
  const createPending = useRef(false);
  const creationId = useRef<string>(crypto.randomUUID());
  const creationQuarter = useRef(quarter.id);
  if (creationQuarter.current !== quarter.id) {
    creationQuarter.current = quarter.id;
    creationId.current = crypto.randomUUID();
  }
  const localKey = useDraftKey(
    game.id,
    selected?.quarterId ?? quarter.id,
    'policy',
    selected?.id ?? 'new',
  );
  const local = useLocalDraft(
    selected ? localKey : priorPolicyDraftKey(localKey),
    isPolicyDraft,
  );
  const localCandidate = local.candidate;
  const canRestoreLocal =
    local.candidate?.value.quarterId === quarter.id &&
    !readOnly &&
    !host &&
    (!selected ||
      (selected.quarterId === quarter.id &&
        ['Draft', 'NeedPlayerInput'].includes(selected.status))) &&
    (!selected
      ? localCandidate?.value.baseVersion === null
      : localCandidate?.value.baseVersion === selected.version &&
        localCandidate.value.baseUpdatedAt === selected.updatedAt);

  useEffect(() => {
    if (host || readOnly || localCandidate || creatingDraft) return;
    const fields = { title, text, category, secrecy, refs };
    const same =
      selected &&
      JSON.stringify(fields) ===
        JSON.stringify({
          title: selected.title,
          text: selected.currentText,
          category: selected.category,
          secrecy: selected.secrecy,
          refs: selected.refs.map(({ id: _id, ...ref }) => ref),
        });
    if ((!selected && !title && !text && !refs.length) || same) {
      if (local.session.saved) local.clear();
      return;
    }
    if (
      selected &&
      (selected.quarterId !== quarter.id ||
        !['Draft', 'NeedPlayerInput'].includes(selected.status))
    )
      return;
    local.write({
      ...fields,
      ...(!selected ? { creationId: creationId.current } : {}),
      quarterId: quarter.id,
      baseVersion: selected?.version ?? null,
      baseUpdatedAt: selected?.updatedAt ?? null,
    });
  }, [
    host,
    readOnly,
    localCandidate,
    creatingDraft,
    title,
    text,
    category,
    secrecy,
    refs,
    selected,
    quarter.id,
    local.write,
    local.clear,
    local.session,
  ]);
  const handledSeedKey = useRef<number | null>(null);
  const activeActionId = useRef<string | null>(null);
  const handledFocus = useRef<number | undefined>(undefined);
  const listRequest = useRef(0);
  const liveSelection = useRef({
    selected,
    dirty,
    saving,
    savingVersion,
    confirmSubmit,
    saveFailed,
  });
  liveSelection.current = {
    selected,
    dirty,
    saving,
    savingVersion,
    confirmSubmit,
    saveFailed,
  };

  const load = useCallback(async () => {
    const request = ++listRequest.current;
    try {
      const next = (await fetchActions(game.id, host && !readOnly)).filter(
        (item) => readOnly || item.quarterId === game.currentQuarter.id,
      );
      if (request !== listRequest.current) return;
      setItems(next);
      return next;
    } catch (cause) {
      if (request === listRequest.current)
        setError(cause instanceof Error ? cause.message : '行动列表加载失败');
    }
  }, [game.id, game.currentQuarter.id, host, readOnly]);

  useEffect(() => setQuarter(game.currentQuarter), [game.currentQuarter]);

  useEffect(() => {
    if (!seed || host || handledSeedKey.current === seed.key) return;
    handledSeedKey.current = seed.key;

    const canAppendToSelected =
      selected && ['Draft', 'NeedPlayerInput'].includes(selected.status);
    if (selected && !canAppendToSelected) {
      creationId.current = crypto.randomUUID();
      activeActionId.current = null;
      setSelected(null);
      setTitle(seed.title);
      setText('');
      setCategory(seed.category ?? 'Policy');
      setSecrecy('OwnerOnly');
      setRefs([seed.ref]);
      setDirty(false);
      setSaving(false);
      setSaveFailed(false);
      setSaveState('已基于地图目标开始一份新草稿。');
      setConfirmSubmit(false);
      onSeedConsumed?.(seed.key);
      return;
    }

    const seededDraft = applyMapSeedToDraft(
      { title, text, category, refs },
      seed,
    );
    const added = seededDraft.refs !== refs;
    setRefs(seededDraft.refs);
    if (!selected) {
      setTitle(seededDraft.title);
      setCategory(seededDraft.category);
    } else if (added) {
      setDirty(true);
    }
    setSaveState(
      added
        ? selected
          ? '已加入地图目标，等待自动保存…'
          : '已加入地图目标，请继续编写草稿。'
        : '该地图目标已经在当前行动中。',
    );
    onSeedConsumed?.(seed.key);
  }, [category, host, onSeedConsumed, refs, seed, selected, text, title]);

  const edit = useCallback((details: ActionDetails) => {
    activeActionId.current = details.id;
    setSelected(details);
    setTitle(details.title);
    setText(details.currentText);
    setCategory(details.category);
    setSecrecy(details.secrecy);
    setRefs(details.refs.map(({ id: _id, ...ref }) => ref));
    setDirty(false);
    setSaving(false);
    setSaveFailed(false);
    setSavingVersion(false);
    setSaveState('');
    setConfirmSubmit(false);
  }, []);

  useEffect(() => {
    if (!active) return;
    let disposed = false,
      reading = false;
    async function refresh() {
      if (reading || document.hidden) return;
      reading = true;
      try {
        const next = await load();
        if (disposed || !next) return;
        const before = liveSelection.current;
        const previous = before.selected;
        if (
          !previous ||
          before.dirty ||
          before.saving ||
          before.savingVersion ||
          before.saveFailed ||
          before.confirmSubmit
        )
          return;
        const summary = next.find((item) => item.id === previous.id);
        const unfinishedHistory =
          previous.quarterId !== game.currentQuarter.id &&
          !['Completed', 'Rejected', 'Withdrawn', 'Invalidated'].includes(
            previous.status,
          );
        if (
          (!summary && !unfinishedHistory) ||
          (summary &&
            summary.version === previous.version &&
            summary.status === previous.status &&
            summary.updatedAt === previous.updatedAt)
        )
          return;
        const details = await fetchAction(game.id, previous.id);
        const current = liveSelection.current;
        if (
          disposed ||
          current.selected?.id !== previous.id ||
          current.selected.version !== previous.version ||
          current.selected.updatedAt !== previous.updatedAt ||
          current.dirty ||
          current.saving ||
          current.savingVersion ||
          current.saveFailed ||
          current.confirmSubmit
        )
          return;
        if (
          details.version === previous.version &&
          details.status === previous.status &&
          details.updatedAt === previous.updatedAt
        )
          return;
        edit(details);
        const history = await fetchActionVersions(game.id, details.id);
        if (
          !disposed &&
          activeActionId.current === details.id &&
          liveSelection.current.selected?.version === details.version
        )
          setVersions(history);
      } catch (cause) {
        if (!disposed)
          setError(cause instanceof Error ? cause.message : '行动更新失败');
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      ++listRequest.current;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, edit, game.id, game.currentQuarter.id, load]);

  const open = useCallback(
    async (actionId: string) => {
      try {
        const details = await fetchAction(game.id, actionId);
        if (activeActionId.current === actionId && local.session.saved)
          local.hold();
        edit(details);
        setVersions(await fetchActionVersions(game.id, actionId));
        setError('');
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '行动读取失败');
      }
    },
    [edit, game.id, local.session, local.hold],
  );

  useEffect(() => {
    if (!focus || handledFocus.current === focus.key) return;
    handledFocus.current = focus.key;
    void open(focus.actionId);
  }, [focus, open]);

  useEffect(() => {
    if (
      readOnly ||
      !!localCandidate ||
      host ||
      !selected ||
      !dirty ||
      saving ||
      !['Draft', 'NeedPlayerInput'].includes(selected.status)
    )
      return;
    setSaveState('等待自动保存…');
    const timeout = window.setTimeout(() => {
      setSaveState('正在保存…');
      setSaving(true);
      setSaveFailed(false);
      const expectedVersion = selected.version;
      setDirty(false);
      void updateAction(game.id, selected.id, {
        expectedVersion,
        title,
        originalText: text,
        category,
        secrecy,
        refs,
      })
        .then((details) => {
          if (activeActionId.current !== details.id) return;
          setSelected(details);
          setSaving(false);
          setSaveState('已自动保存');
          void load();
        })
        .catch((cause: unknown) => {
          if (activeActionId.current !== selected.id) return;
          if (
            cause instanceof ApiRequestError &&
            cause.code === 'ACTION_VERSION_CONFLICT'
          ) {
            setSaveState('保存冲突：请重新打开草稿后再编辑。');
          } else {
            setSaveState(cause instanceof Error ? cause.message : '保存失败');
          }
          setSaving(false);
          setSaveFailed(true);
        });
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [
    category,
    dirty,
    game.id,
    host,
    readOnly,
    localCandidate,
    load,
    refs,
    secrecy,
    saving,
    selected,
    text,
    title,
  ]);

  async function create(event: FormEvent) {
    event.preventDefault();
    if (selected || createPending.current || localCandidate) return;
    createPending.current = true;
    setCreatingDraft(true);
    try {
      const details = await createAction(game.id, {
        creationId: creationId.current,
        quarterId: quarter.id,
        title,
        originalText: text,
        category,
        secrecy,
        refs,
      });
      local.clear();
      edit(details);
      setVersions(await fetchActionVersions(game.id, details.id));
      setSaveState('草稿已创建');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建草稿失败');
      void load();
    } finally {
      createPending.current = false;
      setCreatingDraft(false);
    }
  }

  async function perform(action: 'submit' | 'withdraw') {
    if (!selected) return;
    try {
      const details =
        action === 'submit'
          ? await submitAction(game.id, selected.id)
          : await withdrawAction(game.id, selected.id);
      edit(details);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '行动操作失败');
    }
  }

  async function decide(decision: 'request-input' | 'approve' | 'reject') {
    if (!selected || !reason.trim()) return;
    try {
      edit(await hostDecideAction(game.id, selected.id, decision, reason));
      setReason('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '审核操作失败');
    }
  }

  async function saveInterpretation() {
    if (!selected || !reviewText.trim()) return;
    try {
      edit(await hostInterpretAction(game.id, selected.id, reviewText));
      setReviewText('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '整理稿保存失败');
    }
  }

  async function confirmVersion() {
    if (!selected || dirty || saving || saveFailed) return;
    setSavingVersion(true);
    try {
      const savedVersions = await saveActionVersion(
        game.id,
        selected.id,
        selected.version,
      );
      setVersions(savedVersions);
      setSaveState('版本已保存');
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '手动保存版本失败');
    } finally {
      setSavingVersion(false);
    }
  }

  function restoreVersion(version: ActionVersion) {
    if (
      host ||
      !selected ||
      !['Draft', 'NeedPlayerInput'].includes(selected.status) ||
      version.version === selected.version
    )
      return;
    const fields = editableFieldsFromVersion(version);
    setTitle(fields.title);
    setText(fields.text);
    setCategory(fields.category);
    setSecrecy(fields.secrecy);
    setDirty(true);
    setConfirmSubmit(false);
    setSaveState('已载入，等待自动保存…');
  }

  async function changeQuarter(
    state: 'ActionSubmission' | 'Locked' | 'HostReview',
  ) {
    try {
      const updated = await transitionQuarter(game.id, state);
      setQuarter(updated);
      onQuarterChange?.(updated);
      setError('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '季度状态修改失败');
    }
  }

  const editable =
    !readOnly &&
    !host &&
    selected &&
    selected.quarterId === quarter.id &&
    ['Draft', 'NeedPlayerInput'].includes(selected.status);
  const requestedSupplement =
    selected?.quarterId === quarter.id &&
    selected?.status === 'NeedPlayerInput' &&
    !!selected.pendingInputRequest;
  const canSubmit =
    quarter.state === 'ActionSubmission' ||
    (requestedSupplement && ['Locked', 'HostReview'].includes(quarter.state));
  const currentRules = rules?.quarterId === quarter.id ? rules.quarter : null;
  function countSubmitted(category: ActionCategory) {
    return items.filter(
      (item) =>
        item.quarterId === quarter.id &&
        item.category === category &&
        !['Draft', 'Withdrawn', 'Rejected', 'Invalidated'].includes(
          item.status,
        ),
    ).length;
  }
  const suggestedLimit = currentRules?.suggestedLimits.find(
    (item) => item.category === category,
  );
  const categoryCount = countSubmitted(category);
  const countedSelected =
    selected &&
    selected.quarterId === quarter.id &&
    selected.category === category &&
    !['Draft', 'Withdrawn', 'Rejected', 'Invalidated'].includes(
      selected.status,
    );
  const overSuggestion =
    suggestedLimit &&
    categoryCount + (countedSelected ? 0 : 1) > suggestedLimit.limit;

  return (
    <section
      className={`work-center action-center${variant === 'map' ? ' work-center--map' : ''}`}
    >
      <header className="center-heading">
        <div>
          <h3>
            {readOnly ? '政策记录' : host ? '主持人行动审核' : '政策与行动'}
          </h3>
        </div>
      </header>
      {host && !readOnly && (
        <div className="quarter-actions">
          {['Preparing', 'EventResponse', 'Locked', 'HostReview'].includes(
            quarter.state,
          ) && (
            <button
              className="button"
              onClick={() => {
                if (
                  quarter.state === 'Preparing' &&
                  quarter.sequenceNumber === 1 &&
                  onPrepareOpening
                )
                  onPrepareOpening();
                else void changeQuarter('ActionSubmission');
              }}
            >
              {['Locked', 'HostReview'].includes(quarter.state)
                ? '重新开放政策提交'
                : '开放政策提交'}
            </button>
          )}
          {quarter.state === 'ActionSubmission' && (
            <button
              className="button"
              onClick={() => void changeQuarter('Locked')}
            >
              锁定行动提交
            </button>
          )}
          {quarter.state === 'Locked' && (
            <button
              className="button"
              onClick={() => void changeQuarter('HostReview')}
            >
              进入主持人审核
            </button>
          )}
          {['HostReview', 'Resolving', 'Published'].includes(quarter.state) &&
            onOpenSettlement && (
              <button onClick={() => onOpenSettlement()}>前往结算</button>
            )}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      {currentRules &&
        (currentRules.briefing ||
          currentRules.actionGuidelines ||
          currentRules.suggestedLimits.length > 0) && (
          <details className="round-guidance">
            <summary>本回合行动指引</summary>
            {currentRules.briefing && (
              <p className="rules-text">{currentRules.briefing}</p>
            )}
            {currentRules.actionGuidelines && (
              <p className="rules-text">{currentRules.actionGuidelines}</p>
            )}
            <div className="tag-list">
              {currentRules.suggestedLimits.map((item) => (
                <span className="tag" key={item.category}>
                  {categoryName(item.category)}：
                  {host
                    ? `建议每国 ${item.limit} 项`
                    : `已提交 ${countSubmitted(item.category)} / 建议 ${item.limit} 项`}
                </span>
              ))}
            </div>
            {currentRules.suggestedLimits.length > 0 && (
              <p className="muted">超额仍可提交，由主持人裁决。</p>
            )}
          </details>
        )}
      <div className="center-layout">
        <aside className="center-list">
          <div className="queue-tools">
            <input
              type="search"
              aria-label="搜索政策"
              placeholder={host ? '搜索政策或国家' : '搜索政策'}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
            <select
              aria-label="筛选政策状态"
              value={queueFilter}
              onChange={(event) => setQueueFilter(event.target.value)}
            >
              <option value="all">全部政策 · {items.length}</option>
              <option value="attention">
                {host ? '待审核' : '待我处理'} ·{' '}
                {items.filter(needsAttention).length}
              </option>
              {!host && <option value="draft">草稿 / 已撤回</option>}
              <option value="finished">已处理</option>
            </select>
          </div>
          {!host && !readOnly && (
            <button
              className="button"
              type="button"
              onClick={() => {
                if (!selected) {
                  titleInput.current?.focus();
                  return;
                }
                activeActionId.current = null;
                creationId.current = crypto.randomUUID();
                setSelected(null);
                setTitle('');
                setText('');
                setCategory('Policy');
                setSecrecy('OwnerOnly');
                setRefs([]);
                setDirty(false);
                setSaving(false);
                setSaveFailed(false);
                setSaveState('选择地图地块可把它加入这份新草稿。');
                setConfirmSubmit(false);
              }}
            >
              新建政策 / 行动
            </button>
          )}
          {visibleItems.map((item) => (
            <button
              className={selected?.id === item.id ? 'center-list__active' : ''}
              key={item.id}
              aria-current={selected?.id === item.id ? 'true' : undefined}
              onClick={() => void open(item.id)}
            >
              <strong>{item.title}</strong>
              <small>
                {item.countryName} · {statusNames[item.status]}
              </small>
            </button>
          ))}
          {items.length === 0 && <p className="muted">暂无行动。</p>}
          {items.length > 0 && visibleItems.length === 0 && (
            <div className="queue-empty">
              <p>没有匹配的政策。</p>
              <button
                type="button"
                onClick={() => {
                  setQuery('');
                  setQueueFilter('all');
                }}
              >
                显示全部政策
              </button>
            </div>
          )}
        </aside>
        <div className="center-detail" ref={detailPane}>
          {!host && local.error && (
            <p role="alert" className="form-error">
              {local.error}
            </p>
          )}
          {!host && localCandidate && (
            <DraftRecovery
              savedAt={localCandidate.savedAt}
              canRestore={canRestoreLocal}
              preview={`${localCandidate.value.title}\n\n${localCandidate.value.text}`}
              onDiscard={local.clear}
              onRestore={() => {
                const saved = localCandidate.value;
                if (!selected && saved.creationId)
                  creationId.current = saved.creationId;
                setTitle(saved.title);
                setText(saved.text);
                setCategory(saved.category);
                setSecrecy(saved.secrecy);
                setRefs(saved.refs);
                local.resume();
                setDirty(true);
                setSaveState('已恢复本地稿，尚未保存到服务器');
              }}
            />
          )}
          {!host && !readOnly && (!selected || editable) && (
            <form
              className="action-editor"
              onSubmit={(event) => void create(event)}
            >
              <fieldset
                className="draft-fields"
                disabled={!!localCandidate || creatingDraft}
              >
                <label>
                  行动标题
                  <input
                    ref={titleInput}
                    required
                    maxLength={160}
                    value={title}
                    onChange={(event) => {
                      setTitle(event.target.value);
                      setDirty(true);
                    }}
                  />
                </label>
                <div className="inline-fields">
                  <label>
                    类别
                    <select
                      value={category}
                      onChange={(event) => {
                        setCategory(event.target.value as ActionCategory);
                        setDirty(true);
                      }}
                    >
                      {categories.map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    公开意向
                    <select
                      value={secrecy}
                      onChange={(event) => {
                        setSecrecy(event.target.value as ActionSecrecy);
                        setDirty(true);
                      }}
                    >
                      <option value="OwnerOnly">仅本国与主持人</option>
                      <option value="Participants">请主持人告知相关方</option>
                      <option value="Public">请主持人公开</option>
                    </select>
                  </label>
                </div>
                {overSuggestion && (
                  <p className="review-request">
                    此行动将超出{categoryName(category)}
                    的建议额度，仍可提交，请说明特殊安排，交由主持人裁决。
                  </p>
                )}
                {refs.length > 0 && (
                  <div className="reference-list" aria-label="行动关联目标">
                    {refs.map((ref) => (
                      <span
                        className="tag"
                        key={`${ref.refKind}-${ref.objectId}`}
                      >
                        {ref.label || ref.objectId}
                        <button
                          type="button"
                          aria-label={`移除目标 ${ref.label || ref.objectId}`}
                          onClick={() => {
                            setRefs((current) =>
                              current.filter(
                                (item) =>
                                  !(
                                    item.refKind === ref.refKind &&
                                    item.objectType === ref.objectType &&
                                    item.objectId === ref.objectId
                                  ),
                              ),
                            );
                            if (selected) setDirty(true);
                            setSaveState(
                              selected
                                ? '已移除地图目标，等待自动保存…'
                                : '已从新草稿移除地图目标。',
                            );
                          }}
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <label>
                  政策 / 行动内容
                  <textarea
                    rows={12}
                    maxLength={20_000}
                    value={text}
                    onChange={(event) => {
                      setText(event.target.value);
                      setDirty(true);
                    }}
                    placeholder="填写目标、做法和投入"
                  />
                </label>
                {!selected && (
                  <button className="button" type="submit">
                    {creatingDraft ? '创建中…' : '创建草稿'}
                  </button>
                )}
                {!selected &&
                  localKey &&
                  local.session.saved &&
                  !localCandidate &&
                  !local.error && (
                    <p className="muted" role="status">
                      已在此设备暂存，尚未创建政策
                    </p>
                  )}
                {selected && (
                  <div className="draft-save-status">
                    <div>
                      <p className="muted">{saveState || '已保存'}</p>
                    </div>
                    <button
                      className="button"
                      type="button"
                      disabled={dirty || saving || saveFailed || savingVersion}
                      onClick={() => void confirmVersion()}
                    >
                      {savingVersion
                        ? '正在保存版本…'
                        : dirty || saving
                          ? '等待自动保存'
                          : '手动保存版本'}
                    </button>
                    {saveFailed && (
                      <button
                        className="button"
                        type="button"
                        onClick={() => setDirty(true)}
                      >
                        重试保存草稿
                      </button>
                    )}
                  </div>
                )}
              </fieldset>
            </form>
          )}
          {selected && (
            <div className="action-status-panel">
              <h4>{selected.title}</h4>
              <ActionMapLinks
                refs={selected.submissions[0]?.refs ?? selected.refs}
                onLocate={onLocateReference}
              />
              {host &&
                !readOnly &&
                onOpenSettlement &&
                selected.quarterId === quarter.id &&
                selected.status === 'Approved' &&
                ['HostReview', 'Resolving'].includes(quarter.state) && (
                  <button onClick={() => onOpenSettlement(selected.id)}>
                    结算这份政策
                  </button>
                )}
              {selected.quarterId !== quarter.id && (
                <p className="muted">历史回合政策</p>
              )}
              {onDiscussAction && (
                <button
                  type="button"
                  disabled={!host && (dirty || saving || saveFailed)}
                  onClick={() =>
                    void onDiscussAction(selected.id).catch((cause: unknown) =>
                      setError(
                        cause instanceof Error ? cause.message : '讨论打开失败',
                      ),
                    )
                  }
                >
                  讨论这份政策
                </button>
              )}
              {host &&
                onMapReveal &&
                selected.quarterId === game.currentQuarter.id &&
                selected.status === 'Approved' &&
                [
                  'ActionSubmission',
                  'Locked',
                  'HostReview',
                  'Resolving',
                ].includes(quarter.state) && (
                  <button
                    onClick={() =>
                      onMapReveal({
                        actionId: selected.id,
                        title: selected.title,
                        countryId: selected.countryId,
                        tileIds: selected.refs
                          .filter((ref) => ref.objectType === 'Tile')
                          .map((ref) => ref.objectId),
                      })
                    }
                  >
                    设置探索结果
                  </button>
                )}
              <p>
                <span className="tag">{statusNames[selected.status]}</span>
              </p>
              {selected.pendingInputRequest && (
                <p className="review-request">
                  主持人要求补充：{selected.pendingInputRequest}
                </p>
              )}
              {(host || !editable) && (
                <div>
                  <h5>
                    {selected.submittedOriginalText === null
                      ? '行动草稿'
                      : '最新正式提交内容'}
                  </h5>
                  {selected.submissions[0] && (
                    <p className="muted">
                      {selected.submissions[0].title} ·{' '}
                      {categoryName(selected.submissions[0].category)} ·{' '}
                      {secrecyNames[selected.submissions[0].secrecy]}
                    </p>
                  )}
                  <pre className="action-original">
                    {selected.submissions[0]?.text ??
                      selected.submittedOriginalText ??
                      selected.currentText}
                  </pre>
                  {host && !readOnly && requestedSupplement && (
                    <p className="muted">等待玩家重新提交补充内容。</p>
                  )}
                </div>
              )}
              {selected.latestInterpretation && (
                <div>
                  <h5>主持人整理稿</h5>
                  <p>{selected.latestInterpretation}</p>
                </div>
              )}
              {!host &&
                !readOnly &&
                ['Draft', 'NeedPlayerInput'].includes(selected.status) && (
                  <div className="confirm-action">
                    {!canSubmit ? (
                      <p className="muted">当前未开放提交。</p>
                    ) : !confirmSubmit ? (
                      <button
                        className="button"
                        type="button"
                        disabled={dirty || saving || saveFailed}
                        onClick={() => setConfirmSubmit(true)}
                      >
                        {saveFailed
                          ? '请先解决草稿保存失败'
                          : dirty || saving
                            ? '请等待草稿保存完成'
                            : '准备提交'}
                      </button>
                    ) : (
                      <div className="confirmation-box">
                        <strong>提交后交由主持人审核，正文将锁定。</strong>
                        <button
                          className="button"
                          type="button"
                          disabled={dirty || saving || saveFailed}
                          onClick={() => void perform('submit')}
                        >
                          确认正式提交
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmSubmit(false)}
                        >
                          取消
                        </button>
                      </div>
                    )}
                  </div>
                )}
              {!host &&
                !readOnly &&
                selected.quarterId === quarter.id &&
                quarter.state === 'ActionSubmission' &&
                [
                  'Submitted',
                  'HostReview',
                  'NeedPlayerInput',
                  'PendingHostApproval',
                ].includes(selected.status) && (
                  <button
                    type="button"
                    onClick={() => void perform('withdraw')}
                  >
                    撤回行动
                  </button>
                )}
              {host &&
                !readOnly &&
                selected.quarterId === quarter.id &&
                selected.status !== 'Draft' &&
                ['ActionSubmission', 'Locked', 'HostReview'].includes(
                  quarter.state,
                ) && (
                  <div className="host-review-form">
                    <label>
                      主持人整理稿
                      <textarea
                        rows={5}
                        value={reviewText}
                        onChange={(event) => setReviewText(event.target.value)}
                      />
                    </label>
                    <button
                      className="button"
                      onClick={() => void saveInterpretation()}
                    >
                      保存独立整理稿
                    </button>
                    <label>
                      审核说明
                      <textarea
                        rows={3}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                    <div className="review-buttons">
                      <button
                        disabled={
                          !['Submitted', 'HostReview'].includes(selected.status)
                        }
                        onClick={() => void decide('request-input')}
                      >
                        要求补充
                      </button>
                      <button
                        disabled={
                          ![
                            'Submitted',
                            'HostReview',
                            'PendingHostApproval',
                          ].includes(selected.status)
                        }
                        onClick={() => void decide('approve')}
                      >
                        批准
                      </button>
                      <button
                        disabled={
                          ![
                            'Submitted',
                            'HostReview',
                            'PendingHostApproval',
                          ].includes(selected.status)
                        }
                        onClick={() => void decide('reject')}
                      >
                        拒绝
                      </button>
                    </div>
                  </div>
                )}
              <details className="version-history">
                <summary>
                  正式提交（{selected.submissions.length}）、手动版本与状态历史
                </summary>
                <div className="version-history__section">
                  <h5>正式提交记录</h5>
                  {selected.submissions.map((submission, index) => (
                    <details className="version-entry" key={submission.id}>
                      <summary>
                        第 {selected.submissions.length - index} 次提交 ·{' '}
                        {new Date(submission.submittedAt).toLocaleString(
                          'zh-CN',
                        )}
                      </summary>
                      <div className="version-entry__content">
                        <h6>{submission.title}</h6>
                        <p>
                          {categoryName(submission.category)} ·{' '}
                          {secrecyNames[submission.secrecy]}
                        </p>
                        <pre className="action-original">{submission.text}</pre>
                        {submission.refs.length > 0 && (
                          <ul>
                            {submission.refs.map((ref) => (
                              <li
                                key={`${ref.refKind}-${ref.objectType}-${ref.objectId}`}
                              >
                                {ref.label || ref.objectId}
                              </li>
                            ))}
                          </ul>
                        )}
                      </div>
                    </details>
                  ))}
                  {selected.submittedOriginalText !== null && (
                    <details className="version-entry">
                      <summary>首次提交原文</summary>
                      <pre className="action-original">
                        {selected.submittedOriginalText}
                      </pre>
                    </details>
                  )}
                  {selected.submissions.length === 0 && (
                    <p className="muted">暂无提交记录。</p>
                  )}
                </div>
                <div className="version-history__section">
                  <h5>草稿版本</h5>
                  <div className="version-list">
                    {versions.map((version, index) => (
                      <details className="version-entry" key={version.version}>
                        <summary>
                          <strong>版本 {versions.length - index}</strong>
                          <time dateTime={version.createdAt}>
                            {new Date(version.createdAt).toLocaleString(
                              'zh-CN',
                            )}
                          </time>
                        </summary>
                        <div className="version-entry__content">
                          <h6>{version.title}</h6>
                          <p className="version-entry__meta">
                            {categories.find(
                              ([category]) => category === version.category,
                            )?.[1] ?? version.category}
                            {' · '}
                            {secrecyNames[version.secrecy]}
                          </p>
                          <pre className="action-original">
                            {version.originalText || '（此版本正文为空）'}
                          </pre>
                          {editable && version.version !== selected.version && (
                            <button
                              className="button"
                              type="button"
                              onClick={() => restoreVersion(version)}
                            >
                              载入版本 {versions.length - index} 继续编辑
                            </button>
                          )}
                          {version.version === selected.version && (
                            <span className="tag">当前版本</span>
                          )}
                        </div>
                      </details>
                    ))}
                    {versions.length === 0 && (
                      <p className="muted">尚未手动保存版本。</p>
                    )}
                  </div>
                </div>
                <div className="version-history__section">
                  <h5>状态历史</h5>
                  {selected.history.map((entry) => (
                    <p key={entry.createdAt}>
                      {statusNames[entry.toStatus]} ·{' '}
                      {entry.reason || '状态建立'}
                    </p>
                  ))}
                </div>
              </details>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
