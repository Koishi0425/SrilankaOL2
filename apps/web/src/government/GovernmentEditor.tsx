import { useEffect, useState } from 'react';
import { nationalPolicyStatus, policyEffectNames } from '@srilanka/contracts';
import type {
  GovernmentChange,
  GovernmentData,
  GovernmentChangeInput,
  NationalPolicy,
  EconomicLineKind,
  DiplomacyQuarter,
  GovernmentProfile,
} from '@srilanka/contracts';
import { fetchGovernment } from '../api.js';
import { quarterLabel } from '../diplomacy/DiplomacyEditor.js';
export const policyStatusNames = {
  Upcoming: '待生效',
  Active: '有效',
  Expired: '已到期',
  Ended: '已终止',
};
function after(q: DiplomacyQuarter, count: number): DiplomacyQuarter {
  const seasons = ['Spring', 'Summer', 'Autumn', 'Winter'] as const,
    n = seasons.indexOf(q.season) + count;
  return {
    sequenceNumber: q.sequenceNumber + count,
    gameYear: q.gameYear + Math.floor(n / 4),
    season: seasons[n % 4]!,
  };
}
export function PolicyDetails({ policy }: { policy: NationalPolicy }) {
  return (
    <div className="government-terms">
      <p>
        生效：{quarterLabel(policy.startsAt)}；
        {policy.expiresAt
          ? `到期：${quarterLabel(policy.expiresAt)}准备阶段`
          : '期限：长期'}
        {policy.endedAt && `；终止：${quarterLabel(policy.endedAt)}准备阶段`}
      </p>
      <p className="rules-text">{policy.text}</p>
      {Object.keys(policy.effects).length ? (
        <ul>
          {Object.entries(policy.effects).map(([key, value]) => (
            <li key={key}>
              {policyEffectNames[key as EconomicLineKind]}：
              {value! > 0 ? '+' : ''}
              {value}%
            </li>
          ))}
        </ul>
      ) : (
        <p>未设置自动经济效果。</p>
      )}
    </div>
  );
}
export function GovernmentRecord({ change }: { change: GovernmentChange }) {
  return (
    <details className="government-record">
      <summary>{change.summary}</summary>
      <p className="rules-text">{change.reason}</p>
      {change.kind === 'Government' ? (
        <>
          <p>政体：{(change.after as GovernmentProfile).regime || '未填写'}</p>
          <p>
            执政者或机构：
            {'authority' in change.after ? change.after.authority : ''}
          </p>
          <p className="rules-text">
            {'description' in change.after ? change.after.description : ''}
          </p>
        </>
      ) : (
        <PolicyDetails policy={change.after as NationalPolicy} />
      )}
    </details>
  );
}
export function GovernmentForm({
  data,
  initialCountryId,
  actionId,
  changes,
  busy,
  operation,
  onChange,
}: {
  data: GovernmentData;
  initialCountryId?: string;
  actionId: string | null;
  changes: GovernmentChange[];
  busy: boolean;
  operation: 'Setup' | 'Settlement';
  onChange: (changes: GovernmentChange[]) => void;
}) {
  const [snapshot] = useState(data),
    [kind, setKind] = useState<GovernmentChangeInput['kind']>('Government'),
    [countryId, setCountryId] = useState(
      initialCountryId ?? data.countries?.[0]?.id ?? '',
    );
  const first = snapshot.profiles.find((p) => p.countryId === countryId);
  const [regime, setRegime] = useState(first?.regime ?? ''),
    [authority, setAuthority] = useState(first?.authority ?? ''),
    [description, setDescription] = useState(first?.description ?? ''),
    [policyId, setPolicyId] = useState(''),
    [title, setTitle] = useState(''),
    [type, setType] = useState<'Policy' | 'Reform'>('Policy'),
    [text, setText] = useState(''),
    [duration, setDuration] = useState(''),
    [effects, setEffects] = useState<Record<string, string>>({}),
    [reason, setReason] = useState(''),
    [error, setError] = useState('');
  function selectCountry(id: string) {
    setCountryId(id);
    setPolicyId('');
    const p = snapshot.profiles.find((p) => p.countryId === id);
    setRegime(p?.regime ?? '');
    setAuthority(p?.authority ?? '');
    setDescription(p?.description ?? '');
  }
  const policies = snapshot.policies.filter(
    (p) =>
      p.countryId === countryId &&
      !p.endedAt &&
      nationalPolicyStatus(p, snapshot.quarter.sequenceNumber) !== 'Expired',
  );
  function add() {
    setError('');
    const country = snapshot.countries?.find((c) => c.id === countryId);
    if (!country || !reason.trim()) {
      setError('请选择国家并填写变化原因。');
      return;
    }
    const base = {
      id: crypto.randomUUID(),
      actionId,
      expectedRevision: snapshot.revision,
      expectedQuarterSequence: snapshot.quarter.sequenceNumber,
      reason: reason.trim(),
    };
    let input: GovernmentChangeInput,
      before: GovernmentChange['before'],
      next: GovernmentChange['after'],
      summary: string;
    if (kind === 'Government') {
      before = snapshot.profiles.find((p) => p.countryId === countryId)!;
      next = {
        countryId,
        countryName: country.name,
        regime: regime.trim(),
        authority: authority.trim(),
        description: description.trim(),
      };
      if (
        before.regime === next.regime &&
        before.authority === next.authority &&
        before.description === next.description
      ) {
        setError('政府资料未变化。');
        return;
      }
      if (
        changes.some(
          (c) => c.kind === 'Government' && c.countryId === countryId,
        )
      ) {
        setError('该国已有政府资料变化，请先移除再添加。');
        return;
      }
      input = {
        ...base,
        kind,
        countryId,
        regime: next.regime,
        authority: next.authority,
        description: next.description,
      };
      summary = country.name + '：更新政府资料';
    } else {
      const effective = after(
        snapshot.quarter,
        operation === 'Settlement' ? 1 : 0,
      );
      if (kind === 'EndPolicy') {
        const policy = policies.find((p) => p.id === policyId);
        if (!policy) {
          setError('请选择有效或待生效的政策。');
          return;
        }
        if (
          changes.some(
            (c) => c.kind !== 'Government' && c.policyId === policyId,
          )
        ) {
          setError('该政策已有变化，请先移除再添加。');
          return;
        }
        input = { ...base, kind, policyId };
        before = policy;
        next = { ...policy, endedAt: effective };
        summary = `${country.name}：终止政策“${policy.title}”（${operation === 'Settlement' ? '下季' : '本季'}起）`;
      } else {
        const count = duration.trim() ? Number(duration) : null;
        const values = Object.fromEntries(
          Object.entries(effects)
            .filter(([, v]) => v.trim())
            .map(([key, value]) => [key, Number(value)]),
        );
        if (
          !title.trim() ||
          !text.trim() ||
          (count !== null &&
            (!Number.isInteger(count) || count < 1 || count > 400)) ||
          Object.values(values).some(
            (v) =>
              !Number.isFinite(v) ||
              v < -100 ||
              v > 1000 ||
              Math.abs(v * 100 - Math.round(v * 100)) > 0.0001,
          )
        ) {
          setError(
            '请填写政策条文和有效期限；效果为 -100% 至 1000%，最多两位小数。',
          );
          return;
        }
        const id = crypto.randomUUID();
        input = {
          ...base,
          kind,
          countryId,
          policyId: id,
          title: title.trim(),
          type,
          text: text.trim(),
          durationQuarters: count,
          effects: values,
        };
        before = null;
        next = {
          id,
          countryId,
          countryName: country.name,
          title: input.title,
          type,
          text: input.text,
          effects: values,
          startsAt: effective,
          expiresAt: count === null ? null : after(effective, count),
          endedAt: null,
        };
        summary = `${country.name}：施行${type === 'Policy' ? '政策' : '改革'}“${input.title}”（${operation === 'Settlement' ? '下季' : '本季'}起）`;
      }
    }
    onChange([
      ...changes,
      {
        ...input,
        countryId,
        countryName: country.name,
        before,
        after: next,
        summary,
      },
    ]);
    setReason('');
    setTitle('');
    setText('');
    setEffects({});
    setDuration('');
    setPolicyId('');
  }
  return (
    <div className="government-form">
      <label>
        行政操作
        <select
          value={kind}
          disabled={busy}
          onChange={(e) => {
            setKind(e.target.value as typeof kind);
            setError('');
            setReason('');
          }}
        >
          <option value="Government">更新政府资料</option>
          <option value="Policy">施行长期政策或改革</option>
          <option value="EndPolicy">终止长期政策或改革</option>
        </select>
      </label>
      <label>
        所属国家
        <select
          value={countryId}
          disabled={busy}
          onChange={(e) => selectCountry(e.target.value)}
        >
          {snapshot.countries?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {kind === 'Government' ? (
        <>
          <label>
            政体
            <input
              value={regime}
              maxLength={120}
              disabled={busy}
              onChange={(e) => setRegime(e.target.value)}
            />
          </label>
          <label>
            统治者或执政机构
            <input
              value={authority}
              maxLength={120}
              disabled={busy}
              onChange={(e) => setAuthority(e.target.value)}
            />
          </label>
          <label>
            政府说明
            <textarea
              rows={4}
              value={description}
              maxLength={5000}
              disabled={busy}
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>
        </>
      ) : kind === 'EndPolicy' ? (
        <label>
          要终止的政策
          <select
            value={policyId}
            disabled={busy}
            onChange={(e) => setPolicyId(e.target.value)}
          >
            <option value="">请选择</option>
            {policies.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <>
          <label>
            政策类别
            <select
              value={type}
              disabled={busy}
              onChange={(e) => setType(e.target.value as typeof type)}
            >
              <option value="Policy">长期政策</option>
              <option value="Reform">改革</option>
            </select>
          </label>
          <label>
            政策名称
            <input
              value={title}
              maxLength={200}
              disabled={busy}
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label>
            政策条文
            <textarea
              rows={6}
              value={text}
              maxLength={20000}
              disabled={busy}
              onChange={(e) => setText(e.target.value)}
            />
          </label>
          <label>
            期限（季，留空为长期）
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
          <fieldset disabled={busy}>
            <legend>持续经济效果（%）</legend>
            {Object.entries(policyEffectNames).map(([key, name]) => (
              <label key={key}>
                {name}
                <input
                  type="number"
                  min={-100}
                  max={1000}
                  step=".01"
                  value={effects[key] ?? ''}
                  onChange={(e) =>
                    setEffects({ ...effects, [key]: e.target.value })
                  }
                />
              </label>
            ))}
          </fieldset>
          <p>
            {operation === 'Settlement'
              ? '下季开始生效，期限按后续完整季度计算。'
              : '开场政策本季生效，期限含本季。'}
            同项百分比相加，最低按 -100%
            计算；费用项目正值增加支出，负值减少支出。留空不设自动效果。
          </p>
        </>
      )}
      <label>
        行政变化原因
        <textarea
          rows={2}
          maxLength={2000}
          value={reason}
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
        添加行政变化
      </button>
    </div>
  );
}
export function GovernmentEditor({
  gameId,
  actionId,
  initialCountryId,
  changes,
  busy,
  active,
  onChange,
}: {
  gameId: string;
  actionId: string | null;
  initialCountryId?: string;
  changes: GovernmentChange[];
  busy: boolean;
  active: boolean;
  onChange: (changes: GovernmentChange[]) => void;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<GovernmentData | null>(null),
    [error, setError] = useState(''),
    [reload, setReload] = useState(0),
    [formVersion, setFormVersion] = useState(-1),
    [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!open || !active || (data && reload === formVersion)) return;
    const controller = new AbortController();
    setLoading(true);
    void fetchGovernment(gameId, undefined, controller.signal)
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
          setError(e instanceof Error ? e.message : '行政资料读取失败');
          setLoading(false);
        }
      });
    return () => controller.abort();
  }, [open, active, gameId, reload, formVersion, data]);
  return (
    <details
      className="state-change-editor"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        政府与长期政策
        {changes.filter((c) => c.actionId === actionId).length
          ? `（${changes.filter((c) => c.actionId === actionId).length}）`
          : ''}
      </summary>
      {open && (
        <>
          {changes
            .filter((c) => c.actionId === actionId)
            .map((c) => (
              <div key={c.id}>
                <GovernmentRecord change={c} />
                <button
                  disabled={busy}
                  onClick={() => onChange(changes.filter((i) => i.id !== c.id))}
                >
                  移除行政变化：{c.summary}
                </button>
              </div>
            ))}
          <button
            disabled={busy || loading}
            onClick={() => setReload((v) => v + 1)}
          >
            重读行政资料
          </button>
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {loading && <p>加载中…</p>}
          {data && (
            <GovernmentForm
              key={formVersion}
              data={data}
              initialCountryId={initialCountryId}
              actionId={actionId}
              operation="Settlement"
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
