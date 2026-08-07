import { type FormEvent, useCallback, useEffect, useState } from 'react';

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

export function ActionCenter({
  game,
  seed,
  onQuarterChange,
}: {
  game: GameSummary;
  seed?: ActionDraftSeed;
  onQuarterChange?: (quarter: QuarterSummary) => void;
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
  const [refs, setRefs] = useState<Array<Omit<ActionObjectRef, 'id'>>>([]);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState('');
  const [saving, setSaving] = useState(false);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [reviewText, setReviewText] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setItems(await fetchActions(game.id, host));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '行动列表加载失败');
    }
  }, [game.id, host]);

  useEffect(() => void load(), [load]);

  useEffect(() => {
    if (!seed || host) return;
    setSelected(null);
    setTitle(seed.title);
    setText('');
    setCategory('Custom');
    setSecrecy('OwnerOnly');
    setRefs([seed.ref]);
    setDirty(false);
    setSaving(false);
    setSaveState('来自地图的对象引用已添加，请创建草稿。');
  }, [host, seed]);

  function edit(details: ActionDetails) {
    setSelected(details);
    setTitle(details.title);
    setText(details.currentText);
    setCategory(details.category);
    setSecrecy(details.secrecy);
    setRefs(details.refs.map(({ id: _id, ...ref }) => ref));
    setDirty(false);
    setSaving(false);
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
      })
        .then((details) => {
          setSelected(details);
          setSaving(false);
          setSaveState(`已保存 · 版本 ${details.version}`);
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
  }, [category, dirty, game.id, host, load, secrecy, selected, text, title]);

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
      setSaveState('草稿已创建并保存。');
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
    <section className="work-center">
      <header className="center-heading">
        <div>
          <p className="eyebrow">ACTION CENTER</p>
          <h3>{host ? '主持人行动审核' : '行动中心'}</h3>
        </div>
        <span className="tag">季度状态：{quarter.state}</span>
      </header>
      {host && (
        <div className="quarter-actions">
          {['Preparing', 'EventResponse', 'Locked'].includes(quarter.state) && (
            <button
              className="button"
              onClick={() => void changeQuarter('ActionSubmission')}
            >
              开放行动提交
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
                setRefs([]);
              }}
            >
              新建行动
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
                <div className="reference-list">
                  {refs.map((ref) => (
                    <span
                      className="tag"
                      key={`${ref.refKind}-${ref.objectId}`}
                    >
                      {ref.objectType} · {ref.label || ref.objectId}
                    </span>
                  ))}
                </div>
              )}
              <label>
                原始行动内容
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
                <p className="muted">
                  {saveState || `当前版本 ${selected.version}`}
                </p>
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
              <details>
                <summary>版本与状态历史</summary>
                <p>草稿版本：{versions.length || selected.version}</p>
                {selected.history.map((entry) => (
                  <p key={entry.createdAt}>
                    {statusNames[entry.toStatus]} · {entry.reason || '状态建立'}
                  </p>
                ))}
              </details>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
