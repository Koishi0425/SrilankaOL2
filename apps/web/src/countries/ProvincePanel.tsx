import { useCallback, useEffect, useRef, useState } from 'react';
import { isGameReadOnly } from '@srilanka/contracts';
import type {
  GameSummary,
  ProvinceData,
  ProvinceSummary,
  ProvinceValues,
} from '@srilanka/contracts';
import { fetchProvinces, setProvince } from '../api.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
type Draft = {
  id: string;
  name: string;
  description: string;
  taxBase: string;
  productionBase: string;
  manpowerBase: string;
  autonomy: string;
  unrest: string;
  reason: string;
  revision: number;
  mapRevision: number;
};
const fields = [
  { key: 'taxBase', label: '税收基础', min: 0, max: 1000000, step: 1 },
  { key: 'productionBase', label: '生产基础', min: 0, max: 1000000, step: 1 },
  { key: 'manpowerBase', label: '人力基础', min: 0, max: 1000000, step: 1 },
  { key: 'autonomy', label: '自治（%）', min: 0, max: 100, step: 0.01 },
  { key: 'unrest', label: '不满', min: -100, max: 100, step: 0.01 },
] as const;
const owners = (groups: ProvinceSummary['legalOwners']) =>
  groups.length
    ? groups
        .map((g) => `${g.countryName ?? '无国家'} ${g.tileCount}`)
        .join(' · ')
    : '—';
export function ProvincePanel({
  game,
  active,
  onLocate,
  expanded = false,
}: {
  game: GameSummary;
  active: boolean;
  onLocate?: (tile: { id: string; q: number; r: number }) => void;
  expanded?: boolean;
}) {
  const host = ['Host', 'Administrator'].includes(game.role);
  const readOnly = isGameReadOnly(game.status);
  useEffect(() => {
    if (readOnly) setDraft(null);
  }, [readOnly]);
  const [open, setOpen] = useState(false),
    [data, setData] = useState<ProvinceData | null>(null);
  const [error, setError] = useState(''),
    [message, setMessage] = useState(''),
    [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState(''),
    [draft, setDraft] = useState<Draft | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (expanded) setOpen(true);
  }, [expanded]);
  const selected = data?.provinces.find((p) => p.id === selectedId);
  const read = useCallback(
    async (signal?: AbortSignal) => {
      const next = await fetchProvinces(game.id, signal);
      if (signal?.aborted) return;
      setData(next);
      setError('');
      setSelectedId((current) =>
        next.provinces.some((p) => p.id === current) ? current : '',
      );
    },
    [game.id],
  );
  useEffect(() => {
    if (!open || !active || draft || busy) return;
    const controller = new AbortController();
    let reading = false;
    async function refresh() {
      if (document.hidden || reading) return;
      reading = true;
      try {
        await read(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '省份读取失败');
      } finally {
        reading = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [open, active, draft, busy, read]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (draft) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [draft]);
  function edit() {
    if (!selected?.values || selected.revision === undefined || !data) return;
    const v = selected.values;
    setDraft({
      id: selected.id,
      name: selected.name,
      description: v.description,
      taxBase: String(v.taxBase),
      productionBase: String(v.productionBase),
      manpowerBase: String(v.manpowerBase),
      autonomy: String(v.autonomy),
      unrest: String(v.unrest),
      reason: '',
      revision: selected.revision,
      mapRevision: data.mapRevision,
    });
    setError('');
    setMessage('');
  }
  async function save() {
    if (!draft || inFlight.current) return;
    const numeric = {} as Omit<ProvinceValues, 'description'>;
    for (const field of fields) {
      const value = Number(draft[field.key]);
      if (
        !draft[field.key].trim() ||
        !Number.isFinite(value) ||
        value < field.min ||
        value > field.max ||
        (field.step === 1
          ? !Number.isInteger(value)
          : Math.abs(value * 100 - Math.round(value * 100)) > 0.0001)
      ) {
        setError(
          `请填写有效的${field.label}${field.step === 1 ? '，基础值为非负整数' : '，最多两位小数'}。`,
        );
        return;
      }
      numeric[field.key] = value;
    }
    if (!draft.name.trim() || !draft.reason.trim()) {
      setError('请填写省份名称与修改原因。');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      setData(
        await setProvince(game.id, draft.id, {
          name: draft.name.trim(),
          description: draft.description.trim(),
          ...numeric,
          expectedRevision: draft.revision,
          expectedMapRevision: draft.mapRevision,
          reason: draft.reason.trim(),
        }),
      );
      setDraft(null);
      setMessage('省份资料已保存');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '省份保存失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  const canEdit =
    data?.canEdit &&
    !isGameReadOnly(game.status) &&
    game.currentQuarter.state === 'Preparing';
  const regionGroups = new Map<string, ProvinceSummary['tiles']>();
  for (const tile of selected?.tiles ?? []) {
    const tiles = regionGroups.get(tile.regionName) ?? [];
    tiles.push(tile);
    regionGroups.set(tile.regionName, tiles);
  }
  return (
    <details
      className="province-panel"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>{host ? '省份（全部）' : '省份'}</summary>
      {open && (
        <>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {message && <p role="status">{message}</p>}
          {!data && !error && (
            <LoadingSkeleton label="正在读取省份资料…" layout="table" />
          )}
          {data && !data.provinces.length && (
            <p>
              {host
                ? '尚未划分省份。请在地图布置中为地块填写地区和省份名称。'
                : '暂无本国省份。'}
            </p>
          )}
          {!!data?.provinces.length && (
            <div className="country-table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>省份</th>
                    <th>法定归属</th>
                    <th>控制</th>
                    <th>地块</th>
                    <th>基础值（税收 / 生产 / 人力）</th>
                    <th>自治</th>
                    <th>不满</th>
                  </tr>
                </thead>
                <tbody>
                  {data.provinces.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <button
                          disabled={!!draft || busy}
                          onClick={() => {
                            setSelectedId(p.id);
                            setError('');
                            setMessage('');
                          }}
                          aria-label={`查看省份：${p.name}`}
                        >
                          {p.name}
                          {p.partial ? '（本国部分）' : ''}
                        </button>
                      </td>
                      <td>{owners(p.legalOwners)}</td>
                      <td>{owners(p.controllers)}</td>
                      <td>{p.tileCount}</td>
                      <td>
                        {p.values
                          ? `${p.values.taxBase} / ${p.values.productionBase} / ${p.values.manpowerBase}`
                          : '—'}
                      </td>
                      <td>{p.values ? `${p.values.autonomy}%` : '—'}</td>
                      <td>{p.values?.unrest ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {selected && (
            <div className="province-detail">
              <div className="form-actions">
                <strong>{selected.name}</strong>
                {!draft && canEdit && (
                  <button onClick={edit}>设置省份资料</button>
                )}
                {!draft && (
                  <button onClick={() => setSelectedId('')}>收起资料</button>
                )}
              </div>
              {!draft && selected.values?.description && (
                <p className="rules-text">{selected.values.description}</p>
              )}
              {!!regionGroups.size && (
                <div className="province-regions">
                  {[...regionGroups].map(([name, tiles]) =>
                    onLocate ? (
                      <button
                        key={name}
                        disabled={!!draft || busy}
                        aria-label={`在地图查看地区：${name}`}
                        onClick={() => onLocate(tiles[0]!)}
                      >
                        {name}（{tiles.length} 地块）
                      </button>
                    ) : (
                      <span key={name}>
                        {name}（{tiles.length} 地块）
                      </span>
                    ),
                  )}
                </div>
              )}
              {selected.partial && (
                <p>
                  该省跨越多个国家，此处仅列出本国法定领土，不显示整省经营资料。
                </p>
              )}
              {draft && (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                  }}
                >
                  <p>基础值用于剧本规则，目前不会自动产生收入或人力。</p>
                  <div className="resource-form">
                    <label>
                      省份名称
                      <input
                        required
                        maxLength={120}
                        disabled={busy}
                        value={draft.name}
                        onChange={(e) =>
                          setDraft({ ...draft, name: e.target.value })
                        }
                      />
                    </label>
                    {fields.map((f) => (
                      <label key={f.key}>
                        {f.label}
                        <input
                          required
                          type="number"
                          min={f.min}
                          max={f.max}
                          step={f.step}
                          disabled={busy}
                          value={draft[f.key]}
                          onChange={(e) =>
                            setDraft({ ...draft, [f.key]: e.target.value })
                          }
                        />
                      </label>
                    ))}
                  </div>
                  <label>
                    省份说明（本国可见）
                    <textarea
                      rows={3}
                      maxLength={2000}
                      disabled={busy}
                      value={draft.description}
                      onChange={(e) =>
                        setDraft({ ...draft, description: e.target.value })
                      }
                    />
                  </label>
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
                    <button disabled={busy || !canEdit}>保存省份资料</button>
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
            </div>
          )}
          {!draft && (
            <button
              disabled={busy}
              onClick={() => {
                setMessage('');
                void read().catch((cause) =>
                  setError(
                    cause instanceof Error ? cause.message : '省份读取失败',
                  ),
                );
              }}
            >
              刷新省份
            </button>
          )}
        </>
      )}
    </details>
  );
}
