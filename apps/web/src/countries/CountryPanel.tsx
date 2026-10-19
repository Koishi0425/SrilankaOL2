import { useCallback, useEffect, useRef, useState } from 'react';
import { isGameReadOnly } from '@srilanka/contracts';
import { DiplomacyPanel } from './DiplomacyPanel.js';
import type {
  CountryLedgerPage,
  GameSummary,
  NationalStatus,
} from '@srilanka/contracts';
import {
  fetchCountryLedger,
  fetchNationalStatus,
  setCountryBalances,
} from '../api.js';
import { resourceNames, signedAmount } from './resource-labels.js';
import { ProvincePanel } from './ProvincePanel.js';
import { TradePanel } from './TradePanel.js';
import { GovernmentPanel } from './GovernmentPanel.js';

const seasons = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};
export type CountrySection =
  'overview' | 'economy' | 'diplomacy' | 'military' | 'government';
export function CountryPanel({
  game,
  active,
  onLocate,
  section = 'overview',
  selectedCountryId,
  onCountryChange,
  onEditingChange,
  compact = false,
}: {
  game: GameSummary;
  active: boolean;
  onLocate?: (tile: { id: string; q: number; r: number }) => void;
  section?: CountrySection;
  selectedCountryId?: string;
  onCountryChange?: (id: string) => void;
  onEditingChange?: (editing: boolean) => void;
  compact?: boolean;
}) {
  const [data, setData] = useState<NationalStatus | null>(null);
  const readOnly = isGameReadOnly(game.status);
  const [countryId, setCountryId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [governmentEditing, setGovernmentEditing] = useState(false);
  useEffect(() => {
    if (readOnly) {
      setEditing(false);
      setGovernmentEditing(false);
    }
  }, [readOnly]);
  const [treasury, setTreasury] = useState('');
  const [manpower, setManpower] = useState('');
  const [reason, setReason] = useState('');
  const [setupRevision, setSetupRevision] = useState(0);
  const [ledgerOpen, setLedgerOpen] = useState(false);
  const [ledger, setLedger] = useState<CountryLedgerPage | null>(null);
  const [ledgerBusy, setLedgerBusy] = useState(false);
  const [ledgerError, setLedgerError] = useState('');
  const [ledgerReload, setLedgerReload] = useState(0);
  const inFlight = useRef(false);
  const ledgerGeneration = useRef(0);
  const country = data?.countries.find((c) => c.id === countryId);
  const economicSection = section === 'overview' || section === 'economy';
  useEffect(() => {
    if (
      selectedCountryId &&
      data?.countries.some((c) => c.id === selectedCountryId) &&
      !editing &&
      !governmentEditing
    )
      setCountryId(selectedCountryId);
  }, [selectedCountryId, data, editing, governmentEditing]);
  useEffect(() => {
    onEditingChange?.(editing || governmentEditing);
    return () => onEditingChange?.(false);
  }, [editing, governmentEditing, onEditingChange]);
  const read = useCallback(
    async (signal?: AbortSignal) => {
      if (game.role === 'Observer') {
        setData({ countries: [], canSetBalances: false });
        setCountryId('');
        setError('');
        return;
      }
      const next = await fetchNationalStatus(game.id, signal);
      if (signal?.aborted) return;
      setData(next);
      setError('');
      setCountryId((current) =>
        next.countries.some((c) => c.id === current)
          ? current
          : (next.countries[0]?.id ?? ''),
      );
    },
    [game.id, game.role],
  );
  useEffect(() => {
    if (!active || editing || busy || governmentEditing) return;
    const controller = new AbortController();
    let reading = false;
    const refresh = async () => {
      if (document.hidden || reading) return;
      reading = true;
      try {
        await read(controller.signal);
      } catch (cause) {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '国家信息读取失败');
      } finally {
        reading = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, editing, busy, governmentEditing, read]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (editing) event.preventDefault();
    };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [editing]);
  const revision = country?.resourceRevision;
  useEffect(() => {
    const generation = ++ledgerGeneration.current;
    setLedger(null);
    setLedgerError('');
    if (!ledgerOpen || !active || !countryId || !economicSection) return;
    const controller = new AbortController();
    setLedgerBusy(true);
    void fetchCountryLedger(game.id, countryId, undefined, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) setLedger(next);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setLedgerError(
            cause instanceof Error ? cause.message : '账目读取失败',
          );
      })
      .finally(() => {
        if (generation === ledgerGeneration.current) setLedgerBusy(false);
      });
    return () => controller.abort();
  }, [
    game.id,
    countryId,
    ledgerOpen,
    active,
    revision,
    ledgerReload,
    economicSection,
  ]);
  async function more() {
    if (!ledger?.nextCursor || ledgerBusy) return;
    const generation = ledgerGeneration.current;
    setLedgerBusy(true);
    setLedgerError('');
    try {
      const next = await fetchCountryLedger(
        game.id,
        countryId,
        ledger.nextCursor,
      );
      if (generation === ledgerGeneration.current)
        setLedger({
          entries: [...ledger.entries, ...next.entries],
          nextCursor: next.nextCursor,
        });
    } catch (cause) {
      if (generation === ledgerGeneration.current)
        setLedgerError(cause instanceof Error ? cause.message : '账目读取失败');
    } finally {
      if (generation === ledgerGeneration.current) setLedgerBusy(false);
    }
  }
  async function save() {
    if (!country || inFlight.current) return;
    const values = [treasury, manpower].map(Number);
    if (
      !treasury.trim() ||
      !manpower.trim() ||
      !values.every(Number.isFinite) ||
      !Number.isInteger(values[1]) ||
      values[1]! < 0 ||
      !reason.trim()
    ) {
      setError('请填写有效余额和设置原因，人力为非负整数。');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      setData(
        await setCountryBalances(game.id, country.id, {
          expectedRevision: setupRevision,
          treasury: values[0]!,
          manpower: values[1]!,
          reason: reason.trim(),
        }),
      );
      setEditing(false);
      setReason('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '余额设置失败');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="work-center country-panel">
      <header className="center-heading">
        <h3>{compact ? (country?.name ?? '国家') : '国家'}</h3>
        <div className="settlement-controls">
          {!compact && (data?.countries.length ?? 0) > 1 && (
            <select
              aria-label="查看国家"
              disabled={editing || busy || governmentEditing}
              value={countryId}
              onChange={(event) => {
                setCountryId(event.target.value);
                onCountryChange?.(event.target.value);
              }}
            >
              {data?.countries.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          )}
          <button
            disabled={busy || editing || governmentEditing}
            onClick={() =>
              void read().catch((cause: unknown) =>
                setError(cause instanceof Error ? cause.message : '读取失败'),
              )
            }
          >
            刷新
          </button>
        </div>
      </header>
      <div className="center-detail">
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {!data && <p>加载中…</p>}
        {data && !country && game.role !== 'Observer' && <p>尚未分配国家。</p>}
        {country && (
          <>
            {!compact && <h4>{country.name}</h4>}
            <dl
              className="country-values"
              hidden={compact && section !== 'overview'}
            >
              <div>
                <dt>国库</dt>
                <dd>
                  {country.treasury.toLocaleString('zh-CN', {
                    maximumFractionDigits: 2,
                  })}
                </dd>
              </div>
              <div>
                <dt>人力</dt>
                <dd>{country.manpower.toLocaleString()}</dd>
              </div>
              <div>
                <dt>控制地块</dt>
                <dd>{country.controlledTileCount}</dd>
              </div>
              <div>
                <dt>法定领土</dt>
                <dd>{country.legalTileCount} 个地块</dd>
              </div>
            </dl>
            <div hidden={compact && !economicSection}>
              {data?.canSetBalances && !editing && !readOnly && (
                <button
                  onClick={() => {
                    setTreasury(String(country.treasury));
                    setManpower(String(country.manpower));
                    setSetupRevision(country.resourceRevision);
                    setReason('');
                    setEditing(true);
                  }}
                >
                  设置余额
                </button>
              )}
              {editing && !readOnly && (
                <div className="country-setup">
                  <div className="resource-form">
                    <label>
                      国库余额
                      <input
                        type="number"
                        step="0.01"
                        disabled={busy}
                        value={treasury}
                        onChange={(event) => setTreasury(event.target.value)}
                      />
                    </label>
                    <label>
                      人力余额
                      <input
                        type="number"
                        step="1"
                        min="0"
                        disabled={busy}
                        value={manpower}
                        onChange={(event) => setManpower(event.target.value)}
                      />
                    </label>
                    <label>
                      设置原因
                      <input
                        maxLength={2000}
                        disabled={busy}
                        value={reason}
                        onChange={(event) => setReason(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="form-actions">
                    <button disabled={busy} onClick={() => void save()}>
                      保存余额
                    </button>
                    <button
                      disabled={busy}
                      onClick={() => {
                        setEditing(false);
                        setError('');
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              )}
            </div>
            <div hidden={!economicSection}>
              <ProvincePanel
                game={game}
                active={active && economicSection}
                expanded={section === 'economy'}
                onLocate={onLocate}
              />
              <TradePanel
                game={game}
                active={active && economicSection}
                expanded={section === 'economy'}
                countryId={country.id}
              />
            </div>
            <div hidden={section !== 'overview' && section !== 'government'}>
              <GovernmentPanel
                game={game}
                active={
                  active && (section === 'overview' || section === 'government')
                }
                expanded={section === 'government'}
                countryId={country.id}
                onEditingChange={setGovernmentEditing}
              />
            </div>
            <div hidden={section !== 'overview' && section !== 'military'}>
              <h4>军队</h4>
              {country.armies.length ? (
                <div className="country-table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>名称</th>
                        <th>兵力</th>
                        <th>位置（列，行）</th>
                      </tr>
                    </thead>
                    <tbody>
                      {country.armies.map((army) => (
                        <tr key={army.id}>
                          <td>{army.name}</td>
                          <td>{army.strength.toLocaleString()}</td>
                          <td>
                            {army.q}，{army.r}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p>暂无军队。</p>
              )}
              <h4>控制城市</h4>
              {country.cities.length ? (
                <ul>
                  {country.cities.map((city) => (
                    <li key={city.id}>
                      {city.name}（{city.q}，{city.r}）
                    </li>
                  ))}
                </ul>
              ) : (
                <p>暂无城市。</p>
              )}
            </div>
            <div hidden={!economicSection}>
              <details
                className="country-ledger"
                open={ledgerOpen}
                onToggle={(event) => setLedgerOpen(event.currentTarget.open)}
              >
                <summary>资源账目</summary>
                {ledgerOpen && (
                  <>
                    {ledgerError && (
                      <p className="form-error" role="alert">
                        {ledgerError}
                      </p>
                    )}
                    {ledger?.entries.length === 0 && <p>暂无账目。</p>}
                    {!!ledger?.entries.length && (
                      <div className="country-table-wrap">
                        <table>
                          <thead>
                            <tr>
                              <th>回合</th>
                              <th>资源变化</th>
                              <th>余额</th>
                              <th>原因</th>
                            </tr>
                          </thead>
                          <tbody>
                            {ledger.entries.map((entry) => (
                              <tr key={entry.id}>
                                <td>
                                  {entry.gameYear} 年 {seasons[entry.season]}
                                  {entry.kind === 'Setup' ? '（设置）' : ''}
                                  {entry.kind === 'Correction'
                                    ? '（补正）'
                                    : ''}
                                </td>
                                <td>
                                  {resourceNames[entry.resource]}{' '}
                                  {signedAmount(entry.amount)}
                                </td>
                                <td>
                                  {entry.before.toLocaleString()} →{' '}
                                  {entry.after.toLocaleString()}
                                </td>
                                <td className="rules-text">{entry.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                    {ledgerBusy && <p>加载中…</p>}
                    {ledger?.nextCursor && (
                      <button disabled={ledgerBusy} onClick={() => void more()}>
                        更早账目
                      </button>
                    )}
                    {ledgerError && (
                      <button
                        disabled={ledgerBusy}
                        onClick={() => setLedgerReload((v) => v + 1)}
                      >
                        重试读取账目
                      </button>
                    )}
                  </>
                )}
              </details>
            </div>
          </>
        )}
        <div hidden={section !== 'overview' && section !== 'diplomacy'}>
          <DiplomacyPanel
            game={game}
            active={
              active && (section === 'overview' || section === 'diplomacy')
            }
            expanded={section === 'diplomacy'}
          />
        </div>
      </div>
    </section>
  );
}
