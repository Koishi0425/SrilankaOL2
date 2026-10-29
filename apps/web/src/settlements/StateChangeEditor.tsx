import { useEffect, useRef, useState } from 'react';
import type {
  SettlementStateChange,
  SettlementStateOptions,
  ProvinceStats,
  ActionObjectRef,
} from '@srilanka/contracts';
import { provinceStatFields } from '@srilanka/contracts';
import { fetchSettlementStateOptions } from '../api.js';
const provinceFields = [
  { key: 'taxBase', label: '税收基础', min: 0, max: 1000000, step: 1 },
  { key: 'productionBase', label: '生产基础', min: 0, max: 1000000, step: 1 },
  { key: 'manpowerBase', label: '人力基础', min: 0, max: 1000000, step: 1 },
  { key: 'autonomy', label: '自治（%）', min: 0, max: 100, step: 0.01 },
  { key: 'unrest', label: '不满', min: -100, max: 100, step: 0.01 },
] as const;
export function StateChangeRecord({
  change,
  prefix = '',
}: {
  change: SettlementStateChange;
  prefix?: string;
}) {
  return (
    <span>
      {prefix}
      {change.summary}
      {(change.kind === 'Province' || change.kind === 'TradeInfluence') && (
        <>
          <br />
          {change.reason}
        </>
      )}
    </span>
  );
}

export function StateChangeEditor({
  gameId,
  quarterId,
  actionId,
  changes,
  busy,
  active,
  revision,
  onChange,
  onRevision,
  refs = [],
}: {
  gameId: string;
  quarterId: string;
  actionId: string | null;
  changes: SettlementStateChange[];
  busy: boolean;
  active: boolean;
  revision?: number;
  onChange: (changes: SettlementStateChange[]) => void;
  onRevision: (revision: number) => void;
  refs?: Array<Omit<ActionObjectRef, 'id'>>;
}) {
  const provinceTargets = refs.filter(
    (ref) => ref.objectType === 'Province' && ref.refKind === 'Target',
  );
  const [open, setOpen] = useState(provinceTargets.length > 0);
  const [options, setOptions] = useState<SettlementStateOptions | null>(null);
  const [loading, setLoading] = useState(false);
  const [reload, setReload] = useState(0);
  const [error, setError] = useState('');
  const [kind, setKind] = useState<
    Exclude<SettlementStateChange['kind'], 'TileTag'>
  >(provinceTargets.length ? 'Province' : 'ArmyMove');
  const [armyId, setArmyId] = useState('');
  const [strength, setStrength] = useState('');
  const [minQ, setMinQ] = useState('');
  const [maxQ, setMaxQ] = useState('');
  const [minR, setMinR] = useState('');
  const [maxR, setMaxR] = useState('');
  const [controller, setController] = useState('keep');
  const [owner, setOwner] = useState('keep');
  const [provinceId, setProvinceId] = useState(
    provinceTargets[0]?.objectId ?? '',
  );
  const [provinceValues, setProvinceValues] = useState<
    Partial<Record<keyof ProvinceStats, string>>
  >({});
  const [provinceReason, setProvinceReason] = useState('');
  const [tradeZoneId, setTradeZoneId] = useState(''),
    [tradeCountryId, setTradeCountryId] = useState(''),
    [tradePower, setTradePower] = useState(''),
    [tradeReason, setTradeReason] = useState('');
  const tradeZone = options?.tradeZones?.find((z) => z.id === tradeZoneId);
  const currentTradePower =
    tradeZone?.influences.find((i) => i.countryId === tradeCountryId)?.power ??
    0;
  const province = options?.provinces?.find((p) => p.id === provinceId);
  const revisionCallback = useRef(onRevision);
  revisionCallback.current = onRevision;
  const scoped = changes.filter(
    (change) => change.actionId === actionId && change.kind !== 'TileTag',
  );

  useEffect(() => {
    if (!open || !active) return;
    let live = true;
    setLoading(true);
    setError('');
    void fetchSettlementStateOptions(gameId, quarterId)
      .then((data) => {
        if (!live) return;
        setOptions(data);
        revisionCallback.current(data.mapRevision);
      })
      .catch((cause: unknown) => {
        if (live) {
          setOptions(null);
          setError(cause instanceof Error ? cause.message : '当前状态读取失败');
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [active, gameId, open, quarterId, reload, revision]);

  function add() {
    if (!options || busy || loading) return;
    setError('');
    if (changes.length && options.mapRevision !== revision) {
      setError('地图已变化，请先保存或移除已有变化，再重新添加。');
      return;
    }
    const coordinates =
      kind === 'Territory' ? [minQ, maxQ, minR, maxR] : [minQ, minR];
    if (
      kind !== 'ArmyStrength' &&
      kind !== 'Province' &&
      kind !== 'TradeInfluence' &&
      coordinates.some(
        (value) => !value.trim() || !Number.isInteger(Number(value)),
      )
    ) {
      setError('请填写整数坐标。');
      return;
    }
    const base = { id: crypto.randomUUID(), actionId };
    let change: SettlementStateChange;
    if (kind === 'TradeInfluence') {
      const country = options.countries.find((c) => c.id === tradeCountryId),
        power = Number(tradePower);
      if (
        !tradeZone ||
        !country ||
        !tradePower.trim() ||
        !Number.isFinite(power) ||
        power < 0 ||
        power > 1000000 ||
        Math.abs(power * 100 - Math.round(power * 100)) > 0.0001 ||
        power === currentTradePower ||
        !tradeReason.trim()
      ) {
        setError(
          '请选择贸易区与国家，填写与当前不同的非负影响力和原因，最多两位小数。',
        );
        return;
      }
      if (
        changes.some(
          (c) =>
            c.kind === 'TradeInfluence' &&
            c.zoneId === tradeZone.id &&
            c.countryId === country.id,
        )
      ) {
        setError('该国在此贸易区已有影响力变化，请合并设置。');
        return;
      }
      change = {
        ...base,
        kind,
        zoneId: tradeZone.id,
        countryId: country.id,
        power,
        expectedZoneRevision: tradeZone.revision,
        reason: tradeReason.trim(),
        zoneName: tradeZone.name,
        countryName: country.name,
        beforePower: currentTradePower,
        summary: `${tradeZone.name} · ${country.name}：贸易影响力 ${currentTradePower} → ${power}`,
      };
    } else if (kind === 'Province') {
      if (!province) {
        setError('请选择省份。');
        return;
      }
      const values: Partial<ProvinceStats> = {};
      for (const field of provinceFields) {
        const text = provinceValues[field.key];
        if (!text?.trim()) continue;
        const value = Number(text);
        if (
          !Number.isFinite(value) ||
          value < field.min ||
          value > field.max ||
          (field.step === 1
            ? !Number.isInteger(value)
            : Math.abs(value * 100 - Math.round(value * 100)) > 0.0001)
        ) {
          setError(
            '基础值须为非负整数；自治为 0–100，不满为 -100–100，最多两位小数。',
          );
          return;
        }
        if (value !== province.values[field.key]) values[field.key] = value;
      }
      if (!Object.keys(values).length || !provinceReason.trim()) {
        setError('请调整至少一项省份数值，并填写原因。');
        return;
      }
      if (
        changes.some(
          (c) =>
            c.kind === 'Province' &&
            c.provinceId === province.id &&
            provinceStatFields.some(
              (key) => values[key] !== undefined && c.values[key] !== undefined,
            ),
        )
      ) {
        setError('该省份的指标已有变化，请合并设置或先移除原变化。');
        return;
      }
      const fields = provinceFields.filter((f) => values[f.key] !== undefined);
      change = {
        ...base,
        kind,
        provinceId: province.id,
        expectedProfileRevision: province.revision,
        values,
        reason: provinceReason.trim(),
        provinceName: province.name,
        beforeValues: Object.fromEntries(
          fields.map((f) => [f.key, province.values[f.key]]),
        ),
        summary: `${province.name}：${fields.map((f) => `${f.label.replace('（%）', '')} ${province.values[f.key]}${f.key === 'autonomy' ? '%' : ''} → ${values[f.key]}${f.key === 'autonomy' ? '%' : ''}`).join('，')}`,
      };
    } else if (kind === 'Territory') {
      const bounds = coordinates.map(Number);
      if (bounds[0]! > bounds[1]! || bounds[2]! > bounds[3]!) {
        setError('起始坐标不能大于结束坐标。');
        return;
      }
      const selected = options.tiles.filter(
        (tile) =>
          tile.q >= bounds[0]! &&
          tile.q <= bounds[1]! &&
          tile.r >= bounds[2]! &&
          tile.r <= bounds[3]!,
      );
      const expected =
        (bounds[1]! - bounds[0]! + 1) * (bounds[3]! - bounds[2]! + 1);
      if (
        !selected.length ||
        selected.length !== expected ||
        selected.length > 2500
      ) {
        setError('选区必须在地图范围内，且不超过 2500 个地块。');
        return;
      }
      if (controller === 'keep' && owner === 'keep') {
        setError('请指定控制国或法定归属。');
        return;
      }
      const countryName = (id: string) =>
        id === ''
          ? '无'
          : (options.countries.find((country) => country.id === id)?.name ??
            '');
      const tileIds = selected.map((tile) => tile.id);
      if (
        changes.some(
          (item) =>
            item.kind === 'Territory' &&
            item.tileIds.some((id) => tileIds.includes(id)) &&
            ((controller !== 'keep' &&
              item.controllerCountryId !== undefined) ||
              (owner !== 'keep' && item.legalOwnerCountryId !== undefined)),
        )
      ) {
        setError('选区与已有领土变化重复，请合并设置。');
        return;
      }
      change = {
        ...base,
        kind,
        tileIds,
        ...(controller === 'keep'
          ? {}
          : { controllerCountryId: controller || null }),
        ...(owner === 'keep' ? {} : { legalOwnerCountryId: owner || null }),
        summary: `${tileIds.length} 个地块（列 ${minQ}–${maxQ}，行 ${minR}–${maxR}）：${[
          ...(controller === 'keep'
            ? []
            : [`控制 → ${countryName(controller)}`]),
          ...(owner === 'keep' ? [] : [`法定归属 → ${countryName(owner)}`]),
        ].join('，')}`,
      };
    } else {
      const army = options.armies.find((item) => item.id === armyId);
      if (!army) {
        setError('请选择军队。');
        return;
      }
      if (
        changes.some((item) => item.kind === kind && item.armyId === armyId)
      ) {
        setError('该军队已有同类变化，请先移除原变化。');
        return;
      }
      if (kind === 'ArmyStrength') {
        const next = Number(strength);
        if (
          !strength.trim() ||
          !Number.isInteger(next) ||
          next < 0 ||
          next > 2_147_483_647 ||
          next === army.strength
        ) {
          setError('请填写与当前兵力不同的非负整数。');
          return;
        }
        change = {
          ...base,
          kind,
          armyId,
          strength: next,
          summary: `${army.name}：兵力 ${army.strength} → ${next}`,
        };
      } else {
        const tile = options.tiles.find(
          (item) => item.q === Number(minQ) && item.r === Number(minR),
        );
        if (!tile?.passable || tile.id === army.tileId) {
          setError('目的地须在地图内、可以通行，且与当前位置不同。');
          return;
        }
        change = {
          ...base,
          kind,
          armyId,
          destinationTileId: tile.id,
          summary: `${army.name}：(${army.q}, ${army.r}) → (${tile.q}, ${tile.r})`,
        };
      }
    }
    onChange([...changes, change]);
    if (kind === 'Province') {
      setProvinceValues({});
      setProvinceReason('');
    }
    if (kind === 'TradeInfluence') {
      setTradePower('');
      setTradeReason('');
    }
  }

  return (
    <details
      className="settlement-state-editor"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>状态变化{scoped.length ? `（${scoped.length}）` : ''}</summary>
      {scoped.length > 0 && (
        <ul className="state-change-list">
          {scoped.map((change) => (
            <li key={change.id}>
              <StateChangeRecord change={change} />
              <button
                disabled={busy}
                onClick={() =>
                  onChange(changes.filter((item) => item.id !== change.id))
                }
              >
                移除
              </button>
            </li>
          ))}
        </ul>
      )}
      {open && (
        <div className="state-change-form">
          <div className="state-change-heading">
            <label>
              变化类型
              <select
                disabled={busy || loading}
                value={kind}
                onChange={(event) => {
                  setKind(event.target.value as typeof kind);
                  setError('');
                }}
              >
                <option value="ArmyMove">军队移动</option>
                <option value="ArmyStrength">兵力调整</option>
                <option value="Territory">领土变化</option>
                <option value="Province">省份发展与治理</option>
                <option value="TradeInfluence">贸易影响力调整</option>
              </select>
            </label>
            <button
              disabled={busy || loading}
              onClick={() => setReload((value) => value + 1)}
            >
              重读当前状态
            </button>
          </div>
          {loading && <p role="status">读取中…</p>}
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {options && (
            <>
              {kind !== 'Territory' &&
                kind !== 'Province' &&
                kind !== 'TradeInfluence' && (
                  <label>
                    军队
                    <select
                      disabled={busy || loading}
                      value={armyId}
                      onChange={(event) => {
                        setArmyId(event.target.value);
                        setStrength(
                          String(
                            options.armies.find(
                              (item) => item.id === event.target.value,
                            )?.strength ?? '',
                          ),
                        );
                      }}
                    >
                      <option value="">请选择</option>
                      {options.armies.map((army) => (
                        <option key={army.id} value={army.id}>
                          {army.countryName} · {army.name}（{army.strength} 人，
                          {army.q}, {army.r}）
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              {kind === 'TradeInfluence' ? (
                <>
                  <label>
                    贸易区
                    <select
                      disabled={busy || loading}
                      value={tradeZoneId}
                      onChange={(e) => {
                        setTradeZoneId(e.target.value);
                        setTradePower(
                          String(
                            options.tradeZones
                              ?.find((z) => z.id === e.target.value)
                              ?.influences.find(
                                (i) => i.countryId === tradeCountryId,
                              )?.power ?? 0,
                          ),
                        );
                      }}
                    >
                      <option value="">请选择</option>
                      {options.tradeZones?.map((z) => (
                        <option key={z.id} value={z.id}>
                          {z.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    影响力所属国家
                    <select
                      disabled={busy || loading}
                      value={tradeCountryId}
                      onChange={(e) => {
                        setTradeCountryId(e.target.value);
                        setTradePower(
                          String(
                            tradeZone?.influences.find(
                              (i) => i.countryId === e.target.value,
                            )?.power ?? 0,
                          ),
                        );
                      }}
                    >
                      <option value="">请选择</option>
                      {options.countries.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  {tradeZone && tradeCountryId && (
                    <p>当前影响力：{currentTradePower}</p>
                  )}
                  <label>
                    调整后贸易影响力
                    <input
                      type="number"
                      min="0"
                      max="1000000"
                      step="0.01"
                      disabled={busy || loading}
                      value={tradePower}
                      onChange={(e) => setTradePower(e.target.value)}
                    />
                  </label>
                  <label>
                    贸易变化原因
                    <input
                      maxLength={2000}
                      disabled={busy || loading}
                      value={tradeReason}
                      onChange={(e) => setTradeReason(e.target.value)}
                    />
                  </label>
                  <p>
                    发布后生效，从下一季影响贸易分成；本季临时损益可在经济账单中修正。
                  </p>
                </>
              ) : kind === 'Province' ? (
                <>
                  <label>
                    省份
                    <select
                      disabled={busy || loading}
                      value={provinceId}
                      onChange={(e) => {
                        setProvinceId(e.target.value);
                        setProvinceValues({});
                        setProvinceReason('');
                      }}
                    >
                      <option value="">请选择</option>
                      {options.provinces?.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {provinceTargets.some((ref) => ref.objectId === p.id)
                            ? '（政策目标）'
                            : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {province && (
                    <>
                      <table className="province-change-table">
                        <thead>
                          <tr>
                            <th>指标</th>
                            <th>当前值</th>
                            <th>调整后（留空保持）</th>
                          </tr>
                        </thead>
                        <tbody>
                          {provinceFields.map((field) => (
                            <tr key={field.key}>
                              <td>{field.label}</td>
                              <td>{province.values[field.key]}</td>
                              <td>
                                <input
                                  aria-label={`${field.label}调整后`}
                                  disabled={busy || loading}
                                  type="number"
                                  min={field.min}
                                  max={field.max}
                                  step={field.step}
                                  value={provinceValues[field.key] ?? ''}
                                  onChange={(e) =>
                                    setProvinceValues({
                                      ...provinceValues,
                                      [field.key]: e.target.value,
                                    })
                                  }
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <label>
                        省份变化原因
                        <input
                          maxLength={2000}
                          disabled={busy || loading}
                          value={provinceReason}
                          onChange={(e) => setProvinceReason(e.target.value)}
                        />
                      </label>
                      <p>
                        发布后生效，从下一季影响正常收入；费用在“资源收支”填写。
                      </p>
                    </>
                  )}
                  {options && provinceId && !province && (
                    <p role="alert" className="form-error">
                      关联省份已不存在，请核对政策目标后重新选择。
                    </p>
                  )}
                </>
              ) : kind === 'ArmyStrength' ? (
                <label>
                  调整后兵力
                  <input
                    disabled={busy || loading}
                    type="number"
                    min="0"
                    max="2147483647"
                    step="1"
                    value={strength}
                    onChange={(event) => setStrength(event.target.value)}
                  />
                </label>
              ) : (
                <div className="state-change-coordinates">
                  <label>
                    {kind === 'Territory' ? '起始列' : '目的地列'}
                    <input
                      disabled={busy || loading}
                      type="number"
                      step="1"
                      value={minQ}
                      onChange={(event) => setMinQ(event.target.value)}
                    />
                  </label>
                  {kind === 'Territory' && (
                    <label>
                      结束列
                      <input
                        disabled={busy || loading}
                        type="number"
                        step="1"
                        value={maxQ}
                        onChange={(event) => setMaxQ(event.target.value)}
                      />
                    </label>
                  )}
                  <label>
                    {kind === 'Territory' ? '起始行' : '目的地行'}
                    <input
                      disabled={busy || loading}
                      type="number"
                      step="1"
                      value={minR}
                      onChange={(event) => setMinR(event.target.value)}
                    />
                  </label>
                  {kind === 'Territory' && (
                    <label>
                      结束行
                      <input
                        disabled={busy || loading}
                        type="number"
                        step="1"
                        value={maxR}
                        onChange={(event) => setMaxR(event.target.value)}
                      />
                    </label>
                  )}
                </div>
              )}
              {kind === 'Territory' && (
                <div className="state-change-countries">
                  {[
                    { label: '控制国', value: controller, set: setController },
                    { label: '法定归属', value: owner, set: setOwner },
                  ].map((field) => (
                    <label key={field.label}>
                      {field.label}
                      <select
                        disabled={busy || loading}
                        value={field.value}
                        onChange={(event) => field.set(event.target.value)}
                      >
                        <option value="keep">保持原样</option>
                        <option value="">无</option>
                        {options.countries.map((country) => (
                          <option key={country.id} value={country.id}>
                            {country.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <button disabled={busy || loading} onClick={add}>
                添加变化
              </button>
            </>
          )}
        </div>
      )}
    </details>
  );
}
