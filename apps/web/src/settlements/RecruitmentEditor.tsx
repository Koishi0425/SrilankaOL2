import { useEffect, useRef, useState } from 'react';
import type {
  NationalStatus,
  RecruitmentInput,
  ResourceChange,
  SettlementRecruitment,
  SettlementStateOptions,
} from '@srilanka/contracts';
import { fetchNationalStatus, fetchSettlementStateOptions } from '../api.js';
import { resourceNames, signedAmount } from '../countries/resource-labels.js';

export function toRecruitmentInput(
  item: SettlementRecruitment,
): RecruitmentInput {
  const {
    id,
    actionId,
    kind,
    strength,
    treasuryCost,
    manpowerCost,
    expectedResourceRevision,
    note,
  } = item;
  const base = {
    id,
    actionId,
    strength,
    treasuryCost,
    manpowerCost,
    expectedResourceRevision,
    note,
  };
  return kind === 'Create'
    ? {
        ...base,
        kind,
        countryId: item.countryId,
        name: item.name,
        tileId: item.tileId,
      }
    : { ...base, kind, armyId: item.armyId };
}
export function RecruitmentRecord({ item }: { item: SettlementRecruitment }) {
  return (
    <div className="recruitment-record">
      <p>{item.summary}</p>
      <p>
        国库消耗 {item.treasuryCost.toLocaleString()} · 人力消耗{' '}
        {item.manpowerCost.toLocaleString()}
      </p>
      <p className="rules-text">{item.note}</p>
    </div>
  );
}
export function RecruitmentEditor({
  gameId,
  quarterId,
  actionId,
  initialCountryId,
  items,
  manualResources,
  strengthTargets,
  revision,
  hasWorldChanges,
  busy,
  active,
  onChange,
  onRevision,
}: {
  gameId: string;
  quarterId: string;
  actionId: string | null;
  initialCountryId?: string;
  items: SettlementRecruitment[];
  manualResources: ResourceChange[];
  strengthTargets: string[];
  revision?: number;
  hasWorldChanges: boolean;
  busy: boolean;
  active: boolean;
  onChange: (items: SettlementRecruitment[]) => void;
  onRevision: (revision: number) => void;
}) {
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false);
  const [options, setOptions] = useState<SettlementStateOptions | null>(null),
    [national, setNational] = useState<NationalStatus | null>(null);
  const [reload, setReload] = useState(0),
    [error, setError] = useState('');
  const [kind, setKind] = useState<RecruitmentInput['kind']>('Create'),
    [countryId, setCountryId] = useState(initialCountryId ?? ''),
    [armyId, setArmyId] = useState('');
  const [name, setName] = useState(''),
    [q, setQ] = useState(''),
    [r, setR] = useState(''),
    [strength, setStrength] = useState(''),
    [treasuryCost, setTreasuryCost] = useState(''),
    [manpowerCost, setManpowerCost] = useState(''),
    [note, setNote] = useState('');
  const revisionCallback = useRef(onRevision);
  revisionCallback.current = onRevision;
  const scoped = items.filter((item) => item.actionId === actionId);
  useEffect(() => {
    if (!active || !open) return;
    let live = true;
    setLoading(true);
    setError('');
    void Promise.all([
      fetchSettlementStateOptions(gameId, quarterId),
      fetchNationalStatus(gameId),
    ])
      .then(([world, resources]) => {
        if (!live) return;
        setOptions(world);
        setNational(resources);
        revisionCallback.current(world.mapRevision);
        setCountryId((current) =>
          world.countries.some((c) => c.id === current)
            ? current
            : (world.countries[0]?.id ?? ''),
        );
      })
      .catch((cause: unknown) => {
        if (live) {
          setOptions(null);
          setNational(null);
          setError(cause instanceof Error ? cause.message : '征兵资料读取失败');
        }
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [active, open, gameId, quarterId, reload, revision]);
  function add() {
    if (!options || !national || busy || loading) return;
    setError('');
    if (hasWorldChanges && options.mapRevision !== revision) {
      setError('地图已变化，请先检查并保存已有裁决，再添加征兵。');
      return;
    }
    const army = options.armies.find((a) => a.id === armyId);
    const country = national.countries.find(
      (c) => c.id === (kind === 'Create' ? countryId : army?.countryId),
    );
    const recruits = Number(strength),
      money = Number(treasuryCost),
      people = Number(manpowerCost);
    if (
      !country ||
      !strength.trim() ||
      !Number.isInteger(recruits) ||
      recruits < 1 ||
      recruits > 2_147_483_647 ||
      !treasuryCost.trim() ||
      !Number.isFinite(money) ||
      money < 0 ||
      money > 1_000_000_000 ||
      Math.abs(money * 100 - Math.round(money * 100)) > 0.0001 ||
      !manpowerCost.trim() ||
      !Number.isInteger(people) ||
      people < 0 ||
      people > 2_147_483_647 ||
      !note.trim()
    ) {
      setError('请填写军队、正整数征募人数、非负费用与征募说明。');
      return;
    }
    if (
      manualResources.some(
        (c) =>
          c.countryId === country.id &&
          c.expectedResourceRevision !== country.resourceRevision,
      ) ||
      items.some(
        (c) =>
          c.countryId === country.id &&
          (c.treasuryCost || c.manpowerCost) &&
          c.expectedResourceRevision !== country.resourceRevision,
      )
    ) {
      setError('该国余额已变化，请移除旧收支或征兵，重读余额后重新添加。');
      return;
    }
    const pending = manualResources.filter((c) => c.countryId === country.id);
    const costs = items.filter((c) => c.countryId === country.id);
    const finalManpower =
      country.manpower +
      pending
        .filter((c) => c.resource === 'Manpower')
        .reduce((sum, c) => sum + c.amount, 0) -
      costs.reduce((sum, c) => sum + c.manpowerCost, 0) -
      people;
    const finalTreasury =
      Math.round(
        (country.treasury +
          pending
            .filter((c) => c.resource === 'Treasury')
            .reduce((sum, c) => sum + c.amount, 0) -
          costs.reduce((sum, c) => sum + c.treasuryCost, 0) -
          money) *
          100,
      ) / 100;
    if (
      finalManpower < 0 ||
      finalManpower > 2_147_483_647 ||
      Math.abs(finalTreasury) > 1_000_000_000
    ) {
      setError('费用超出余额范围，人力不足。');
      return;
    }
    const base = {
      id: crypto.randomUUID(),
      actionId,
      strength: recruits,
      treasuryCost: money,
      manpowerCost: people,
      expectedResourceRevision: country.resourceRevision,
      note: note.trim(),
    };
    let item: SettlementRecruitment;
    if (kind === 'Create') {
      if (
        !name.trim() ||
        name.length > 120 ||
        !q.trim() ||
        !r.trim() ||
        !Number.isInteger(Number(q)) ||
        !Number.isInteger(Number(r))
      ) {
        setError('请填写军队名称及整数驻地坐标。');
        return;
      }
      const tile = options.tiles.find(
        (t) => t.q === Number(q) && t.r === Number(r),
      );
      if (!tile?.passable) {
        setError('驻地必须是本游戏的可通行地块。');
        return;
      }
      if (
        options.armies.some(
          (a) => a.countryId === country.id && a.name === name.trim(),
        ) ||
        items.some(
          (i) =>
            i.kind === 'Create' &&
            i.countryId === country.id &&
            i.name === name.trim(),
        )
      ) {
        setError('该国已有同名军队或组建计划。');
        return;
      }
      item = {
        ...base,
        kind,
        countryId: country.id,
        countryName: country.name,
        name: name.trim(),
        tileId: tile.id,
        armyName: name.trim(),
        q: tile.q,
        r: tile.r,
        beforeStrength: 0,
        afterStrength: recruits,
        summary: `${country.name}：组建${name.trim()}，${recruits} 人，驻地 (${tile.q}, ${tile.r})`,
        costs: [],
      };
    } else {
      if (!army) return;
      if (
        items.some((i) => i.kind === 'Reinforce' && i.armyId === army.id) ||
        strengthTargets.includes(army.id)
      ) {
        setError('该军队已有补兵或兵力裁决，请合并处理。');
        return;
      }
      if (army.strength + recruits > 2_147_483_647) {
        setError('补兵后军队人数超出上限。');
        return;
      }
      item = {
        ...base,
        kind,
        armyId: army.id,
        countryId: country.id,
        countryName: country.name,
        armyName: army.name,
        q: army.q,
        r: army.r,
        beforeStrength: army.strength,
        afterStrength: army.strength + recruits,
        summary: `${country.name} · ${army.name}：补充 ${recruits} 人（${army.strength} → ${army.strength + recruits}）`,
        costs: [],
      };
    }
    onChange([...items, item]);
    setName('');
    setStrength('');
    setTreasuryCost('');
    setManpowerCost('');
    setNote('');
  }
  return (
    <details
      className="settlement-state-editor"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>征兵{scoped.length ? `（${scoped.length} 项）` : ''}</summary>
      {open && (
        <>
          {!!scoped.length && (
            <ul className="state-change-list">
              {scoped.map((item) => (
                <li key={item.id}>
                  <RecruitmentRecord item={item} />
                  <button
                    disabled={busy}
                    aria-label={`移除征兵：${item.armyName}`}
                    onClick={() =>
                      onChange(items.filter((c) => c.id !== item.id))
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
              征兵方式
              <select
                disabled={busy || loading}
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                <option value="Create">组建军队</option>
                <option value="Reinforce">补充军队</option>
              </select>
            </label>
            {kind === 'Create' ? (
              <>
                <label>
                  所属国家
                  <select
                    disabled={busy || loading}
                    value={countryId}
                    onChange={(e) => setCountryId(e.target.value)}
                  >
                    {options?.countries.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  军队名称
                  <input
                    maxLength={120}
                    disabled={busy}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </label>
                <label>
                  驻地列
                  <input
                    type="number"
                    step="1"
                    disabled={busy}
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                  />
                </label>
                <label>
                  驻地行
                  <input
                    type="number"
                    step="1"
                    disabled={busy}
                    value={r}
                    onChange={(e) => setR(e.target.value)}
                  />
                </label>
              </>
            ) : (
              <label>
                补充军队
                <select
                  disabled={busy || loading}
                  value={armyId}
                  onChange={(e) => setArmyId(e.target.value)}
                >
                  <option value="">请选择</option>
                  {options?.armies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.countryName} · {a.name}（{a.strength} 人，{a.q}, {a.r}
                      ）
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label>
              征募人数
              <input
                type="number"
                min="1"
                step="1"
                disabled={busy}
                value={strength}
                onChange={(e) => setStrength(e.target.value)}
              />
            </label>
            <label>
              国库消耗
              <input
                type="number"
                min="0"
                step="0.01"
                disabled={busy}
                value={treasuryCost}
                onChange={(e) => setTreasuryCost(e.target.value)}
              />
            </label>
            <label>
              人力消耗
              <input
                type="number"
                min="0"
                step="1"
                disabled={busy}
                value={manpowerCost}
                onChange={(e) => setManpowerCost(e.target.value)}
              />
            </label>
            <label>
              征募说明
              <input
                maxLength={2000}
                disabled={busy}
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
          </div>
          <div className="form-actions">
            <button
              disabled={busy || loading || !options || !national}
              onClick={add}
            >
              添加征兵
            </button>
            <button
              disabled={busy || loading}
              onClick={() => setReload((v) => v + 1)}
            >
              重读征兵资料
            </button>
            {loading && <span>加载中…</span>}
          </div>
        </>
      )}
    </details>
  );
}

export function RecruitmentCosts({
  items,
}: {
  items: SettlementRecruitment[];
}) {
  return (
    <ul>
      {items.flatMap((item) =>
        item.costs.map((cost) => (
          <li key={cost.id}>
            {cost.countryName} · {resourceNames[cost.resource]}{' '}
            {signedAmount(cost.amount)}（{cost.before.toLocaleString()} →{' '}
            {cost.after.toLocaleString()}）· {cost.reason}
          </li>
        )),
      )}
    </ul>
  );
}
