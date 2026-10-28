import { useEffect, useRef, useState } from 'react';
import {
  nationalPolicyStatus,
  toGovernmentInput,
  isGameReadOnly,
} from '@srilanka/contracts';
import type {
  GameSummary,
  GovernmentData,
  GovernmentChange,
  NationalPolicy,
} from '@srilanka/contracts';
import { fetchGovernment, setupGovernment } from '../api.js';
import {
  GovernmentForm,
  GovernmentRecord,
  PolicyDetails,
  policyStatusNames,
} from '../government/GovernmentEditor.js';
import { quarterLabel } from '../diplomacy/DiplomacyEditor.js';
import { economicNames } from '../settlements/EconomicBillPanel.js';
import { signedAmount } from './resource-labels.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';

function selectCountry(
  data: GovernmentData,
  countryId: string,
): GovernmentData {
  return {
    ...data,
    countries: data.countries?.filter((c) => c.id === countryId),
    profiles: data.profiles.filter((p) => p.countryId === countryId),
    policies: data.policies.filter((p) => p.countryId === countryId),
  };
}
export function GovernmentPanel({
  game,
  active,
  countryId,
  onEditingChange,
  expanded = false,
}: {
  game: GameSummary;
  active: boolean;
  countryId: string;
  onEditingChange?: (editing: boolean) => void;
  expanded?: boolean;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<GovernmentData | null>(null),
    [loadedCountry, setLoadedCountry] = useState(''),
    [editing, setEditing] = useState(false),
    [changes, setChanges] = useState<GovernmentChange[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0),
    [message, setMessage] = useState('');
  const inFlight = useRef(false);
  const readOnly = isGameReadOnly(game.status);
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  const current =
    loadedCountry === countryId && data
      ? { ...data, canEdit: data.canEdit && !isGameReadOnly(game.status) }
      : null;
  useEffect(() => {
    onEditingChange?.(editing);
    return () => onEditingChange?.(false);
  }, [editing, onEditingChange]);
  useEffect(() => {
    if (!open || !active || editing) return;
    const controller = new AbortController();
    let reading = false;
    async function read() {
      if (reading) return;
      reading = true;
      try {
        const next = await fetchGovernment(
          game.id,
          countryId,
          controller.signal,
        );
        if (!controller.signal.aborted) {
          setData(selectCountry(next, countryId));
          setLoadedCountry(countryId);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '行政资料读取失败');
      } finally {
        reading = false;
      }
    }
    setError('');
    setMessage('');
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [open, active, editing, game.id, countryId, reload]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (editing) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [editing]);
  async function save() {
    if (inFlight.current || !changes.length) return;
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await setupGovernment(game.id, changes.map(toGovernmentInput));
      setChanges([]);
      setEditing(false);
      setMessage('行政设置已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '行政设置保存失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="government-panel"
      data-expanded={expanded || undefined}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>政府与长期政策</summary>
      {open && (
        <>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {!current && !error && <LoadingSkeleton label="正在读取行政资料…" />}
          {current &&
            (editing ? (
              <>
                <p>准备阶段设置立即生效；行动产生的改革请在回合结算中填写。</p>
                {changes.map((c) => (
                  <div key={c.id}>
                    <GovernmentRecord change={c} />
                    <button
                      disabled={busy}
                      onClick={() =>
                        setChanges(changes.filter((i) => i.id !== c.id))
                      }
                    >
                      移除行政设置：{c.summary}
                    </button>
                  </div>
                ))}
                <GovernmentForm
                  data={current}
                  initialCountryId={countryId}
                  operation="Setup"
                  actionId={null}
                  changes={changes}
                  busy={busy}
                  onChange={setChanges}
                />
                <div className="form-actions">
                  <button
                    disabled={busy || !changes.length}
                    onClick={() => void save()}
                  >
                    保存行政设置
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setEditing(false);
                      setChanges([]);
                      setError('');
                    }}
                  >
                    取消行政设置
                  </button>
                </div>
              </>
            ) : (
              <>
                {current.profiles.map((p) => (
                  <div key={p.countryId}>
                    <p>政体：{p.regime || '未填写'}</p>
                    <p>统治者或执政机构：{p.authority || '未填写'}</p>
                    {p.description && (
                      <p className="rules-text">{p.description}</p>
                    )}
                  </div>
                ))}
                {!current.policies.length && <p>尚无长期政策或改革。</p>}
                {current.policies.map((p) => (
                  <details key={p.id}>
                    <summary>
                      {p.title} ·{' '}
                      {
                        policyStatusNames[
                          nationalPolicyStatus(
                            p,
                            current.quarter.sequenceNumber,
                          )
                        ]
                      }
                    </summary>
                    <PolicyDetails policy={p} />
                  </details>
                ))}
                {current.lastBill && (
                  <details>
                    <summary>
                      最近一季政策与经济结果：
                      {quarterLabel(current.lastBill.quarter)}
                    </summary>
                    <p>
                      期初依据：
                      {new Date(current.lastBill.capturedAt).toLocaleString(
                        'zh-CN',
                      )}
                    </p>
                    <div className="country-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>项目</th>
                            <th>政策前</th>
                            <th>计算额</th>
                            <th>实际额</th>
                            <th>政策效果 / 修正原因</th>
                          </tr>
                        </thead>
                        <tbody>
                          {current.lastBill.lines.map((l) => (
                            <tr key={l.kind}>
                              <td>{economicNames[l.kind]}</td>
                              <td>{signedAmount(l.baseAmount)}</td>
                              <td>{signedAmount(l.calculatedAmount)}</td>
                              <td>{signedAmount(l.actualAmount)}</td>
                              <td>
                                {l.policyEffects
                                  .map(
                                    (p) =>
                                      `${p.title} ${p.percent > 0 ? '+' : ''}${p.percent}%`,
                                  )
                                  .join('；') || '—'}
                                {l.adjustmentReason && (
                                  <p className="rules-text">
                                    {l.adjustmentReason}
                                  </p>
                                )}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </details>
                )}
                {!!current.history?.length && (
                  <details>
                    <summary>行政记录</summary>
                    {current.history.map((h) => (
                      <details key={h.id}>
                        <summary>
                          {quarterLabel(h.quarter)} · {h.summary}
                        </summary>
                        <p className="rules-text">{h.reason}</p>
                        {'regime' in h.after ? (
                          <>
                            <p>政体：{h.after.regime || '未填写'}</p>
                            <p>
                              统治者或执政机构：{h.after.authority || '未填写'}
                            </p>
                            <p className="rules-text">{h.after.description}</p>
                          </>
                        ) : (
                          <PolicyDetails policy={h.after as NationalPolicy} />
                        )}
                      </details>
                    ))}
                  </details>
                )}
                <div className="form-actions">
                  <button onClick={() => setReload((v) => v + 1)}>
                    刷新行政资料
                  </button>
                  {current.canEdit &&
                    ['Host', 'Administrator'].includes(game.role) && (
                      <button
                        onClick={() => {
                          setEditing(true);
                          setChanges([]);
                          setMessage('');
                        }}
                      >
                        设置政府与开场政策
                      </button>
                    )}
                </div>
              </>
            ))}
        </>
      )}
    </details>
  );
}
