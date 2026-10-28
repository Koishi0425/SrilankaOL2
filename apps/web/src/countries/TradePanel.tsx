import { useEffect, useRef, useState } from 'react';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import { isGameReadOnly } from '@srilanka/contracts';
import type {
  GameSummary,
  TradeData,
  SetTradeZoneInput,
} from '@srilanka/contracts';
import { fetchTrade, setTradeZone } from '../api.js';
type Draft = {
  id: string;
  name: string;
  revision: number | null;
  mapRevision: number;
  provinceIds: string[];
  powers: Record<string, string>;
  reason: string;
  provinces: Array<{ id: string; name: string; otherZone?: string }>;
  countries: Array<{ id: string; name: string }>;
};
const seasons = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};
export function TradePanel({
  game,
  countryId,
  active,
  expanded = false,
}: {
  game: GameSummary;
  countryId: string;
  active: boolean;
  expanded?: boolean;
}) {
  const host = ['Host', 'Administrator'].includes(game.role);
  const readOnly = isGameReadOnly(game.status);
  const [open, setOpen] = useState(false),
    [response, setResponse] = useState<TradeData | null>(null),
    [loadedCountry, setLoadedCountry] = useState('');
  const [draft, setDraft] = useState<Draft | null>(null),
    [selected, setSelected] = useState<string | null>(null),
    [reload, setReload] = useState(0),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const inFlight = useRef(false),
    data =
      loadedCountry === countryId && response
        ? {
            ...response,
            canEdit: response.canEdit && !isGameReadOnly(game.status),
          }
        : null;
  const zone = data?.zones.find((z) => z.id === selected);
  useEffect(() => {
    if (readOnly) setDraft(null);
  }, [readOnly]);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  useEffect(() => {
    if (!open || !active || draft) return;
    const controller = new AbortController();
    async function read() {
      try {
        const next = await fetchTrade(game.id, countryId, controller.signal);
        if (!controller.signal.aborted) {
          setResponse(next);
          setLoadedCountry(countryId);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '贸易资料读取失败');
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    setLoading(true);
    void read();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void read();
    }, 5000);
    return () => {
      controller.abort();
      window.clearInterval(timer);
    };
  }, [open, active, game.id, countryId, draft, reload]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (draft) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  function edit(id?: string) {
    if (!data?.options || !data.canEdit) return;
    const z = data.zones.find((item) => item.id === id)?.setup;
    const provinces = data.options.provinces.map((p) => ({
      ...p,
      otherZone: data.zones.find(
        (other) =>
          other.id !== id && other.setup?.provinces.some((i) => i.id === p.id),
      )?.name,
    }));
    setDraft({
      id: id ?? crypto.randomUUID(),
      name: z?.name ?? '',
      revision: z?.revision ?? null,
      mapRevision: data.mapRevision,
      provinceIds: z?.provinces.map((p) => p.id) ?? [],
      powers: Object.fromEntries(
        data.options.countries.map((c) => [
          c.id,
          String(z?.influences.find((i) => i.countryId === c.id)?.power ?? 0),
        ]),
      ),
      reason: '',
      provinces,
      countries: data.options.countries,
    });
    setError('');
    setMessage('');
  }
  async function save() {
    if (!draft || inFlight.current) return;
    const influences = draft.countries.map((c) => ({
      countryId: c.id,
      power: Number(draft.powers[c.id]),
    }));
    if (
      !draft.name.trim() ||
      !draft.reason.trim() ||
      influences.some(
        (i) =>
          !draft.powers[i.countryId]?.trim() ||
          !Number.isFinite(i.power) ||
          i.power < 0 ||
          i.power > 1000000 ||
          Math.abs(i.power * 100 - Math.round(i.power * 100)) > 0.0001,
      )
    ) {
      setError('请填写贸易区名称、非负影响力和修改原因；影响力最多两位小数。');
      return;
    }
    const input: SetTradeZoneInput = {
      name: draft.name.trim(),
      expectedRevision: draft.revision,
      expectedMapRevision: draft.mapRevision,
      provinceIds: draft.provinceIds,
      influences,
      reason: draft.reason.trim(),
    };
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      await setTradeZone(game.id, draft.id, input);
      setDraft(null);
      setMessage('贸易区已保存');
      setSelected(draft.id);
      setReload((v) => v + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '贸易区保存失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <details
      className="trade-panel"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>贸易{host ? '（全部）' : ''}</summary>
      {open && (
        <>
          {error && (
            <p role="alert" className="form-error">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {loading && !data && !draft && !error && (
            <LoadingSkeleton label="正在读取贸易资料…" layout="table" />
          )}
          {data && !draft && (
            <>
              {host && (
                <p>
                  贸易系数：{data.coefficient}
                  {data.coefficient === 0 ? '，当前不产生自动贸易收入。' : ''}
                </p>
              )}
              {host && !data.economicEnabled && (
                <p>每季经济结算未启用，请在准备阶段到“剧本与规则”开启。</p>
              )}
              <div className="country-table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>贸易区</th>
                      {host && <th>贸易价值</th>}
                      <th>本国影响力</th>
                      {host && <th>资料</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {data.zones.map((z) => (
                      <tr key={z.id}>
                        <td>{z.name}</td>
                        {host && <td>{z.setup?.value}</td>}
                        <td>{z.ownInfluence}</td>
                        {host && (
                          <td>
                            <button
                              onClick={() => setSelected(z.id)}
                              aria-label={`查看贸易区：${z.name}`}
                            >
                              查看
                            </button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {!data.zones.length && (
                <p>{host ? '尚未设置贸易区。' : '本国目前没有贸易影响力。'}</p>
              )}
              {zone?.setup && (
                <div className="trade-zone-detail">
                  <h4>{zone.name}</h4>
                  <p>
                    包含省份：
                    {zone.setup.provinces.map((p) => p.name).join('、') || '无'}
                  </p>
                  <table>
                    <thead>
                      <tr>
                        <th>国家</th>
                        <th>影响力</th>
                        <th>按当前资料计算的收益</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.options?.countries.map((c) => (
                        <tr key={c.id}>
                          <td>{c.name}</td>
                          <td>
                            {zone.setup!.influences.find(
                              (i) => i.countryId === c.id,
                            )?.power ?? 0}
                          </td>
                          <td>
                            {zone.setup!.allocations.find(
                              (i) => i.countryId === c.id,
                            )?.amount ?? 0}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.canEdit && (
                    <button onClick={() => edit(zone.id)}>编辑贸易区</button>
                  )}
                  <button onClick={() => setSelected(null)}>收起资料</button>
                </div>
              )}
              <div className="form-actions">
                {data.canEdit && (
                  <button onClick={() => edit()}>新增贸易区</button>
                )}
                <button
                  onClick={() => {
                    setMessage('');
                    setReload((v) => v + 1);
                  }}
                >
                  刷新贸易
                </button>
              </div>
              {host && !data.canEdit && (
                <p>
                  {data.mapRevision === 0
                    ? '请先创建地图，再在准备阶段设置贸易区。'
                    : '准备阶段可修改贸易区；政策引起的影响力变化在回合结算中填写。'}
                </p>
              )}
              <h4>最近已发布贸易收入</h4>
              {data.lastIncome ? (
                <>
                  <p>
                    第 {data.lastIncome.gameYear} 年{' '}
                    {seasons[data.lastIncome.season]} · 实际收入{' '}
                    {data.lastIncome.actualIncome}
                  </p>
                  {data.lastIncome.adjustmentReason && (
                    <p>
                      计算额 {data.lastIncome.calculatedIncome}，修正原因：
                      {data.lastIncome.adjustmentReason}
                    </p>
                  )}
                  <table>
                    <thead>
                      <tr>
                        <th>计算来源</th>
                        <th>金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.lastIncome.sources.map((s, i) => (
                        <tr key={i}>
                          <td>{s.name}</td>
                          <td>{s.amount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              ) : (
                <p>尚无已发布贸易收入。</p>
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
              <label>
                贸易区名称
                <input
                  maxLength={120}
                  required
                  disabled={busy}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <fieldset className="trade-provinces">
                <legend>包含省份</legend>
                {draft.provinces.map((p) => (
                  <label key={p.id}>
                    <input
                      type="checkbox"
                      disabled={busy || !!p.otherZone}
                      checked={draft.provinceIds.includes(p.id)}
                      onChange={(e) =>
                        setDraft({
                          ...draft,
                          provinceIds: e.target.checked
                            ? [...draft.provinceIds, p.id]
                            : draft.provinceIds.filter((id) => id !== p.id),
                        })
                      }
                    />
                    {p.name}
                    {p.otherZone ? `（已属${p.otherZone}）` : ''}
                  </label>
                ))}
              </fieldset>
              <table className="province-change-table">
                <thead>
                  <tr>
                    <th>国家</th>
                    <th>贸易影响力</th>
                  </tr>
                </thead>
                <tbody>
                  {draft.countries.map((c) => (
                    <tr key={c.id}>
                      <td>{c.name}</td>
                      <td>
                        <input
                          aria-label={`${c.name}贸易影响力`}
                          type="number"
                          min="0"
                          max="1000000"
                          step="0.01"
                          required
                          disabled={busy}
                          value={draft.powers[c.id] ?? '0'}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              powers: {
                                ...draft.powers,
                                [c.id]: e.target.value,
                              },
                            })
                          }
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <label>
                贸易区修改原因
                <input
                  maxLength={2000}
                  required
                  disabled={busy}
                  value={draft.reason}
                  onChange={(e) =>
                    setDraft({ ...draft, reason: e.target.value })
                  }
                />
              </label>
              <p>
                省份生产基础之和乘贸易系数形成贸易价值，各国按影响力分配；本季使用开放提交时的资料。
              </p>
              <div className="form-actions">
                <button disabled={busy}>保存贸易区</button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setDraft(null);
                    setError('');
                    setReload((v) => v + 1);
                  }}
                >
                  取消贸易区编辑
                </button>
              </div>
            </form>
          )}
        </>
      )}
    </details>
  );
}
