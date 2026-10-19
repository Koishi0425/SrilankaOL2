import { useEffect, useState } from 'react';
import {
  treatyKindNames,
  treatyStatus,
  currentTreatyKind,
} from '@srilanka/contracts';
import type {
  DiplomacyChange,
  DiplomacyChangeInput,
  DiplomacyData,
  DiplomacyQuarter,
  DiplomaticTreaty,
  TreatyKind,
} from '@srilanka/contracts';
import { fetchDiplomacy } from '../api.js';
const seasons = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};
export const quarterLabel = (q: DiplomacyQuarter) =>
  `第 ${q.gameYear} 年 ${seasons[q.season]}`;
export const treatyStatusNames = {
  Active: '有效',
  Expired: '已到期',
  Ended: '已终止',
};
const directional = (type: TreatyKind) => type === 'Guarantee';
function expires(
  quarter: DiplomacyQuarter,
  count: number | null,
): DiplomacyQuarter | null {
  if (count === null) return null;
  const seasons = ['Spring', 'Summer', 'Autumn', 'Winter'] as const,
    index = seasons.indexOf(quarter.season) + count;
  return {
    sequenceNumber: quarter.sequenceNumber + count,
    gameYear: quarter.gameYear + Math.floor(index / 4),
    season: seasons[index % 4]!,
  };
}
export function TreatyDetails({ treaty }: { treaty: DiplomaticTreaty }) {
  const grantor =
    treaty.type === 'Guarantee'
      ? treaty.countryIds.indexOf(treaty.grantorCountryId ?? '')
      : -1;
  return (
    <div className="diplomacy-terms">
      <p>
        参与国：{treaty.countryNames.join('、')} ·{' '}
        {treaty.visibility === 'Public' ? '公开' : '秘密'}
      </p>
      {grantor >= 0 && (
        <p>
          保障方向：{treaty.countryNames[grantor]} →{' '}
          {treaty.countryNames.find((_, i) => i !== grantor)}
        </p>
      )}
      <p>
        生效：{quarterLabel(treaty.startQuarter)}；
        {treaty.endedAt
          ? `终止：${quarterLabel(treaty.endedAt)}`
          : treaty.expiresAt
            ? `到期：${quarterLabel(treaty.expiresAt)}准备阶段`
            : '期限：长期'}
      </p>
      <p className="rules-text">{treaty.terms}</p>
    </div>
  );
}
export function DiplomacyRecord({ change }: { change: DiplomacyChange }) {
  return (
    <details className="diplomacy-record">
      <summary>{change.summary}</summary>
      <p className="rules-text">{change.reason}</p>
      {change.kind !== 'WarStatus' && (
        <TreatyDetails treaty={change.after as DiplomaticTreaty} />
      )}
    </details>
  );
}
export function DiplomacyForm({
  data,
  actionId,
  busy,
  changes,
  onChange,
}: {
  data: DiplomacyData;
  actionId: string | null;
  busy: boolean;
  changes: DiplomacyChange[];
  onChange: (changes: DiplomacyChange[]) => void;
}) {
  // Keep the revision captured when this form opens, including after failed saves.
  const [snapshot] = useState(data);
  const [kind, setKind] = useState<DiplomacyChangeInput['kind']>('WarStatus'),
    [first, setFirst] = useState(''),
    [second, setSecond] = useState(''),
    [state, setState] = useState<'Peace' | 'War'>('War');
  const [treatyId, setTreatyId] = useState(''),
    [title, setTitle] = useState(''),
    [type, setType] = useState<TreatyKind>('Alliance'),
    [countries, setCountries] = useState<string[]>([]),
    [terms, setTerms] = useState(''),
    [visibility, setVisibility] = useState<'Public' | 'Participants'>('Public'),
    [duration, setDuration] = useState(''),
    [grantor, setGrantor] = useState('');
  const [reason, setReason] = useState(''),
    [error, setError] = useState('');
  const treaties = snapshot.treaties.filter((t) => !t.endedAt),
    selected = treaties.find((t) => t.id === treatyId);
  function pick(id: string) {
    setTreatyId(id);
    setError('');
    const t = treaties.find((t) => t.id === id);
    setTitle(t?.title ?? '');
    setType(t ? currentTreatyKind(t.type) : 'Alliance');
    setCountries(t?.countryIds ?? []);
    setTerms(t?.terms ?? '');
    setVisibility(t?.visibility ?? 'Public');
    setGrantor(t?.grantorCountryId ?? '');
    setDuration(
      t?.expiresAt
        ? String(
            Math.max(
              1,
              t.expiresAt.sequenceNumber - snapshot.quarter.sequenceNumber,
            ),
          )
        : '',
    );
  }
  function add() {
    setError('');
    const base = {
      id: crypto.randomUUID(),
      actionId,
      expectedRevision: snapshot.revision,
      expectedQuarterSequence: snapshot.quarter.sequenceNumber,
      reason: reason.trim(),
    };
    if (!base.reason) {
      setError('请填写外交变化原因。');
      return;
    }
    let input: DiplomacyChangeInput,
      after: DiplomacyChange['after'],
      before: DiplomacyChange['before'],
      summary: string;
    const names = new Map(snapshot.countries?.map((c) => [c.id, c.name]) ?? []);
    if (kind === 'WarStatus') {
      if (!first || !second || first === second) {
        setError('请选择两个不同的国家。');
        return;
      }
      const ids = [first, second].sort() as [string, string];
      before =
        snapshot.relations.find(
          (r) => r.countryIds.join(':') === ids.join(':'),
        ) ?? null;
      if ((before?.state ?? 'Peace') === state) {
        setError('战争状态未变化。');
        return;
      }
      if (
        changes.some(
          (c) =>
            c.kind === 'WarStatus' &&
            [...c.countryIds].sort().join(':') === ids.join(':'),
        )
      ) {
        setError('这对国家已有战争状态变化，请先移除后重新添加。');
        return;
      }
      input = { ...base, kind, countryIds: ids, state };
      after = {
        countryIds: ids,
        countryNames: [names.get(ids[0])!, names.get(ids[1])!],
        state,
        effectiveQuarter: snapshot.quarter,
        reason: base.reason,
      };
      summary =
        after.countryNames.join(' ↔ ') +
        '：' +
        ((before?.state ?? 'Peace') === 'Peace' ? '和平' : '交战') +
        ' → ' +
        (state === 'War' ? '交战' : '和平');
    } else {
      if (kind === 'EndTreaty' && !selected) {
        setError('请选择要终止的条约。');
        return;
      }
      const id = treatyId || crypto.randomUUID();
      if (changes.some((c) => c.kind !== 'WarStatus' && c.treatyId === id)) {
        setError('这份条约已有变化，请先移除后重新添加。');
        return;
      }
      before = selected ?? null;
      if (kind === 'EndTreaty') {
        input = { ...base, kind, treatyId: id };
        after = {
          ...selected!,
          endedAt: snapshot.quarter,
          updatedQuarter: snapshot.quarter,
        };
        summary = '终止条约：' + selected!.title;
      } else {
        const count = duration.trim() ? Number(duration) : null;
        if (
          !title.trim() ||
          !terms.trim() ||
          countries.length < 2 ||
          (count !== null &&
            (!Number.isInteger(count) || count < 1 || count > 400))
        ) {
          setError(
            '请填写标题、正文、至少两个参与国及有效期限（1–400 季或留空）。',
          );
          return;
        }
        if (
          directional(type) &&
          (countries.length !== 2 || !countries.includes(grantor))
        ) {
          setError('独立保障需两个参与国，并选择保障国。');
          return;
        }
        const ids = [...countries].sort();
        input = {
          ...base,
          kind,
          treatyId: id,
          title: title.trim(),
          type,
          countryIds: ids,
          terms: terms.trim(),
          visibility,
          durationQuarters: count,
          grantorCountryId: directional(type) ? grantor : null,
        };
        after = {
          id,
          title: input.title,
          type,
          countryIds: ids,
          countryNames: ids.map((id) => names.get(id)!),
          terms: input.terms,
          visibility,
          grantorCountryId: input.grantorCountryId,
          startQuarter: selected?.startQuarter ?? snapshot.quarter,
          updatedQuarter: snapshot.quarter,
          expiresAt: expires(snapshot.quarter, count),
          endedAt: null,
        };
        summary =
          (selected ? '修改条约：' : '缔结条约：') +
          after.title +
          '（' +
          after.countryNames.join('、') +
          '；' +
          (visibility === 'Public' ? '公开' : '秘密') +
          '）';
      }
    }
    onChange([...changes, { ...input, before, after, summary }]);
    setReason('');
    pick('');
  }
  return (
    <div className="diplomacy-form">
      <label>
        外交操作
        <select
          value={kind}
          disabled={busy}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            pick('');
            setReason('');
          }}
        >
          <option value="WarStatus">宣战或议和</option>
          <option value="Treaty">缔结或修改条约</option>
          <option value="EndTreaty">终止条约</option>
        </select>
      </label>
      {kind === 'WarStatus' ? (
        <>
          {[
            { label: '国家一', value: first, set: setFirst },
            { label: '国家二', value: second, set: setSecond },
          ].map((f) => (
            <label key={f.label}>
              {f.label}
              <select
                value={f.value}
                disabled={busy}
                onChange={(e) => f.set(e.target.value)}
              >
                <option value="">请选择</option>
                {snapshot.countries?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <label>
            最终战争状态
            <select
              value={state}
              disabled={busy}
              onChange={(e) => setState(e.target.value as typeof state)}
            >
              <option value="War">交战</option>
              <option value="Peace">和平</option>
            </select>
          </label>
        </>
      ) : (
        <>
          <label>
            条约
            <select
              value={treatyId}
              disabled={busy}
              onChange={(e) => pick(e.target.value)}
            >
              <option value="">
                {kind === 'Treaty' ? '新建条约' : '请选择'}
              </option>
              {treaties.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}（
                  {
                    treatyStatusNames[
                      treatyStatus(t, snapshot.quarter.sequenceNumber)
                    ]
                  }
                  ）
                </option>
              ))}
            </select>
          </label>
          {kind === 'Treaty' && (
            <>
              <label>
                条约名称
                <input
                  value={title}
                  maxLength={200}
                  disabled={busy}
                  onChange={(e) => setTitle(e.target.value)}
                />
              </label>
              <label>
                条约类别
                <select
                  value={type}
                  disabled={busy}
                  onChange={(e) => setType(e.target.value as TreatyKind)}
                >
                  {Object.entries(treatyKindNames).map(([id, name]) => (
                    <option key={id} value={id}>
                      {name}
                    </option>
                  ))}
                </select>
              </label>
              <fieldset disabled={busy || !!selected}>
                <legend>参与国家</legend>
                {snapshot.countries?.map((c) => (
                  <label key={c.id}>
                    <input
                      type="checkbox"
                      checked={countries.includes(c.id)}
                      onChange={(e) =>
                        setCountries(
                          e.target.checked
                            ? [...countries, c.id]
                            : countries.filter((id) => id !== c.id),
                        )
                      }
                    />
                    {c.name}
                  </label>
                ))}
              </fieldset>
              {directional(type) && (
                <label>
                  保障国
                  <select
                    value={grantor}
                    disabled={busy}
                    onChange={(e) => setGrantor(e.target.value)}
                  >
                    <option value="">请选择</option>
                    {snapshot.countries
                      ?.filter((c) => countries.includes(c.id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                  </select>
                </label>
              )}
              <label>
                公开范围
                <select
                  value={visibility}
                  disabled={busy || !!selected}
                  onChange={(e) =>
                    setVisibility(e.target.value as typeof visibility)
                  }
                >
                  <option value="Public">公开</option>
                  <option value="Participants">仅参与国与主持人</option>
                </select>
              </label>
              {selected && (
                <p>变更参与国或公开范围时，请终止原约后另立新约。</p>
              )}
              <label>
                期限（季，含本回合；留空为长期）
                <input
                  type="number"
                  min={1}
                  max={400}
                  step={1}
                  value={duration}
                  disabled={busy}
                  onChange={(e) => setDuration(e.target.value)}
                />
              </label>
              <label>
                条约正文
                <textarea
                  rows={6}
                  value={terms}
                  maxLength={20000}
                  disabled={busy}
                  onChange={(e) => setTerms(e.target.value)}
                />
              </label>
              <p>
                条约不自动改变战争状态或执行赔款、领土和贸易变化，请在对应结算中添加。
              </p>
            </>
          )}
        </>
      )}
      <label>
        外交变化原因
        <textarea
          rows={2}
          value={reason}
          maxLength={2000}
          disabled={busy}
          onChange={(e) => setReason(e.target.value)}
        />
      </label>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button disabled={busy} onClick={add}>
        添加外交变化
      </button>
    </div>
  );
}
export function DiplomacyEditor({
  gameId,
  actionId,
  changes,
  busy,
  active,
  onChange,
}: {
  gameId: string;
  actionId: string | null;
  changes: DiplomacyChange[];
  busy: boolean;
  active: boolean;
  onChange: (changes: DiplomacyChange[]) => void;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<DiplomacyData | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [reload, setReload] = useState(0),
    [formVersion, setFormVersion] = useState(-1);
  useEffect(() => {
    if (!open || !active || (data && formVersion === reload)) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchDiplomacy(gameId, controller.signal)
      .then((next) => {
        if (!controller.signal.aborted) {
          setLoading(false);
          setData(next);
          setFormVersion(reload);
          setError('');
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : '外交资料读取失败');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [open, active, gameId, reload, data, formVersion]);
  const own = changes.filter((c) => c.actionId === actionId);
  return (
    <details
      className="state-change-editor"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>外交{own.length ? `（${own.length}）` : ''}</summary>
      {open && (
        <>
          {own.map((c) => (
            <div key={c.id}>
              <DiplomacyRecord change={c} />
              <button
                disabled={busy}
                onClick={() => onChange(changes.filter((i) => i.id !== c.id))}
              >
                移除外交变化：{c.summary}
              </button>
            </div>
          ))}
          <button
            disabled={busy || loading}
            onClick={() => setReload((v) => v + 1)}
          >
            重读外交资料
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {loading && <p>加载中…</p>}
          {data && (
            <DiplomacyForm
              key={formVersion}
              data={data}
              actionId={actionId}
              changes={changes}
              busy={busy || loading}
              onChange={onChange}
            />
          )}
        </>
      )}
    </details>
  );
}
