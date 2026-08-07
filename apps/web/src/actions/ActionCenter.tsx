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

export interface ActionDraftSeed {
  key: number;
  title: string;
  ref: Omit<ActionObjectRef, 'id'>;
}

type DraftRef = Omit<ActionObjectRef, 'id'>;

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
      current.category === 'Custom' ? ('Policy' as const) : current.category,
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

const statusNames: Record<ActionSummary['status'], string> = {
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

const categories: Array<[ActionCategory, string]> = [
  ['Policy', '政策'],
  ['Diplomacy', '外交'],
  ['Construction', '建设'],
  ['Research', '研究'],
  ['Recruitment', '征募'],
  ['Military', '军事'],
  ['Intelligence', '情报'],
  ['Reform', '改革'],
  ['EventResponse', '事件回应'],
  ['Custom', '自定义'],
];

const secrecyNames: Record<ActionSecrecy, string> = {
  OwnerOnly: '仅本国与主持人',
  Participants: '相关参与方',
  Public: '公开',
};

export function ActionCenter({
  game,
  seed,
  onQuarterChange,
  onSeedConsumed,
  variant = 'standalone',
}: {
  game: GameSummary;
  seed?: ActionDraftSeed;
  onQuarterChange?: (quarter: QuarterSummary) => void;
  onSeedConsumed?: (key: number) => void;
  variant?: 'standalone' | 'map';
}) {
  const host = game.role === 'Host' || game.role === 'Administrator';
  const [quarter, setQuarter] = useState<QuarterSummary>(game.currentQuarter);
  const [items, setItems] = useState<ActionSummary[]>([]);
  const [selected, setSelected] = useState<ActionDetails | null>(null);
  const [versions, setVersions] = useState<ActionVersion[]>([]);
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [category, setCategory] = useState<ActionCategory>('Custom');
  const [secrecy, setSecrecy] = useState<ActionSecrecy>('OwnerOnly');
  const [refs, setRefs] = useState<DraftRef[]>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [saving, setSaving] = useState(false);
  const [savingVersion, setSavingVersion] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [reviewText, setReviewText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const handledSeedKey = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setItems(await fetchActions(game.id, host));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '行动列表加载失败');
    }
  }, [game.id, host]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!seed || host || handledSeedKey.current === seed.key) return;
    handledSeedKey.current = seed.key;

    const canAppendToSelected =
      selected && ['Draft', 'NeedPlayerInput'].includes(selected.status);
    if (selected && !canAppendToSelected) {
      setSelected(null);
      setTitle(seed.title);
      setText('');
      setCategory('Policy');
      setSecrecy('OwnerOnly');
      setRefs([seed.ref]);
      setDirty(false);
      setSaving(false);
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

  function edit(details: ActionDetails) {
    setSelected(details);
    setTitle(details.title);
    setText(details.currentText);
    setCategory(details.category);
    setSecrecy(details.secrecy);
    setRefs(details.refs.map(({ id: _id, ...ref }) => ref));
    setDirty(false);
    setSaving(false);
    setSavingVersion(false);
    setSaveState('');
    setConfirmSubmit(false);
  }

  async function open(actionId: string) {
    try {
      const details = await fetchAction(game.id, actionId);
      edit(details);
      setVersions(await fetchActionVersions(game.id, actionId));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '行动读取失败');
    }
  }

  useEffect(() => {
    if (
      host ||
      !selected ||
      !dirty ||
      !['Draft', 'NeedPlayerInput'].includes(selected.status)
    )
      return;
    setSaveState('等待自动保存…');
    const timeout = window.setTimeout(() => {
      setSaveState('正在保存…');
      setSaving(true);
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
          setSelected(details);
          setSaving(false);
          setSaveState(`恢复草稿已自动保存 · 修订 ${details.version}`);
          void load();
        })
        .catch((cause: unknown) => {
          if (
            cause instanceof ApiRequestError &&
            cause.code === 'ACTION_VERSION_CONFLICT'
          ) {
            setSaveState('保存冲突：请重新打开草稿后再编辑。');
          } else {
            setSaveState(cause instanceof Error ? cause.message : '保存失败');
          }
          setSaving(false);
        });
    }, 800);
    return () => window.clearTimeout(timeout);
  }, [
    category,
    dirty,
    game.id,
    host,
    load,
    refs,
    secrecy,
    selected,
    text,
    title,
  ]);

  async function create(event: FormEvent) {
    event.preventDefault();
    try {
      const details = await createAction(game.id, {
        quarterId: quarter.id,
        title,
        originalText: text,
        category,
        secrecy,
        refs,
      });
      edit(details);
      setVersions(await fetchActionVersions(game.id, details.id));
      setSaveState('草稿已创建，并生成了初始手动版本。');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建草稿失败');
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
    if (!selected || dirty || saving) return;
    setSavingVersion(true);
    try {
      const savedVersions = await saveActionVersion(
        game.id,
        selected.id,
        selected.version,
      );
      setVersions(savedVersions);
      setSaveState(`已手动保存为版本 ${savedVersions.length}。`);
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
    setSaveState(`已载入版本 ${version.version}，等待保存为新版本…`);
  }

  async function changeQuarter(
    state: 'ActionSubmission' | 'Locked' | 'HostReview',
  ) {
    try {
      const updated = await transitionQuarter(game.id, state);
      setQuarter(updated);
      onQuarterChange?.(updated);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '季度状态修改失败');
    }
  }

  const editable =
    !host && selected && ['Draft', 'NeedPlayerInput'].includes(selected.status);

  return (
    <section
      className={`work-center${variant === 'map' ? ' work-center--map' : ''}`}
    >
      <header className="center-heading">
        <div>
          <p className="eyebrow">ACTION CENTER</p>
          <h3>{host ? '主持人行动审核' : '政策与行动'}</h3>
        </div>
        <span className="tag">季度状态：{quarter.state}</span>
      </header>
      {host && (
        <div className="quarter-actions">
          {['Preparing', 'EventResponse', 'Locked', 'HostReview'].includes(
            quarter.state,
          ) && (
            <button
              className="button"
              onClick={() => void changeQuarter('ActionSubmission')}
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
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="center-layout">
        <aside className="center-list">
          {!host && (
            <button
              className="button"
              type="button"
              onClick={() => {
                setSelected(null);
                setTitle('');
                setText('');
                setCategory('Policy');
                setSecrecy('OwnerOnly');
                setRefs([]);
                setDirty(false);
                setSaveState('选择地图地块可把它加入这份新草稿。');
                setConfirmSubmit(false);
              }}
            >
              新建政策 / 行动
            </button>
          )}
          {items.map((item) => (
            <button
              className={selected?.id === item.id ? 'center-list__active' : ''}
              key={item.id}
              onClick={() => void open(item.id)}
            >
              <strong>{item.title}</strong>
              <small>
                {item.countryName} · {statusNames[item.status]}
              </small>
            </button>
          ))}
          {items.length === 0 && <p className="muted">暂无行动。</p>}
        </aside>
        <div className="center-detail">
          {!host && (!selected || editable) && (
            <form
              className="action-editor"
              onSubmit={(event) => void create(event)}
            >
              <label>
                行动标题
                <input
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
                  保密等级
                  <select
                    value={secrecy}
                    onChange={(event) => {
                      setSecrecy(event.target.value as ActionSecrecy);
                      setDirty(true);
                    }}
                  >
                    <option value="OwnerOnly">仅本国与主持人</option>
                    <option value="Participants">相关参与方</option>
                    <option value="Public">公开</option>
                  </select>
                </label>
              </div>
              {refs.length > 0 && (
                <div className="reference-list" aria-label="行动关联目标">
                  {refs.map((ref) => (
                    <span
                      className="tag"
                      key={`${ref.refKind}-${ref.objectId}`}
                    >
                      {ref.objectType} · {ref.label || ref.objectId}
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
                  placeholder="说明目标、执行方式、投入、备用计划和保密要求……"
                />
              </label>
              {!selected && (
                <button className="button" type="submit">
                  创建草稿
                </button>
              )}
              {selected && (
                <div className="draft-save-status">
                  <div>
                    <p className="muted">
                      {saveState || `恢复草稿修订 ${selected.version}`}
                    </p>
                    <small>
                      自动保存仅用于恢复进度；需要回退或对比时，请手动保存版本。
                    </small>
                  </div>
                  <button
                    className="button"
                    type="button"
                    disabled={dirty || saving || savingVersion}
                    onClick={() => void confirmVersion()}
                  >
                    {savingVersion
                      ? '正在保存版本…'
                      : dirty || saving
                        ? '等待自动保存'
                        : '手动保存版本'}
                  </button>
                </div>
              )}
            </form>
          )}
          {selected && (
            <div className="action-status-panel">
              <h4>{selected.title}</h4>
              <p>
                <span className="tag">{statusNames[selected.status]}</span>
              </p>
              {selected.pendingInputRequest && (
                <p className="review-request">
                  主持人要求补充：{selected.pendingInputRequest}
                </p>
              )}
              {(host || !editable) && (
                <pre className="action-original">
                  {selected.submittedOriginalText ?? selected.currentText}
                </pre>
              )}
              {selected.latestInterpretation && (
                <div>
                  <h5>主持人整理稿</h5>
                  <p>{selected.latestInterpretation}</p>
                </div>
              )}
              {!host &&
                ['Draft', 'NeedPlayerInput'].includes(selected.status) && (
                  <div className="confirm-action">
                    {quarter.state !== 'ActionSubmission' ? (
                      <p className="muted">
                        等待主持人开放行动提交。草稿仍会自动保存。
                      </p>
                    ) : !confirmSubmit ? (
                      <button
                        className="button"
                        type="button"
                        disabled={dirty || saving}
                        onClick={() => setConfirmSubmit(true)}
                      >
                        {dirty || saving ? '请等待草稿保存完成' : '准备提交'}
                      </button>
                    ) : (
                      <div className="confirmation-box">
                        <strong>
                          请确认：提交表示行动正式交给主持人审核，但不代表行动成功。
                        </strong>
                        <button
                          className="button"
                          type="button"
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
              {host && selected.status !== 'Draft' && (
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
                    <button onClick={() => void decide('request-input')}>
                      要求补充
                    </button>
                    <button onClick={() => void decide('approve')}>批准</button>
                    <button onClick={() => void decide('reject')}>拒绝</button>
                  </div>
                </div>
              )}
              <details className="version-history">
                <summary>手动版本（{versions.length}）与状态历史</summary>
                <div className="version-history__section">
                  <h5>草稿版本</h5>
                  <p className="muted">
                    手动版本保存标题、正文、类别和保密级别；自动保存只维护恢复草稿，地图关联沿用当前设置。
                  </p>
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
