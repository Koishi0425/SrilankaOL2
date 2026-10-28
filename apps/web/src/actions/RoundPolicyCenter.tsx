import { isGameReadOnly } from '@srilanka/contracts';
import type {
  RoundPolicy,
  RoundPolicySectionInput,
  RoundPolicySummary,
  ReviewRoundPolicyInput,
} from '@srilanka/contracts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import type { ComponentProps } from 'react';
import {
  fetchMyRoundPolicy,
  fetchRoundPolicies,
  fetchRoundPolicy,
  fetchRoundPolicyForAction,
  saveRoundPolicy,
  reviewRoundPolicy,
  transitionQuarter,
} from '../api.js';
import {
  DraftRecovery,
  useDraftKey,
  useLocalDraft,
} from '../drafts/local-drafts.js';
import { ActionMapLinks } from '../map/ActionMapLinks.js';
import { mergeActionRefs, statusNames } from './ActionCenter.js';
import type { ActionCenter } from './ActionCenter.js';
import { categories, categoryName } from './action-labels.js';

type Props = ComponentProps<typeof ActionCenter>;
type LocalPolicy = {
  revision: string;
  countryId: string;
  sections: RoundPolicySectionInput[];
};
function isLocalPolicy(value: unknown): value is LocalPolicy {
  if (!value || typeof value !== 'object') return false;
  const v = value as LocalPolicy;
  return (
    typeof v.revision === 'string' &&
    typeof v.countryId === 'string' &&
    Array.isArray(v.sections) &&
    v.sections.every(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.title === 'string' &&
        typeof s.text === 'string' &&
        categories.some(([key]) => key === s.category) &&
        ['OwnerOnly', 'Participants', 'Public'].includes(s.secrecy) &&
        Array.isArray(s.refs) &&
        s.refs.every(
          (r) =>
            r &&
            typeof r.objectId === 'string' &&
            typeof r.label === 'string' &&
            ['Actor', 'Target', 'Context'].includes(r.refKind) &&
            [
              'Tile',
              'City',
              'Army',
              'Country',
              'Character',
              'Region',
              'Province',
            ].includes(r.objectType),
        ),
    )
  );
}
const policyKey = (p: RoundPolicySummary) =>
  `${p.quarterId}:${p.memberId}:${p.countryId}`;
const attention = (p: RoundPolicySummary) =>
  ['Submitted', 'HostReview', 'PendingHostApproval'].includes(p.status);
const statusName = (p: RoundPolicySummary) =>
  p.status === 'Mixed' ? '原有分项审核结果不同' : statusNames[p.status];
const newSection = (): RoundPolicySectionInput => ({
  id: crypto.randomUUID(),
  title: '',
  text: '',
  category: 'Custom',
  secrecy: 'OwnerOnly',
  refs: [],
});
const message = (error: unknown) =>
  error instanceof Error ? error.message : '操作失败，请重试。';

export function RoundPolicyCenter({
  game,
  rules,
  seed,
  focus,
  active = true,
  variant = 'standalone',
  onQuarterChange,
  onSeedConsumed,
  onLocateReference,
  onDiscussAction,
  onMapReveal,
  onOpenSettlement,
  onPrepareOpening,
}: Props) {
  const host = ['Host', 'Administrator'].includes(game.role);
  const readOnly = isGameReadOnly(game.status);
  const [items, setItems] = useState<RoundPolicySummary[]>([]);
  const [policy, setPolicy] = useState<RoundPolicy | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRequest = useRef<number | null>(null);
  const [sections, setSections] = useState<RoundPolicySectionInput[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [confirm, setConfirm] = useState(false);
  const [notes, setNotes] = useState<
    Record<string, { reason: string; interpretation: string }>
  >({});
  const generation = useRef(0);
  const pending = useRef(false);
  const reading = useRef(false);
  const writingReview = useRef(false);
  const live = useRef({ policy, sections, dirty, busy });
  live.current = { policy, sections, dirty, busy };
  const requestIds = useRef(new Map<string, string>());
  const handledFocus = useRef<number | undefined>(undefined);
  const handledSeed = useRef<number | undefined>(undefined);
  const cards = useRef(new Map<string, HTMLElement>());
  const local = useLocalDraft(
    useDraftKey(
      game.id,
      policy?.quarterId ?? game.currentQuarter.id,
      'round-policy',
      policy ? `${policy.memberId}:${policy.countryId}` : 'loading',
    ),
    isLocalPolicy,
  );
  const candidate = local.candidate;
  const canRestore =
    !!policy?.canEdit &&
    candidate?.value.revision === policy.revision &&
    candidate.value.countryId === policy.countryId;
  const editable = !!policy?.canEdit && !host && !readOnly && !candidate;
  const quarter = game.currentQuarter;
  const current = policy?.quarterId === quarter.id;
  const selectedKey = policy ? policyKey(policy) : '';
  const note = notes[selectedKey] ?? { reason: '', interpretation: '' };
  writingReview.current = !!(note.reason || note.interpretation);

  const accept = useCallback((next: RoundPolicy) => {
    setPolicy(next);
    setLoaded(true);
    setSections(next.draftSections ?? next.sections);
    setDirty(false);
    setConfirm(false);
  }, []);

  const refresh = useCallback(async () => {
    if (reading.current || openingRequest.current !== null) return;
    reading.current = true;
    const token = generation.current;
    try {
      const list = await fetchRoundPolicies(game.id, quarter.id);
      if (token !== generation.current) return;
      setItems(list);
      if (live.current.dirty || pending.current || writingReview.current)
        return;
      const chosen = live.current.policy;
      // A discussion may focus an older quarter. Keep it open until explicitly changed.
      const next = host
        ? chosen
          ? await fetchRoundPolicy(game.id, chosen)
          : list.length
            ? await fetchRoundPolicy(game.id, list.find(attention) ?? list[0]!)
            : null
        : chosen && chosen.quarterId !== quarter.id
          ? await fetchRoundPolicy(game.id, chosen)
          : await fetchMyRoundPolicy(game.id, quarter.id);
      if (
        token === generation.current &&
        !live.current.dirty &&
        !pending.current &&
        !writingReview.current
      ) {
        setError('');
        if (next) accept(next);
        else setPolicy(null);
      }
    } catch (cause) {
      if (token === generation.current) setError(message(cause));
    } finally {
      reading.current = false;
      if (token === generation.current) setLoaded(true);
    }
  }, [game.id, quarter.id, host, accept]);

  useEffect(() => {
    generation.current++;
    setPolicy(null);
    setLoaded(false);
    setOpening(false);
    openingRequest.current = null;
    setItems([]);
    setSections([]);
    setDirty(false);
    setError('');
    setNotice('');
    live.current = { policy: null, sections: [], dirty: false, busy: false };
    handledFocus.current = undefined;
    handledSeed.current = undefined;
    return () => {
      generation.current++;
    };
  }, [game.id, quarter.id, game.role, refresh]);
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => {
    if (
      !active ||
      !focus ||
      focus.key === handledFocus.current ||
      pending.current ||
      live.current.dirty
    )
      return;
    handledFocus.current = focus.key;
    const token = ++generation.current;
    openingRequest.current = token;
    setOpening(true);
    setError('');
    void fetchRoundPolicyForAction(game.id, focus.actionId)
      .then((next) => {
        if (token !== generation.current) return;
        accept(next);
        requestAnimationFrame(() =>
          cards.current
            .get(focus.actionId)
            ?.scrollIntoView?.({ block: 'center' }),
        );
      })
      .catch((cause) => {
        if (token === generation.current) {
          setError(message(cause));
          handledFocus.current = undefined;
        }
      })
      .finally(() => {
        if (openingRequest.current === token) {
          openingRequest.current = null;
          setOpening(false);
          setLoaded(true);
        }
      });
  }, [active, focus, game.id, accept, dirty]);

  function change(next: RoundPolicySectionInput[]) {
    if (!policy || !editable || pending.current) return;
    setSections(next);
    setDirty(true);
    setConfirm(false);
    setNotice('');
    live.current = { ...live.current, sections: next, dirty: true };
    local.write({
      revision: policy.revision,
      countryId: policy.countryId,
      sections: next,
    });
  }
  useEffect(() => {
    if (
      !active ||
      !seed ||
      !policy ||
      candidate ||
      seed.key === handledSeed.current ||
      pending.current
    )
      return;
    handledSeed.current = seed.key;
    if (!editable || !current)
      setError(
        '当前政策不能编辑。请在当前回合开放提交或要求补充时添加地图目标。',
      );
    else {
      const next = [...live.current.sections];
      const index = next.findIndex(
        (s) => s.category === (seed.category ?? 'Policy'),
      );
      if (index >= 0)
        next[index] = {
          ...next[index]!,
          refs: mergeActionRefs(next[index]!.refs, seed.ref),
        };
      else
        next.push({
          ...newSection(),
          title: seed.title,
          category: seed.category ?? 'Policy',
          refs: [seed.ref],
        });
      change(next);
    }
    onSeedConsumed?.(seed.key);
  });

  async function open(item: RoundPolicySummary) {
    if (pending.current) return;
    const token = ++generation.current;
    openingRequest.current = token;
    setOpening(true);
    setError('');
    setNotice('');
    try {
      const next = await fetchRoundPolicy(game.id, item);
      if (token === generation.current) accept(next);
    } catch (cause) {
      if (token === generation.current) setError(message(cause));
    } finally {
      if (openingRequest.current === token) {
        openingRequest.current = null;
        setOpening(false);
      }
    }
  }
  function requestId(signature: string) {
    const id = requestIds.current.get(signature) ?? crypto.randomUUID();
    requestIds.current.set(signature, id);
    return id;
  }
  async function save(submit: boolean) {
    if (!policy || !editable || pending.current) return;
    if (submit && (!sections.length || sections.some((s) => !s.text.trim()))) {
      setError('请填写各分项的具体政策，或移除空白分项后再整份提交。');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const token = ++generation.current;
    const payload = {
      expectedRevision: policy.revision,
      sections: sections.map((s, i) => ({
        ...s,
        title: s.title.trim() || `政策分项 ${i + 1}`,
      })),
      submit,
    };
    try {
      const next = await saveRoundPolicy(game.id, policy.quarterId, {
        ...payload,
        requestId: requestId(JSON.stringify(['save', selectedKey, payload])),
      });
      if (token === generation.current) {
        accept(next);
        local.clear();
        setNotice(
          submit
            ? '整份政策已正式提交。'
            : '整份草稿已保存；正式提交内容尚未改变。',
        );
      }
    } catch (cause) {
      if (token === generation.current) setError(message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function review(target: ReviewRoundPolicyInput['target']) {
    const reason = (
      target === 'Interpretation' ? note.interpretation : note.reason
    ).trim();
    if (!policy || pending.current) return;
    if (!reason) {
      setError(
        target === 'Interpretation'
          ? '请填写整份政策的解释。'
          : '请填写整份政策的审核意见。',
      );
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const token = ++generation.current;
    const payload = { expectedRevision: policy.revision, target, reason };
    try {
      const next = await reviewRoundPolicy(game.id, policy, {
        ...payload,
        requestId: requestId(JSON.stringify(['review', selectedKey, payload])),
      });
      if (token === generation.current) {
        accept(next);
        setItems((list) =>
          list.map((p) => (policyKey(p) === selectedKey ? next : p)),
        );
        setNotes((all) => ({
          ...all,
          [selectedKey]: {
            ...note,
            [target === 'Interpretation' ? 'interpretation' : 'reason']: '',
          },
        }));
        setNotice('整份政策已更新。');
      }
    } catch (cause) {
      if (token === generation.current) setError(message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  async function changeQuarter(
    state: 'ActionSubmission' | 'Locked' | 'HostReview',
  ) {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      const next = await transitionQuarter(game.id, state);
      onQuarterChange?.(next);
    } catch (cause) {
      setError(message(cause));
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  const shown =
    host || !policy?.draftSections ? (policy?.sections ?? []) : sections;
  const reviewOpen =
    host &&
    !readOnly &&
    current &&
    ['ActionSubmission', 'Locked', 'HostReview'].includes(quarter.state) &&
    !!policy?.sections.length;
  const canDecide =
    reviewOpen &&
    policy?.sections.every((s) =>
      [
        'Submitted',
        'HostReview',
        'PendingHostApproval',
        'Approved',
        'Rejected',
      ].includes(s.status),
    );
  const visible = items.filter(
    (p) =>
      `${p.countryName} ${p.playerName}`
        .toLocaleLowerCase()
        .includes(query.trim().toLocaleLowerCase()) &&
      (filter === 'all' ||
        (filter === 'attention' && attention(p)) ||
        (filter === 'input' && p.status === 'NeedPlayerInput') ||
        (filter === 'finished' &&
          ['Approved', 'Rejected', 'Completed', 'Mixed'].includes(p.status))),
  );
  return (
    <section
      className={`work-center action-center round-policy-center${variant === 'map' ? ' work-center--map' : ''}`}
    >
      <header className="center-heading">
        <h3>{host ? '主持人行动审核' : '本回合政策'}</h3>
      </header>
      {host && !readOnly && (
        <div className="quarter-actions">
          {['Preparing', 'EventResponse', 'Locked', 'HostReview'].includes(
            quarter.state,
          ) && (
            <button
              disabled={busy}
              onClick={() =>
                quarter.state === 'Preparing' &&
                quarter.sequenceNumber === 1 &&
                onPrepareOpening
                  ? onPrepareOpening()
                  : void changeQuarter('ActionSubmission')
              }
            >
              {['Locked', 'HostReview'].includes(quarter.state)
                ? '重新开放政策提交'
                : '开放政策提交'}
            </button>
          )}
          {quarter.state === 'ActionSubmission' && (
            <button
              disabled={busy}
              onClick={() => void changeQuarter('Locked')}
            >
              锁定行动提交
            </button>
          )}
          {quarter.state === 'Locked' && (
            <button
              disabled={busy}
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
      {rules?.quarterId === quarter.id && (
        <details className="round-guidance">
          <summary>本回合行动指引</summary>
          <p className="rules-text">{rules.quarter.briefing}</p>
          <p className="rules-text">{rules.quarter.actionGuidelines}</p>
        </details>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {error && (
        <button
          disabled={busy}
          onClick={() => {
            if (host && policy) void open(policy);
            else {
              if (dirty) local.hold();
              setDirty(false);
              live.current.dirty = false;
              void refresh();
            }
          }}
        >
          重新读取政策（保留本地文字）
        </button>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className={`center-layout${host ? '' : ' round-policy-player'}`}>
        {host && (
          <aside className="center-list" aria-label="玩家回合政策">
            <div className="queue-tools">
              <label>
                搜索玩家或国家
                <input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <label>
                审核状态
                <select
                  value={filter}
                  onChange={(e) => setFilter(e.target.value)}
                >
                  <option value="all">全部</option>
                  <option value="attention">待审核</option>
                  <option value="input">待玩家补充</option>
                  <option value="finished">已评阅</option>
                </select>
              </label>
            </div>
            <p>每位玩家每回合一份，全部分项一起评阅。</p>
            {!loaded && !error && (
              <LoadingSkeleton label="正在读取玩家政策列表…" layout="list" />
            )}
            {visible.map((p) => (
              <button
                key={policyKey(p)}
                className={
                  policy && policyKey(p) === selectedKey
                    ? 'center-list__active'
                    : ''
                }
                disabled={busy}
                onClick={() => void open(p)}
              >
                <strong>
                  {p.countryName} · {p.playerName}
                </strong>
                <span>
                  {statusName(p)} · {p.sectionCount} 项内容
                </span>
              </button>
            ))}
            {loaded && !error && !visible.length && (
              <p>暂无符合条件的正式提交。</p>
            )}
          </aside>
        )}
        <div className="center-detail">
          {(!loaded || opening) && !error ? (
            <LoadingSkeleton label="正在读取本回合政策…" />
          ) : !policy ? (
            !error && (
              <p>
                {host ? '选择玩家查看整份政策。' : '本回合暂无可读取的政策。'}
              </p>
            )
          ) : (
            <>
              <h4>
                {policy.countryName} · {policy.playerName} ·{' '}
                {policy.quarter.gameYear} 年第 {policy.quarter.sequenceNumber}{' '}
                回合
              </h4>
              <p>
                {statusName(policy)}
                {dirty ? ' · 有未保存修改' : ''}
              </p>
              {!host && (
                <p className="policy-guidance">
                  本回合只提交一份政策。请自行添加分项，在各项中填写具体政策，最后整份提交。分类只是写作提示，可以重复、组合或选择“自由行动”并自拟标题；每项可涉及多个领域，分类不限制政策内容或分项数量。政策结果向谁可见，由主持人在结算时根据内容决定。
                </p>
              )}
              {policy.pendingInputRequest && (
                <div className="draft-recovery">
                  <strong>请补充整份政策</strong>
                  <p className="rules-text">{policy.pendingInputRequest}</p>
                </div>
              )}
              {!host && candidate && (
                <DraftRecovery
                  label="整份政策草稿"
                  savedAt={candidate.savedAt}
                  canRestore={canRestore}
                  preview={candidate.value.sections
                    .map((s) => `${s.title}\n${s.text}`)
                    .join('\n\n')}
                  onRestore={() => {
                    if (!canRestore) return;
                    setSections(candidate.value.sections);
                    setDirty(true);
                    local.resume();
                    live.current = {
                      ...live.current,
                      sections: candidate.value.sections,
                      dirty: true,
                    };
                  }}
                  onDiscard={local.clear}
                />
              )}
              {!host && local.error && (
                <p role="alert" className="form-error">
                  {local.error}
                </p>
              )}
              {!host && editable && (
                <div className="quarter-actions">
                  <button
                    disabled={busy}
                    onClick={() => {
                      const added = newSection();
                      change([...sections, added]);
                      requestAnimationFrame(() =>
                        cards.current
                          .get(added.id)
                          ?.scrollIntoView?.({ block: 'start' }),
                      );
                    }}
                  >
                    添加政策分项
                  </button>
                  <button disabled={busy} onClick={() => void save(false)}>
                    保存整份草稿
                  </button>
                  <button
                    className="button"
                    disabled={busy || !policy.canSubmit}
                    onClick={() => {
                      setConfirm(true);
                      setError('');
                    }}
                  >
                    提交整份政策
                  </button>
                  <span>共 {sections.length} 个分项</span>
                </div>
              )}
              {!host && !editable && !candidate && (
                <p>
                  当前阶段不能编辑；主持人要求补充或重新开放提交后可继续修改。
                </p>
              )}
              {confirm && editable && (
                <div className="draft-recovery">
                  <p>
                    将一次提交全部 {sections.length}{' '}
                    个分项，替换这份政策上一次的正式内容。仅保存草稿不会交给主持人。
                  </p>
                  <button disabled={busy} onClick={() => void save(true)}>
                    确认整份提交
                  </button>
                  <button disabled={busy} onClick={() => setConfirm(false)}>
                    继续修改
                  </button>
                </div>
              )}
              {shown.map((section, index) => (
                <article
                  className="round-policy-section"
                  key={section.id}
                  ref={(el) => {
                    if (el) cards.current.set(section.id, el);
                    else cards.current.delete(section.id);
                  }}
                >
                  {editable ? (
                    <fieldset disabled={busy}>
                      <div className="round-policy-section-heading">
                        <strong>分项 {index + 1}</strong>
                        <button
                          type="button"
                          onClick={() =>
                            change(sections.filter((s) => s.id !== section.id))
                          }
                        >
                          移除此分项
                        </button>
                      </div>
                      <div className="round-policy-fields">
                        <label>
                          参考分类
                          <select
                            value={section.category}
                            onChange={(e) =>
                              change(
                                sections.map((s) =>
                                  s.id === section.id
                                    ? {
                                        ...s,
                                        category: e.target
                                          .value as RoundPolicySectionInput['category'],
                                      }
                                    : s,
                                ),
                              )
                            }
                          >
                            {categories.map(([value, label]) => (
                              <option value={value} key={value}>
                                {label}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label>
                          分项标题（可自拟）
                          <input
                            maxLength={160}
                            value={section.title}
                            placeholder="例如：研究与人才培养"
                            onChange={(e) =>
                              change(
                                sections.map((s) =>
                                  s.id === section.id
                                    ? { ...s, title: e.target.value }
                                    : s,
                                ),
                              )
                            }
                          />
                        </label>
                      </div>
                      <label>
                        具体政策
                        <textarea
                          rows={7}
                          maxLength={20000}
                          value={section.text}
                          onChange={(e) =>
                            change(
                              sections.map((s) =>
                                s.id === section.id
                                  ? { ...s, text: e.target.value }
                                  : s,
                              ),
                            )
                          }
                          placeholder="说明本项的目标、措施和投入，可同时涉及多个领域。"
                        />
                      </label>

                      {section.refs.map((ref, i) => (
                        <button
                          type="button"
                          key={`${ref.objectType}:${ref.objectId}:${i}`}
                          onClick={() =>
                            change(
                              sections.map((s) =>
                                s.id === section.id
                                  ? {
                                      ...s,
                                      refs: s.refs.filter((_, n) => n !== i),
                                    }
                                  : s,
                              ),
                            )
                          }
                        >
                          移除关联：{ref.label}
                        </button>
                      ))}
                    </fieldset>
                  ) : (
                    <>
                      <h5>
                        {section.title}{' '}
                        <small>{categoryName(section.category)}</small>
                      </h5>
                      <p className="rules-text">
                        {section.text || '此分项尚未填写。'}
                      </p>
                    </>
                  )}
                  <ActionMapLinks
                    refs={section.refs}
                    onLocate={onLocateReference}
                  />
                  {host &&
                    'status' in section &&
                    onOpenSettlement &&
                    ['Approved', 'Rejected'].includes(
                      String(section.status),
                    ) && (
                      <button onClick={() => onOpenSettlement(section.id)}>
                        处理此分项的结算
                      </button>
                    )}
                  {host &&
                    'status' in section &&
                    section.status === 'Approved' &&
                    section.category === 'Exploration' &&
                    onMapReveal &&
                    current &&
                    [
                      'ActionSubmission',
                      'Locked',
                      'HostReview',
                      'Resolving',
                    ].includes(quarter.state) && (
                      <button
                        onClick={() =>
                          onMapReveal({
                            actionId: section.id,
                            title: section.title,
                            countryId: policy.countryId,
                            tileIds: section.refs
                              .filter((r) => r.objectType === 'Tile')
                              .map((r) => r.objectId),
                          })
                        }
                      >
                        登记探索结果
                      </button>
                    )}
                </article>
              ))}
              {!shown.length && (
                <p>
                  {host
                    ? '本份政策中没有有效分项。'
                    : '从“添加政策分项”开始，写完后一次提交整份政策。'}
                </p>
              )}
              {policy.sections.length > 0 && onDiscussAction && (
                <button
                  disabled={busy || dirty}
                  onClick={() => {
                    void onDiscussAction(policy.sections[0]!.id).catch(
                      (cause) => setError(message(cause)),
                    );
                  }}
                >
                  讨论整份政策
                </button>
              )}
              {policy.interpretation && (
                <div>
                  <h5>主持人解释</h5>
                  <p className="rules-text">{policy.interpretation}</p>
                </div>
              )}
              {policy.sections.some((s) => s.reviewReason) && (
                <div>
                  <h5>已记录的审核意见</h5>
                  {[
                    ...new Set(
                      policy.sections
                        .map((s) => s.reviewReason)
                        .filter(Boolean),
                    ),
                  ].map((reason) => (
                    <p className="rules-text" key={reason}>
                      {reason}
                    </p>
                  ))}
                </div>
              )}
              {reviewOpen && (
                <div className="round-policy-review">
                  <h4>整份评阅</h4>
                  <label>
                    整份审核意见
                    <textarea
                      value={note.reason}
                      onChange={(e) =>
                        setNotes((all) => ({
                          ...all,
                          [selectedKey]: { ...note, reason: e.target.value },
                        }))
                      }
                      rows={3}
                    />
                  </label>
                  <div className="quarter-actions">
                    <button
                      disabled={busy || !canDecide}
                      onClick={() => void review('Approved')}
                    >
                      批准整份政策
                    </button>
                    <button
                      disabled={busy || !canDecide}
                      onClick={() => void review('Rejected')}
                    >
                      拒绝整份政策
                    </button>
                    <button
                      disabled={busy || !canDecide}
                      onClick={() => void review('NeedPlayerInput')}
                    >
                      要求整份补充
                    </button>
                  </div>
                  <label>
                    整份政策解释
                    <textarea
                      value={note.interpretation}
                      onChange={(e) =>
                        setNotes((all) => ({
                          ...all,
                          [selectedKey]: {
                            ...note,
                            interpretation: e.target.value,
                          },
                        }))
                      }
                      rows={3}
                    />
                  </label>
                  <button
                    disabled={busy}
                    onClick={() => void review('Interpretation')}
                  >
                    保存整份解释
                  </button>
                </div>
              )}
              {policy.history.length > 0 && (
                <details>
                  <summary>正式提交历史（{policy.history.length} 次）</summary>
                  {policy.history.map((h) => (
                    <details key={h.id}>
                      <summary>
                        {new Date(h.submittedAt).toLocaleString('zh-CN')} ·{' '}
                        {h.whole ? '整份正式提交' : '原有分项提交'}
                      </summary>
                      {h.sections.map((s) => (
                        <div key={s.id}>
                          <h5>{s.title}</h5>
                          <p className="rules-text">{s.text}</p>
                        </div>
                      ))}
                    </details>
                  ))}
                </details>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
