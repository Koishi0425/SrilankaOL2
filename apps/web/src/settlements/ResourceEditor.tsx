import { useEffect, useState } from 'react';
import type {
  CountryResource,
  NationalStatus,
  ResourceChange,
} from '@srilanka/contracts';
import { fetchNationalStatus } from '../api.js';
import { resourceNames, signedAmount } from '../countries/resource-labels.js';

export function ResourceEditor({
  gameId,
  actionId,
  initialCountryId,
  changes,
  busy,
  active,
  onChange,
  automaticResources = [],
}: {
  gameId: string;
  actionId: string | null;
  initialCountryId?: string;
  changes: ResourceChange[];
  busy: boolean;
  active: boolean;
  onChange: (changes: ResourceChange[]) => void;
  automaticResources?: Array<
    Pick<
      ResourceChange,
      'countryId' | 'resource' | 'amount' | 'expectedResourceRevision'
    >
  >;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<NationalStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [countryId, setCountryId] = useState(initialCountryId ?? '');
  const [resource, setResource] = useState<CountryResource>('Treasury');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const scoped = recalculate(changes).filter(
    (item) => item.actionId === actionId,
  );
  useEffect(() => {
    if (!open || !active) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    void fetchNationalStatus(gameId, controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        setOptions(data);
        setCountryId((current) =>
          data.countries.some((c) => c.id === current)
            ? current
            : (data.countries[0]?.id ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setOptions(null);
          setError(cause instanceof Error ? cause.message : '余额读取失败');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [open, active, gameId, reload]);

  function recalculate(next: ResourceChange[]) {
    const running = new Map<string, number>();
    // Preserve the original baseline when deleting an earlier entry.
    for (const item of changes) {
      const key = `${item.countryId}:${item.resource}`;
      if (!running.has(key)) running.set(key, item.before);
    }
    for (const country of options?.countries ?? [])
      for (const resource of ['Treasury', 'Manpower'] as const) {
        if (
          changes.some(
            (c) =>
              c.countryId === country.id &&
              c.expectedResourceRevision !== country.resourceRevision,
          ) ||
          automaticResources.some(
            (c) =>
              c.countryId === country.id &&
              c.expectedResourceRevision !== country.resourceRevision,
          )
        )
          continue;
        const automatic = automaticResources
          .filter((c) => c.countryId === country.id && c.resource === resource)
          .reduce((sum, c) => sum + c.amount, 0);
        running.set(
          `${country.id}:${resource}`,
          Math.round(
            ((resource === 'Treasury' ? country.treasury : country.manpower) +
              automatic) *
              100,
          ) / 100,
        );
      }
    return next.map((item) => {
      const key = `${item.countryId}:${item.resource}`;
      const before = running.get(key) ?? item.before;
      const after = Math.round((before + item.amount) * 100) / 100;
      running.set(key, after);
      return { ...item, before, after };
    });
  }
  function add() {
    const country = options?.countries.find((c) => c.id === countryId);
    if (!country || busy || loading) return;
    setError('');
    if (
      [...changes, ...automaticResources].some(
        (item) =>
          item.countryId === country.id &&
          item.expectedResourceRevision !== country.resourceRevision,
      )
    ) {
      setError('该国余额已变化，请移除该国原收支后重新添加。');
      return;
    }
    const value = Number(amount);
    if (
      !amount.trim() ||
      !Number.isFinite(value) ||
      value === 0 ||
      !reason.trim() ||
      (resource === 'Treasury'
        ? Math.abs(value) > 1_000_000_000 ||
          Math.abs(value * 100 - Math.round(value * 100)) > 0.0001
        : !Number.isInteger(value) || Math.abs(value) > 2_147_483_647)
    ) {
      setError('请填写非零增减数值和原因；国库最多两位小数，人力为整数。');
      return;
    }
    const previous = recalculate(changes)
      .filter(
        (item) => item.countryId === country.id && item.resource === resource,
      )
      .at(-1);
    const before =
      previous?.after ??
      Math.round(
        ((resource === 'Treasury' ? country.treasury : country.manpower) +
          automaticResources
            .filter(
              (c) => c.countryId === country.id && c.resource === resource,
            )
            .reduce((sum, c) => sum + c.amount, 0)) *
          100,
      ) / 100;
    const after = Math.round((before + value) * 100) / 100;
    if (
      resource === 'Manpower'
        ? after < 0 || after > 2_147_483_647
        : Math.abs(after) > 1_000_000_000
    ) {
      setError('收支超出余额范围，人力不能为负。');
      return;
    }
    onChange([
      ...recalculate(changes),
      {
        id: crypto.randomUUID(),
        actionId,
        countryId,
        countryName: country.name,
        expectedResourceRevision: country.resourceRevision,
        resource,
        amount: value,
        reason: reason.trim(),
        before,
        after,
      },
    ]);
    setAmount('');
    setReason('');
  }
  return (
    <details
      className="settlement-state-editor"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>
        资源收支{scoped.length ? `（${scoped.length} 笔）` : ''}
      </summary>
      {open && (
        <>
          {scoped.length > 0 && (
            <ul className="resource-change-list">
              {scoped.map((item) => (
                <li key={item.id}>
                  <span>
                    {item.countryName} · {resourceNames[item.resource]}{' '}
                    {signedAmount(item.amount)}（{item.before.toLocaleString()}{' '}
                    → {item.after.toLocaleString()}）<br />
                    {item.reason}
                  </span>
                  <button
                    disabled={busy}
                    aria-label={`移除收支：${item.reason}`}
                    onClick={() =>
                      onChange(
                        recalculate(changes.filter((c) => c.id !== item.id)),
                      )
                    }
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          <div className="resource-form">
            <label>
              国家
              <select
                disabled={busy || loading}
                value={countryId}
                onChange={(event) => setCountryId(event.target.value)}
              >
                {options?.countries.map((country) => (
                  <option key={country.id} value={country.id}>
                    {country.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              资源
              <select
                disabled={busy}
                value={resource}
                onChange={(event) =>
                  setResource(event.target.value as CountryResource)
                }
              >
                <option value="Treasury">国库</option>
                <option value="Manpower">人力</option>
              </select>
            </label>
            <label>
              增减数值（收入填正数，支出填负数）
              <input
                type="number"
                step={resource === 'Treasury' ? '0.01' : '1'}
                disabled={busy}
                value={amount}
                onChange={(event) => setAmount(event.target.value)}
              />
            </label>
            <label>
              原因
              <input
                maxLength={2000}
                disabled={busy}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
            </label>
          </div>
          <div className="form-actions">
            <button
              disabled={busy || loading || !options?.countries.length}
              onClick={add}
            >
              添加收支
            </button>
            <button
              disabled={busy || loading}
              onClick={() => setReload((v) => v + 1)}
            >
              重读余额
            </button>
            {loading && <span>加载中…</span>}
          </div>
        </>
      )}
    </details>
  );
}
