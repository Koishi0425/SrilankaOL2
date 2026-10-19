import { useEffect, useRef, useState } from 'react';
import type {
  CorrectSettlementInput,
  QuarterSettlement,
  SettlementCorrection,
  SettlementCorrectionChange,
  SettlementCorrectionOptions,
} from '@srilanka/contracts';
import { correctSettlement, fetchCorrectionOptions } from '../api.js';
import { resourceNames, signedAmount } from '../countries/resource-labels.js';

const seasons = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};
const kinds = {
  PublicReport: '公报文字',
  ActionFeedback: '政策反馈',
  Resource: '国库／人力',
  ArmyStrength: '军队兵力',
};

function CorrectionRecord({ record }: { record: SettlementCorrection }) {
  const change = record.change;
  return (
    <article className="correction-record">
      <header>
        <strong>{kinds[change.kind]}</strong>
        <time>{new Date(record.createdAt).toLocaleString('zh-CN')}</time>
      </header>
      {change.kind === 'Resource' && (
        <p>
          {change.countryName} · {resourceNames[change.resource]}{' '}
          <strong>{signedAmount(change.amount)}</strong>（
          {change.before.toLocaleString()} → {change.after.toLocaleString()}）
        </p>
      )}
      {change.kind === 'ArmyStrength' && (
        <p>
          {change.countryName} · {change.armyName}：
          {change.before.toLocaleString()} → {change.after.toLocaleString()}
        </p>
      )}
      {(change.kind === 'PublicReport' || change.kind === 'ActionFeedback') && (
        <>
          {change.kind === 'ActionFeedback' && <p>{change.title}</p>}
          <details>
            <summary>修改前后</summary>
            <div className="correction-comparison">
              <section>
                <h5>原文</h5>
                <p className="rules-text">{change.before || '（空）'}</p>
              </section>
              <section>
                <h5>修正版</h5>
                <p className="rules-text">{change.after || '（空）'}</p>
              </section>
            </div>
          </details>
        </>
      )}
      <p className="rules-text">原因：{record.reason}</p>
      <footer>
        {record.actorName} · 记于第 {record.appliedQuarter.gameYear} 年
        {seasons[record.appliedQuarter.season]}
      </footer>
    </article>
  );
}

export function SettlementCorrections({
  gameId,
  data,
  canCorrect,
  onCorrected,
  onEditingChange,
}: {
  gameId: string;
  data: QuarterSettlement;
  canCorrect: boolean;
  onCorrected: (data: QuarterSettlement) => void;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [open, setOpen] = useState(false),
    [options, setOptions] = useState<SettlementCorrectionOptions | null>(null);
  const [kind, setKind] =
    useState<SettlementCorrectionChange['kind']>('PublicReport');
  const [target, setTarget] = useState(''),
    [text, setText] = useState(data.publicReport),
    [value, setValue] = useState('');
  const [reason, setReason] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false);
  const pending = useRef(false),
    retry = useRef<CorrectSettlementInput | null>(null);
  useEffect(() => {
    if (!open) return;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [open]);
  useEffect(() => {
    if (!canCorrect && open) {
      setOpen(false);
      onEditingChange?.(false);
    }
  }, [canCorrect, open, onEditingChange]);
  function edit() {
    setConfirm(false);
    retry.current = null;
  }
  async function begin() {
    setBusy(true);
    setError('');
    try {
      const next = await fetchCorrectionOptions(gameId, data.quarter.id);
      if (next.correctionVersion !== (data.correctionVersion ?? 0))
        throw new Error('结算已更正，请先刷新结算再操作。');
      setOptions(next);
      setOpen(true);
      onEditingChange?.(true);
      setText(data.publicReport);
      setKind('PublicReport');
      setTarget('');
      setValue('');
      setReason('');
      setConfirm(false);
      retry.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  const country = options?.countries.find((c) => c.id === target),
    army = options?.armies.find((a) => a.id === target);
  const before =
    kind === 'Resource' && country
      ? text === 'Manpower'
        ? country.manpower
        : country.treasury
      : army?.strength;
  const after =
    kind === 'Resource' && before !== undefined
      ? Math.round((before + Number(value)) * 100) / 100
      : Number(value);
  const valid =
    reason.trim() &&
    (kind === 'PublicReport'
      ? text !== data.publicReport
      : kind === 'ActionFeedback'
        ? target &&
          text.trim() &&
          text !== data.actions.find((a) => a.actionId === target)?.feedback
        : kind === 'Resource'
          ? country &&
            value.trim() &&
            Number.isFinite(Number(value)) &&
            Number(value) !== 0
          : army &&
            value.trim() &&
            Number.isInteger(Number(value)) &&
            Number(value) >= 0 &&
            Number(value) !== army.strength);
  async function submit() {
    if (!options || !valid || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    const change: SettlementCorrectionChange =
      kind === 'PublicReport'
        ? { kind, text }
        : kind === 'ActionFeedback'
          ? { kind, actionId: target, text }
          : kind === 'Resource'
            ? {
                kind,
                countryId: target,
                resource: text === 'Manpower' ? 'Manpower' : 'Treasury',
                amount: Number(value),
                expectedResourceRevision: country!.resourceRevision,
              }
            : {
                kind,
                armyId: target,
                strength: Number(value),
                expectedStrength: army!.strength,
                expectedMapRevision: options.mapRevision,
              };
    const input = retry.current ?? {
      id: crypto.randomUUID(),
      expectedCorrectionVersion: options.correctionVersion,
      expectedCurrentQuarterId: options.currentQuarter.id,
      reason: reason.trim(),
      change,
    };
    retry.current = input;
    try {
      const next = await correctSettlement(gameId, data.quarter.id, input);
      onCorrected(next);
      setOpen(false);
      onEditingChange?.(false);
      setReason('');
      retry.current = null;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更正发布失败');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="settlement-corrections" aria-label="结算更正">
      {!!data.corrections?.length && (
        <details open>
          <summary>更正记录（{data.corrections.length}）</summary>
          {data.corrections.map((record) => (
            <CorrectionRecord key={record.id} record={record} />
          ))}
        </details>
      )}
      {canCorrect && !open && (
        <button disabled={busy} onClick={() => void begin()}>
          更正已发布结果
        </button>
      )}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {canCorrect && open && options && (
        <form
          className="correction-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) setConfirm(true);
          }}
        >
          <h4>更正已发布结果</h4>
          <p>
            原结算保留。数值补正立即记入第 {options.currentQuarter.gameYear} 年
            {seasons[options.currentQuarter.season]}。
          </p>
          <fieldset disabled={busy}>
            <label>
              更正内容
              <select
                value={kind}
                onChange={(event) => {
                  const next = event.target.value as typeof kind;
                  setKind(next);
                  setTarget('');
                  setText(
                    next === 'PublicReport'
                      ? data.publicReport
                      : next === 'Resource'
                        ? 'Treasury'
                        : '',
                  );
                  setValue('');
                  edit();
                }}
              >
                {Object.entries(kinds).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </label>
            {kind === 'ActionFeedback' && (
              <label>
                政策
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setText(
                      data.actions.find((a) => a.actionId === e.target.value)
                        ?.feedback ?? '',
                    );
                    edit();
                  }}
                >
                  <option value="">选择政策</option>
                  {data.actions.map((a) => (
                    <option key={a.actionId} value={a.actionId}>
                      {a.countryName} · {a.title}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(kind === 'PublicReport' || kind === 'ActionFeedback') && (
              <label>
                修正后的全文
                <textarea
                  rows={7}
                  maxLength={20000}
                  value={text}
                  onChange={(e) => {
                    setText(e.target.value);
                    edit();
                  }}
                />
              </label>
            )}
            {kind === 'Resource' && (
              <>
                <label>
                  国家
                  <select
                    value={target}
                    onChange={(e) => {
                      setTarget(e.target.value);
                      edit();
                    }}
                  >
                    <option value="">选择国家</option>
                    {options.countries.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  资源
                  <select
                    value={text}
                    onChange={(e) => {
                      setText(e.target.value);
                      edit();
                    }}
                  >
                    <option value="Treasury">国库</option>
                    <option value="Manpower">人力</option>
                  </select>
                </label>
              </>
            )}
            {kind === 'ArmyStrength' && (
              <label>
                军队
                <select
                  value={target}
                  onChange={(e) => {
                    setTarget(e.target.value);
                    setValue(
                      String(
                        options.armies.find((a) => a.id === e.target.value)
                          ?.strength ?? '',
                      ),
                    );
                    edit();
                  }}
                >
                  <option value="">选择军队</option>
                  {options.armies.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.countryName} · {a.name}（{a.strength}）
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(kind === 'Resource' || kind === 'ArmyStrength') && (
              <>
                <label>
                  {kind === 'Resource' ? '补正增减值' : '修正后兵力'}
                  <input
                    type="number"
                    step={
                      kind === 'Resource' && text !== 'Manpower' ? '0.01' : '1'
                    }
                    value={value}
                    onChange={(e) => {
                      setValue(e.target.value);
                      edit();
                    }}
                  />
                </label>
                {before !== undefined && (
                  <p>
                    当前 {before.toLocaleString()} → 修正后{' '}
                    {Number.isFinite(after) ? after.toLocaleString() : '—'}
                  </p>
                )}
              </>
            )}
            <label>
              更正原因
              <textarea
                rows={2}
                maxLength={2000}
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  edit();
                }}
                required
              />
            </label>
            {confirm ? (
              <div className="correction-confirm">
                <p>
                  {kind === 'PublicReport'
                    ? '公报更正对所有成员可见。'
                    : '本项更正仅主持人和所属国家玩家可见。'}
                  {kind === 'Resource' || kind === 'ArmyStrength'
                    ? '确认后立即修改当前数值。'
                    : '确认后显示修正版，原文留在更正记录中。'}
                </p>
                <button
                  className="button button--primary"
                  type="button"
                  onClick={() => void submit()}
                >
                  确认发布更正
                </button>
                <button type="button" onClick={() => setConfirm(false)}>
                  返回修改
                </button>
              </div>
            ) : (
              <button type="submit" disabled={!valid}>
                检查并发布
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onEditingChange?.(false);
                setError('');
              }}
            >
              取消
            </button>
          </fieldset>
        </form>
      )}
    </section>
  );
}
