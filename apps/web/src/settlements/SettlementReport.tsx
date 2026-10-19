import { useState } from 'react';
import type { QuarterSettlement, ResourceChange } from '@srilanka/contracts';
import { signedAmount, resourceNames } from '../countries/resource-labels.js';
import { GovernmentRecord } from '../government/GovernmentEditor.js';
import { DiplomacyRecord } from '../diplomacy/DiplomacyEditor.js';
import {
  ActionMapLinks,
  type MapActionReference,
} from '../map/ActionMapLinks.js';
import { discoveryNames } from '../map/MapSetupPanel.js';
import { StateChangeRecord } from './StateChangeEditor.js';
import { RecruitmentRecord } from './RecruitmentEditor.js';
import { BattleRecord, outcomeNames } from './BattleEditor.js';
import { EconomicBillRecord } from './EconomicBillPanel.js';

export function settlementResources(data: QuarterSettlement): ResourceChange[] {
  return [
    ...(data.economicBill?.effects ?? []),
    ...(data.resourceChanges ?? []),
    ...(data.recruitments ?? []).flatMap((item) => item.costs),
  ];
}

export function resourceTotals(changes: ResourceChange[]) {
  const countries = new Map<
    string,
    {
      id: string;
      name: string;
      resources: Partial<
        Record<
          ResourceChange['resource'],
          { before: number; amount: number; after: number }
        >
      >;
    }
  >();
  for (const item of changes) {
    let country = countries.get(item.countryId);
    if (!country) {
      country = { id: item.countryId, name: item.countryName, resources: {} };
      countries.set(item.countryId, country);
    }
    const value = country.resources[item.resource] ?? {
      before: item.before,
      amount: 0,
      after: item.before,
    };
    value.amount = Math.round((value.amount + item.amount) * 100) / 100;
    value.after = Math.round((value.before + value.amount) * 100) / 100;
    country.resources[item.resource] = value;
  }
  return [...countries.values()];
}

export function SettlementResourceSummary({
  data,
}: {
  data: QuarterSettlement;
}) {
  const countries = resourceTotals(settlementResources(data));
  if (!countries.length) return null;
  return (
    <section className="settlement-balance-summary" aria-label="本季收支汇总">
      <h4>本季收支</h4>
      <table>
        <thead>
          <tr>
            <th>国家</th>
            <th>国库净变化</th>
            <th>人力净变化</th>
          </tr>
        </thead>
        <tbody>
          {countries.map((country) => (
            <tr key={country.id}>
              <th scope="row">{country.name}</th>
              {(['Treasury', 'Manpower'] as const).map((resource) => {
                const value = country.resources[resource];
                return (
                  <td key={resource}>
                    {value ? (
                      <>
                        <strong
                          className={
                            value.amount < 0
                              ? 'amount-negative'
                              : value.amount > 0
                                ? 'amount-positive'
                                : ''
                          }
                        >
                          {signedAmount(value.amount)}
                        </strong>
                        <span>
                          {value.before.toLocaleString('zh-CN')} →{' '}
                          {value.after.toLocaleString('zh-CN')}
                        </span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function Effects({
  data,
  actionId,
}: {
  data: QuarterSettlement;
  actionId: string | null;
}) {
  const resources =
    data.resourceChanges?.filter((c) => c.actionId === actionId) ?? [];
  const changes =
    data.stateChanges?.filter((c) => c.actionId === actionId) ?? [];
  const diplomacy =
    data.diplomacyChanges?.filter((c) => c.actionId === actionId) ?? [];
  const government =
    data.governmentChanges?.filter((c) => c.actionId === actionId) ?? [];
  const recruitments =
    data.recruitments?.filter((c) => c.actionId === actionId) ?? [];
  const battles = data.battles?.filter((c) => c.actionId === actionId) ?? [];
  if (!(
    resources.length ||
    changes.length ||
    diplomacy.length ||
    government.length ||
    recruitments.length ||
    battles.length
  ))
    return null;
  return (
    <div className="settlement-policy-effects">
      {!!resources.length && (
        <section aria-label="政策费用与收益">
          <h5>资源收支</h5>
          <ul className="settlement-costs">
            {resources.map((c) => (
              <li key={c.id}>
                <span>
                  {(!actionId ||
                    c.countryId !==
                      data.actions.find((a) => a.actionId === actionId)
                        ?.countryId) &&
                    `${c.countryName} · `}
                  {c.reason}
                </span>
                <strong
                  className={
                    c.amount < 0 ? 'amount-negative' : 'amount-positive'
                  }
                >
                  {resourceNames[c.resource]} {signedAmount(c.amount)}
                </strong>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!changes.length && (
        <section>
          <h5>已执行状态变化</h5>
          <ul>
            {changes.map((c) => (
              <li key={c.id}>
                <StateChangeRecord change={c} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {!!diplomacy.length && (
        <section>
          <h5>已执行外交变化</h5>
          {diplomacy.map((c) => (
            <DiplomacyRecord key={c.id} change={c} />
          ))}
        </section>
      )}
      {!!government.length && (
        <section>
          <h5>已执行行政变化</h5>
          {government.map((c) => (
            <GovernmentRecord key={c.id} change={c} />
          ))}
        </section>
      )}
      {!!recruitments.length && (
        <section>
          <h5>已执行征兵</h5>
          {recruitments.map((c) => (
            <div key={c.id}>
              <RecruitmentRecord item={c} />
              <ul className="settlement-costs">
                {c.costs.map((cost) => (
                  <li key={cost.id}>
                    {resourceNames[cost.resource]} {signedAmount(cost.amount)}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}
      {battles.map((battle) => (
        <details className="battle-details" key={battle.id}>
          <summary>
            {battle.title} ·{' '}
            {battle.resolution && outcomeNames[battle.resolution.outcome]}
          </summary>
          <BattleRecord battle={battle} />
        </details>
      ))}
    </div>
  );
}

export function SettlementReport({
  data,
  host,
  onDiscussAction,
  onLocateReference,
  onError,
}: {
  data: QuarterSettlement;
  host: boolean;
  onDiscussAction?: (actionId: string) => Promise<void>;
  onLocateReference?: (ref: MapActionReference) => Promise<void>;
  onError: (message: string) => void;
}) {
  const [countryId, setCountryId] = useState('');
  const countries = [
    ...new Map(data.actions.map((a) => [a.countryId, a.countryName])).entries(),
  ];
  const selectedCountry = countries.some(([id]) => id === countryId)
    ? countryId
    : '';
  const actions = data.actions.filter(
    (a) => !host || !selectedCountry || a.countryId === selectedCountry,
  );
  const hasGlobal =
    host &&
    [
      data.resourceChanges,
      data.stateChanges,
      data.diplomacyChanges,
      data.governmentChanges,
      data.recruitments,
      data.battles,
    ].some((items) => items?.some((item) => item.actionId === null));
  return (
    <>
      {data.publicReport && (
        <article className="settlement-public-report">
          <h4>回合公报</h4>
          <p className="rules-text">{data.publicReport}</p>
        </article>
      )}
      {host && <SettlementResourceSummary data={data} />}
      {host && data.economicBill && (
        <details className="settlement-accounting">
          <summary>每季经济明细</summary>
          <EconomicBillRecord bill={data.economicBill} />
        </details>
      )}
      {hasGlobal && (
        <article className="settlement-global-events">
          <h4>回合事件</h4>
          <Effects data={data} actionId={null} />
        </article>
      )}
      {!!data.actions.length && (
        <div className="settlement-report-heading">
          <h4>政策结果</h4>
          {host && countries.length > 1 && (
            <label>
              国家
              <select
                aria-label="筛选结果国家"
                value={selectedCountry}
                onChange={(e) => setCountryId(e.target.value)}
              >
                <option value="">全部国家</option>
                {countries.map(([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
      )}
      {actions.map((item) => (
        <article
          className="settlement-policy-result"
          key={item.actionId}
          aria-label={`${host ? `${item.countryName} · ` : ''}${item.title}`}
        >
          <header>
            <h4>
              {item.title}
              {item.status === 'Rejected' ? '（已拒绝）' : ''}
            </h4>
            {host && <span>{item.countryName}</span>}
          </header>
          <p className="rules-text">{item.feedback}</p>
          {host && <Effects data={data} actionId={item.actionId} />}
          {data.mapReveals
            ?.filter((plan) => plan.actionId === item.actionId)
            .map((plan) => (
              <p className="rules-text" key={plan.actionId}>
                地图：{plan.tileIds.length} 个地块（{discoveryNames[plan.state]}
                ）{plan.note && ` · ${plan.note}`}
              </p>
            ))}
          <ActionMapLinks refs={item.refs} onLocate={onLocateReference} />
          <div className="settlement-result-tools">
            <details className="settlement-original">
              <summary>政策原文</summary>
              <pre className="action-original">{item.submittedText}</pre>
            </details>
            {onDiscussAction && (
              <button
                onClick={() =>
                  void onDiscussAction(item.actionId).catch((cause: unknown) =>
                    onError(
                      cause instanceof Error ? cause.message : '讨论打开失败',
                    ),
                  )
                }
              >
                讨论这份政策
              </button>
            )}
          </div>
        </article>
      ))}
      {!data.publicReport && !data.actions.length && (
        <p className="muted">本回合没有对你公开的结果。</p>
      )}
    </>
  );
}
