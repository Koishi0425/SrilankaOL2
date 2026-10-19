import { useEffect, useRef, useState } from 'react';
import type { EconomicRules, EconomicRulesData } from '@srilanka/contracts';
import { fetchEconomicRules, saveEconomicRules } from '../api.js';
const fields = [
  ['taxCoefficient', '税收系数'],
  ['productionCoefficient', '生产系数'],
  ['manpowerCoefficient', '人力系数'],
  ['armyMaintenancePer100', '每百人军队维护费'],
  ['administrationCost', '每国每季行政费'],
  ['tradeCoefficient', '贸易系数'],
] as const;
type Draft = {
  enabled: boolean;
  values: Record<(typeof fields)[number][0], string>;
  version: number;
  reason: string;
};
export function EconomicRulesPanel({
  gameId,
  active,
  canManage,
}: {
  gameId: string;
  active: boolean;
  canManage: boolean;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<EconomicRulesData | null>(null),
    [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false),
    [reload, setReload] = useState(0);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!canManage) setDraft(null);
  }, [canManage]);
  useEffect(() => {
    if (!active || !open || draft) return;
    const controller = new AbortController();
    void fetchEconomicRules(gameId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next);
          setError('');
        }
      })
      .catch((cause) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '经济规则读取失败');
      });
    return () => controller.abort();
  }, [active, open, gameId, draft, reload]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (draft) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  function edit() {
    if (!data) return;
    const values = {} as Draft['values'];
    for (const [key] of fields) values[key] = String(data.rules[key] ?? 0);
    setDraft({
      enabled: data.rules.enabled,
      values,
      version: data.version,
      reason: '',
    });
    setMessage('');
    setError('');
  }
  async function save() {
    if (!draft || inFlight.current) return;
    const rules: EconomicRules = {
      enabled: draft.enabled,
      taxCoefficient: 0,
      productionCoefficient: 0,
      manpowerCoefficient: 0,
      armyMaintenancePer100: 0,
      administrationCost: 0,
    };
    for (const [key] of fields) {
      const amount = Number(draft.values[key]);
      if (
        !draft.values[key].trim() ||
        !Number.isFinite(amount) ||
        amount < 0 ||
        amount > 1000000 ||
        Math.abs(amount * 100 - Math.round(amount * 100)) > 0.0001
      ) {
        setError('请填写非负系数，数值最多两位小数。');
        return;
      }
      rules[key] = amount;
    }
    if (!draft.reason.trim()) {
      setError('请填写经济规则的修改原因。');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setData(
        await saveEconomicRules(gameId, {
          rules,
          expectedVersion: draft.version,
          reason: draft.reason.trim(),
        }),
      );
      setDraft(null);
      setMessage('经济规则已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '经济规则保存失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="rules-panel economic-rules">
      <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary>经济规则</summary>
        {open && (
          <div className="center-detail">
            {error && (
              <p className="form-error" role="alert">
                {error}
              </p>
            )}
            {message && <p role="status">{message}</p>}
            {!data && !error && <p>加载中…</p>}
            {data && !draft && (
              <>
                <p>每季经济结算：{data.rules.enabled ? '已启用' : '未启用'}</p>
                <dl className="country-values">
                  {fields.map(([key, label]) => (
                    <div key={key}>
                      <dt>{label}</dt>
                      <dd>{data.rules[key] ?? 0}</dd>
                    </div>
                  ))}
                </dl>
                {canManage && data.canEdit && (
                  <button onClick={edit}>设置经济规则</button>
                )}
                {canManage && !data.canEdit && (
                  <p>下回合准备阶段可修改系数，本季使用开放提交时的规则。</p>
                )}
              </>
            )}
            {draft && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void save();
                }}
              >
                <label className="economy-enable">
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={draft.enabled}
                    onChange={(e) =>
                      setDraft({ ...draft, enabled: e.target.checked })
                    }
                  />
                  启用每季经济结算
                </label>
                <div className="resource-form">
                  {fields.map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        required
                        min="0"
                        max="1000000"
                        step="0.01"
                        disabled={busy}
                        value={draft.values[key]}
                        onChange={(e) =>
                          setDraft({
                            ...draft,
                            values: { ...draft.values, [key]: e.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
                </div>
                <p>
                  税收、生产和人力按自治折扣及仍受本国控制的法定领土比例计算。系数为零时不计该项。
                  贸易区价值为区内有地块省份的生产基础之和乘贸易系数。
                </p>
                <label>
                  修改原因
                  <input
                    required
                    maxLength={2000}
                    disabled={busy}
                    value={draft.reason}
                    onChange={(e) =>
                      setDraft({ ...draft, reason: e.target.value })
                    }
                  />
                </label>
                <div className="form-actions">
                  <button disabled={busy}>保存经济规则</button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setDraft(null);
                      setError('');
                    }}
                  >
                    取消
                  </button>
                </div>
              </form>
            )}
            {!draft && (
              <button
                disabled={busy}
                onClick={() => {
                  setMessage('');
                  setReload((v) => v + 1);
                }}
              >
                刷新经济规则
              </button>
            )}
          </div>
        )}
      </details>
    </section>
  );
}
