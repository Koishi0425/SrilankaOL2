import { useEffect, useRef, useState } from 'react';
import {
  isGameReadOnly,
  toDiplomacyInput,
  treatyKindLabel,
  treatyStatus,
} from '@srilanka/contracts';
import type {
  DiplomacyChange,
  DiplomacyData,
  GameSummary,
} from '@srilanka/contracts';
import { fetchDiplomacy, setupDiplomacy } from '../api.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import {
  DiplomacyForm,
  DiplomacyRecord,
  TreatyDetails,
  quarterLabel,
  treatyStatusNames,
} from '../diplomacy/DiplomacyEditor.js';
export function DiplomacyPanel({
  game,
  active,
  expanded = false,
}: {
  game: GameSummary;
  active: boolean;
  expanded?: boolean;
}) {
  const host = ['Host', 'Administrator'].includes(game.role);
  const readOnly = isGameReadOnly(game.status);
  useEffect(() => {
    if (readOnly) setEditing(false);
  }, [readOnly]);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<DiplomacyData | null>(null),
    [editing, setEditing] = useState(false),
    [changes, setChanges] = useState<DiplomacyChange[]>([]),
    [reload, setReload] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const inFlight = useRef(false);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  useEffect(() => {
    if (!open || !active || editing) return;
    const controller = new AbortController();
    async function read() {
      try {
        const next = await fetchDiplomacy(game.id, controller.signal);
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      } catch (e) {
        if (!controller.signal.aborted)
          setError(e instanceof Error ? e.message : '外交资料读取失败');
      }
    }
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [open, active, editing, game.id, reload]);
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
      setData(await setupDiplomacy(game.id, changes.map(toDiplomacyInput)));
      setChanges([]);
      setEditing(false);
      setMessage('外交设置已保存');
    } catch (e) {
      setError(e instanceof Error ? e.message : '外交设置保存失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="diplomacy-panel"
      data-expanded={expanded || undefined}
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>外交</summary>
      {open && (
        <>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {!data && !error && <LoadingSkeleton label="正在读取外交资料…" />}
          {data && (
            <>
              {editing ? (
                <>
                  <p>
                    准备阶段设置立即生效；政策引起的变化请在回合结算中填写。
                  </p>
                  {changes.map((c) => (
                    <div key={c.id}>
                      <DiplomacyRecord change={c} />
                      <button
                        disabled={busy}
                        onClick={() =>
                          setChanges(changes.filter((i) => i.id !== c.id))
                        }
                      >
                        移除外交设置：{c.summary}
                      </button>
                    </div>
                  ))}
                  <DiplomacyForm
                    data={data}
                    changes={changes}
                    actionId={null}
                    busy={busy}
                    onChange={setChanges}
                  />
                  <div className="settlement-controls">
                    <button
                      disabled={busy || !changes.length}
                      onClick={() => void save()}
                    >
                      保存外交设置
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setChanges([]);
                        setError('');
                        setReload((v) => v + 1);
                      }}
                    >
                      取消外交设置
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <h4>战争状态</h4>
                  {data.relations.length ? (
                    <div className="country-table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>国家</th>
                            <th>状态</th>
                            <th>生效回合</th>
                            <th>原因</th>
                          </tr>
                        </thead>
                        <tbody>
                          {data.relations.map((r) => (
                            <tr key={r.countryIds.join(':')}>
                              <td>{r.countryNames.join(' ↔ ')}</td>
                              <td>{r.state === 'War' ? '交战' : '和平'}</td>
                              <td>{quarterLabel(r.effectiveQuarter)}</td>
                              <td className="rules-text">{r.reason}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <p>尚无战争记录，各国默认为和平。</p>
                  )}
                  <h4>条约</h4>
                  {!data.treaties.length && <p>暂无可见条约。</p>}
                  {data.treaties.map((t) => (
                    <details className="diplomacy-record" key={t.id}>
                      <summary>
                        {t.title} · {treatyKindLabel(t.type)} ·{' '}
                        {
                          treatyStatusNames[
                            treatyStatus(t, data.quarter.sequenceNumber)
                          ]
                        }{' '}
                        · {t.visibility === 'Public' ? '公开' : '秘密'}
                      </summary>
                      <TreatyDetails treaty={t} />
                    </details>
                  ))}
                  <div className="settlement-controls">
                    {host && data.canEdit && !isGameReadOnly(game.status) && (
                      <button
                        onClick={() => {
                          setEditing(true);
                          setMessage('');
                          setError('');
                        }}
                      >
                        设置外交状态
                      </button>
                    )}
                    <button onClick={() => setReload((v) => v + 1)}>
                      刷新外交
                    </button>
                  </div>
                  {!!data.history?.length && (
                    <details className="diplomacy-history">
                      <summary>外交记录（最近 30 项）</summary>
                      {data.history.map((h) => (
                        <details className="diplomacy-record" key={h.id}>
                          <summary>
                            {quarterLabel(h.quarter)} · {h.summary}
                          </summary>
                          <p>
                            {h.operation === 'Setup'
                              ? '准备阶段设置'
                              : '回合结算'}{' '}
                            · {h.reason}
                          </p>
                          {'terms' in h.after && (
                            <TreatyDetails treaty={h.after} />
                          )}
                        </details>
                      ))}
                    </details>
                  )}
                </>
              )}
            </>
          )}
        </>
      )}
    </details>
  );
}
