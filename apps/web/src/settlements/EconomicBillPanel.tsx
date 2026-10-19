import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  EconomicBill,
  EconomicBillInput,
  EconomicLine,
  EconomicLineKind,
  EconomicStatus,
} from '@srilanka/contracts';
import { signedAmount, resourceNames } from '../countries/resource-labels.js';
import { PolicyDetails } from '../government/GovernmentEditor.js';
function PolicyBasis({
  bill,
  line,
}: {
  bill: EconomicBill;
  line: EconomicLine;
}) {
  if (!line.policyEffects?.length) return null;
  return (
    <details>
      <summary>期初长期政策依据</summary>
      <p>
        政策前金额：{signedAmount(line.baseAmount ?? line.calculatedAmount)}
      </p>
      {line.policyEffects.map((e) => {
        const policy = bill.policies?.find((p) => p.id === e.policyId);
        return (
          <details key={e.policyId}>
            <summary>
              {e.title}：{e.percent > 0 ? '+' : ''}
              {e.percent}%
            </summary>
            {policy && <PolicyDetails policy={policy} />}
          </details>
        );
      })}
    </details>
  );
}
export const economicNames: Record<EconomicLineKind, string> = {
  Tax: '税收',
  Production: '生产收入',
  ManpowerGrowth: '人力恢复',
  ArmyMaintenance: '军队维护',
  Administration: '行政费',
  Trade: '贸易收入',
};
function TradeBasis({
  bill,
  line,
}: {
  bill: EconomicBill;
  line: EconomicLine;
}) {
  if (line.kind !== 'Trade' || !bill.trade) return null;
  return (
    <>
      {bill.trade
        .filter((z) =>
          z.influences.some(
            (i) => i.countryId === line.countryId && i.power > 0,
          ),
        )
        .map((z) => (
          <details key={z.id}>
            <summary>{z.name}期初资料</summary>
            <p>贸易系数：{bill.rules.tradeCoefficient ?? 0}</p>
            <ul>
              {z.provinces.map((p) => (
                <li key={p.id}>
                  {p.name}：生产基础 {p.productionBase}
                  {p.tileCount === 0 ? '（无地块，不贡献贸易价值）' : ''}
                </li>
              ))}
            </ul>
            <ul>
              {z.influences.map((i) => (
                <li key={i.countryId}>
                  {bill.lines.find((l) => l.countryId === i.countryId)
                    ?.countryName ?? '国家'}
                  ：影响力 {i.power}
                </li>
              ))}
            </ul>
          </details>
        ))}
    </>
  );
}
export function toEconomicBillInput(bill: EconomicBill): EconomicBillInput {
  return {
    lines: bill.lines.map(
      ({
        id,
        countryId,
        kind,
        amount,
        expectedResourceRevision,
        adjustmentReason,
      }) => ({
        id,
        countryId,
        kind,
        amount,
        expectedResourceRevision,
        adjustmentReason,
      }),
    ),
  };
}
export function EconomicBillTable({
  bill,
  onSelect,
  editable = false,
  disabled = false,
  selectedId,
  detail,
}: {
  bill: EconomicBill;
  onSelect?: (line: EconomicLine) => void;
  editable?: boolean;
  disabled?: boolean;
  selectedId?: string | null;
  detail?: ReactNode;
}) {
  const expandedDetail = useRef<HTMLDivElement>(null);
  useEffect(() => {
    expandedDetail.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selectedId]);
  const countries = [...new Set(bill.lines.map((line) => line.countryId))];
  return (
    <div className="economic-country-list">
      {countries.map((id) => {
        const lines = bill.lines.filter((line) => line.countryId === id);
        const total = (include: (line: EconomicLine) => boolean) =>
          lines
            .filter(include)
            .reduce((sum, line) => sum + Math.round(line.amount * 100), 0) /
          100;
        const income = total(
          (line) => line.resource === 'Treasury' && line.amount > 0,
        );
        const expense = total(
          (line) => line.resource === 'Treasury' && line.amount < 0,
        );
        const net = Math.round((income + expense) * 100) / 100;
        return (
          <section
            className="economic-country"
            key={id}
            aria-label={`${lines[0]!.countryName}经济账单`}
          >
            <h5>{lines[0]!.countryName}</h5>
            <dl className="economic-country-totals">
              <div>
                <dt>收入</dt>
                <dd>{signedAmount(income)}</dd>
              </div>
              <div>
                <dt>支出</dt>
                <dd>{signedAmount(expense)}</dd>
              </div>
              <div>
                <dt>常规结余</dt>
                <dd
                  className={
                    net < 0
                      ? 'amount-negative'
                      : net > 0
                        ? 'amount-positive'
                        : ''
                  }
                >
                  {signedAmount(net)}
                </dd>
              </div>
              <div>
                <dt>人力</dt>
                <dd>
                  {signedAmount(total((line) => line.resource === 'Manpower'))}
                </dd>
              </div>
            </dl>
            <details className="economic-country-lines">
              <summary>收支明细</summary>
              <table className="economic-table">
                <thead>
                  <tr>
                    <th>项目</th>
                    <th>实际额</th>
                    {onSelect && (
                      <th aria-label={editable ? '依据与修正' : '计算依据'} />
                    )}
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <Fragment key={line.id}>
                      <tr>
                        <td>
                          {economicNames[line.kind]}（
                          {resourceNames[line.resource]}）
                          {line.adjustmentReason && (
                            <small>{line.adjustmentReason}</small>
                          )}
                        </td>
                        <td className="economic-line-amount">
                          <span
                            className={line.amount < 0 ? 'amount-negative' : ''}
                          >
                            {signedAmount(line.amount)}
                          </span>
                          {line.amount !== line.calculatedAmount && (
                            <small>
                              计算 {signedAmount(line.calculatedAmount)}
                            </small>
                          )}
                        </td>
                        {onSelect && (
                          <td>
                            <button
                              disabled={disabled}
                              aria-expanded={selectedId === line.id}
                              aria-label={`${editable ? '查看或修正' : '查看依据'}：${line.countryName} ${economicNames[line.kind]}`}
                              onClick={() => onSelect(line)}
                            >
                              {editable ? '修正' : '依据'}
                            </button>
                          </td>
                        )}
                      </tr>
                      {selectedId === line.id && detail && (
                        <tr className="economic-line-detail">
                          <td colSpan={onSelect ? 3 : 2}>
                            <div ref={expandedDetail}>{detail}</div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
            </details>
          </section>
        );
      })}
    </div>
  );
}
export function EconomicBillRecord({ bill }: { bill: EconomicBill }) {
  const [selected, setSelected] = useState<string | null>(null);
  const line = bill.lines.find((l) => l.id === selected);
  return (
    <>
      <p>
        期初依据：{new Date(bill.capturedAt).toLocaleString('zh-CN')}
        。本季建设、领土和长期政策变化从下一季影响这份计算。
      </p>
      <EconomicBillTable
        bill={bill}
        onSelect={(line) =>
          setSelected((current) => (current === line.id ? null : line.id))
        }
        selectedId={selected}
        detail={
          line && (
            <div className="economy-line">
              <strong>
                {line.countryName} · {economicNames[line.kind]}
              </strong>
              <ul>
                {line.sources.map((s, i) => (
                  <li key={i}>
                    {s.name}：{s.calculation} = {signedAmount(s.amount)}
                  </li>
                ))}
              </ul>
              {!line.sources.length && <p>期初没有对应省份或军队。</p>}
              <TradeBasis bill={bill} line={line} />
              <PolicyBasis bill={bill} line={line} />
              <button onClick={() => setSelected(null)}>收起依据</button>
            </div>
          )
        }
      />
    </>
  );
}
export function EconomicBillPanel({
  status,
  bill,
  busy,
  onGenerate,
  onChange,
}: {
  status: EconomicStatus;
  bill: EconomicBill | null;
  busy: boolean;
  onGenerate: () => Promise<void>;
  onChange: (bill: EconomicBill | null) => void;
}) {
  const [open, setOpen] = useState(false),
    [selected, setSelected] = useState<string | null>(null);
  const [amount, setAmount] = useState(''),
    [reason, setReason] = useState(''),
    [error, setError] = useState('');
  const line = bill?.lines.find((l) => l.id === selected);
  function choose(next: EconomicLine) {
    if (selected === next.id) {
      setSelected(null);
      return;
    }
    setSelected(next.id);
    setAmount(String(next.amount));
    setReason(next.adjustmentReason);
    setError('');
  }
  function apply() {
    if (!line || !bill) return;
    const value = Number(amount),
      expense =
        line.kind === 'ArmyMaintenance' || line.kind === 'Administration';
    if (
      !amount.trim() ||
      !Number.isFinite(value) ||
      (expense ? value > 0 : value < 0) ||
      (line.resource === 'Treasury'
        ? Math.abs(value) > 1000000000 ||
          Math.abs(value * 100 - Math.round(value * 100)) > 0.0001
        : !Number.isInteger(value) || value > 2147483647) ||
      (value !== line.calculatedAmount && !reason.trim())
    ) {
      setError(
        '请填写有效实际额；收入不能为负，维护费填负数，修正时须说明原因。',
      );
      return;
    }
    onChange({
      ...bill,
      lines: bill.lines.map((l) =>
        l.id === line.id
          ? { ...l, amount: value, adjustmentReason: reason.trim() }
          : l,
      ),
      effects: [],
    });
    setSelected(null);
    setError('');
  }
  return (
    <details
      className="economic-bill settlement-notice"
      open={open}
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>每季经济账单{bill ? '（已生成）' : ''}</summary>
      {open && (
        <>
          {status.status === 'MissingSnapshot' && (
            <p>本回合没有期初快照，请手动记录收支，下一回合再启用自动结算。</p>
          )}
          {!bill && status.status === 'Ready' && (
            <button disabled={busy} onClick={() => void onGenerate()}>
              生成本季账单
            </button>
          )}
          {bill && (
            <>
              <p>按期初资料计算，保存草稿后核算余额，统一发布时入账。</p>
              <EconomicBillTable
                bill={bill}
                onSelect={choose}
                editable
                disabled={busy}
                selectedId={selected}
                detail={
                  line && (
                    <div className="economy-line">
                      <strong>
                        {line.countryName} · {economicNames[line.kind]}
                      </strong>
                      <ul>
                        {line.sources.map((s, i) => (
                          <li key={i}>
                            {s.name}：{s.calculation} = {signedAmount(s.amount)}
                          </li>
                        ))}
                      </ul>
                      {!line.sources.length && <p>期初没有对应省份或军队。</p>}
                      <TradeBasis bill={bill} line={line} />
                      <PolicyBasis bill={bill} line={line} />
                      {error && (
                        <p className="form-error" role="alert">
                          {error}
                        </p>
                      )}
                      <div className="resource-form">
                        <label>
                          本季实际额
                          <input
                            type="number"
                            step={line.resource === 'Manpower' ? '1' : '0.01'}
                            disabled={busy}
                            value={amount}
                            onChange={(e) => setAmount(e.target.value)}
                          />
                        </label>
                        <label>
                          修正原因
                          <input
                            maxLength={2000}
                            disabled={busy}
                            value={reason}
                            onChange={(e) => setReason(e.target.value)}
                          />
                        </label>
                      </div>
                      <div className="form-actions">
                        <button disabled={busy} onClick={apply}>
                          应用修正
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => {
                            onChange({
                              ...bill,
                              lines: bill.lines.map((l) =>
                                l.id === line.id
                                  ? {
                                      ...l,
                                      amount: l.calculatedAmount,
                                      adjustmentReason: '',
                                    }
                                  : l,
                              ),
                              effects: [],
                            });
                            setSelected(null);
                          }}
                        >
                          恢复计算值
                        </button>
                        <button
                          disabled={busy}
                          onClick={() => setSelected(null)}
                        >
                          收起
                        </button>
                      </div>
                    </div>
                  )
                }
              />
              <button
                disabled={busy}
                onClick={() => {
                  onChange(null);
                  setSelected(null);
                }}
              >
                移除账单
              </button>
            </>
          )}
        </>
      )}
    </details>
  );
}
