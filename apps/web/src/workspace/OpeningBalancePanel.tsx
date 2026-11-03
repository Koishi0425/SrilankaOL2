import { useEffect, useRef, useState } from 'react';
import type { EconomicRules, EconomicSetupPreview } from '@srilanka/contracts';
import { previewEconomicSetup, saveOpeningEconomy } from '../api.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import {
  money,
  openingOutlook,
  openingReferenceRules,
  openingUnitRules,
  openingRulesKey,
} from './opening-economy.js';

const fields = [
  ['taxCoefficient', '税收系数'],
  ['productionCoefficient', '生产系数'],
  ['manpowerCoefficient', '人力系数'],
  ['armyMaintenancePer100', '每百人军队维护费'],
  ['administrationCost', '每国每季行政费'],
  ['tradeCoefficient', '贸易系数'],
] as const;
type RuleValues = Record<(typeof fields)[number][0], string>;
type BalanceValues = Record<string, { treasury: string; manpower: string }>;
const ruleValues = (rules: EconomicRules) =>
  Object.fromEntries(
    fields.map(([key]) => [key, String(rules[key] ?? 0)]),
  ) as RuleValues;
function parseRules(
  enabled: boolean,
  values: RuleValues,
): EconomicRules | null {
  const rules = { enabled } as EconomicRules;
  for (const [key] of fields) {
    const value = Number(values[key]);
    if (
      !values[key].trim() ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > 1e6 ||
      Math.abs(value * 100 - Math.round(value * 100)) > 0.0001
    )
      return null;
    rules[key] = value;
  }
  return rules;
}

export function OpeningBalancePanel({
  gameId,
  active,
  disabled,
  onDirtyChange,
  onSaved,
}: {
  gameId: string;
  active: boolean;
  disabled: boolean;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [baseline, setBaseline] = useState<EconomicSetupPreview | null>(null);
  const [preview, setPreview] = useState<EconomicSetupPreview | null>(null);
  const [enabled, setEnabled] = useState(false);
  const [seedBlankProvinces, setSeedBlankProvinces] = useState(false);
  const [previewSeeds, setPreviewSeeds] = useState(false);
  const [values, setValues] = useState<RuleValues>(() =>
    ruleValues({ ...openingUnitRules, enabled: false }),
  );
  const [balances, setBalances] = useState<BalanceValues>({});
  const [targetIncome, setTargetIncome] = useState('100');
  const [bulkTreasury, setBulkTreasury] = useState('400');
  const [bulkManpower, setBulkManpower] = useState('1000');
  const [reason, setReason] = useState('开局资源与经济校准');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const pending = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const rules = parseRules(enabled, values);
  const dirty =
    !!baseline &&
    (openingRulesKey(baseline.rules) !== openingRulesKey(rules) ||
      (seedBlankProvinces && baseline.unconfiguredProvinceCount > 0) ||
      baseline.countries.some(
        (country) =>
          !balances[country.id]?.treasury.trim() ||
          !balances[country.id]?.manpower.trim() ||
          Number(balances[country.id]?.treasury) !== country.treasury ||
          Number(balances[country.id]?.manpower) !== country.manpower,
      ));
  const currentPreview =
    !!rules &&
    !!preview &&
    previewSeeds === seedBlankProvinces &&
    openingRulesKey(preview.rules) === openingRulesKey(rules);
  const conflict =
    !!baseline &&
    !!preview &&
    baseline.preparationRevision !== preview.preparationRevision;

  function accept(data: EconomicSetupPreview) {
    setBaseline(data);
    setPreview(data);
    setEnabled(data.rules.enabled);
    setSeedBlankProvinces(false);
    setPreviewSeeds(false);
    setValues(ruleValues(data.rules));
    setBalances(
      Object.fromEntries(
        data.countries.map((country) => [
          country.id,
          {
            treasury: String(country.treasury),
            manpower: String(country.manpower),
          },
        ]),
      ),
    );
  }
  useEffect(() => {
    onDirtyChange(dirty);
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => {
    if (!active || !open || baseline) return;
    const request = new AbortController();
    controller.current = request;
    setError('');
    void previewEconomicSetup(gameId, undefined, request.signal)
      .then((data) => {
        if (!request.signal.aborted) accept(data);
      })
      .catch((cause: unknown) => {
        if (!request.signal.aborted)
          setError(
            cause instanceof Error ? cause.message : '开局试算读取失败。',
          );
      });
    return () => request.abort();
  }, [active, open, gameId, baseline, reload]);

  async function calculate(reference = false) {
    if (pending.current || !baseline) return;
    const target = Number(targetIncome);
    if (
      reference &&
      (!targetIncome.trim() ||
        !Number.isFinite(target) ||
        target < 1 ||
        target > 1e6)
    ) {
      setError('目标平均季收入应为 1–1000000。');
      return;
    }
    if (!reference && !rules) {
      setError('经济系数应为非负数，最多两位小数。');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    const request = new AbortController();
    controller.current?.abort();
    controller.current = request;
    try {
      let nextRules = rules!;
      const seeds = reference || seedBlankProvinces;
      if (reference) {
        setSeedBlankProvinces(true);
        const unit = await previewEconomicSetup(
          gameId,
          openingUnitRules,
          request.signal,
          true,
        );
        nextRules = openingReferenceRules(unit, target);
        nextRules.tradeCoefficient =
          rules?.tradeCoefficient ?? baseline.rules.tradeCoefficient ?? 0;
        setEnabled(true);
        setValues(ruleValues(nextRules));
      }
      const data = await previewEconomicSetup(
        gameId,
        nextRules,
        request.signal,
        seeds,
      );
      if (request.signal.aborted) return;
      setPreview(data);
      setPreviewSeeds(seeds);
      if (reference)
        setNotice(
          '已将参考经济系数放入草稿，尚未保存；各国初始资源保留，可用下方批量填写调整。',
        );
    } catch (cause) {
      if (!request.signal.aborted)
        setError(
          cause instanceof Error ? cause.message : '试算失败，输入已保留。',
        );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  function fillBalances() {
    const treasury = Number(bulkTreasury),
      manpower = Number(bulkManpower);
    if (
      !bulkTreasury.trim() ||
      !bulkManpower.trim() ||
      !Number.isFinite(treasury) ||
      Math.abs(treasury) > 1e9 ||
      money(treasury) !== treasury ||
      !Number.isInteger(manpower) ||
      manpower < 0 ||
      manpower > 2147483647
    ) {
      setError('请填写有效的国库和非负整数人力。');
      return;
    }
    setBalances(
      Object.fromEntries(
        baseline!.countries.map((country) => [
          country.id,
          { treasury: bulkTreasury, manpower: bulkManpower },
        ]),
      ),
    );
    setNotice('已统一填入各国资源草稿，可逐国微调，尚未保存。');
    setError('');
  }
  async function save() {
    if (!baseline || !rules || pending.current || conflict || !currentPreview)
      return;
    const countries = baseline.countries.map((country) => ({
      id: country.id,
      treasury: Number(balances[country.id]?.treasury),
      manpower: Number(balances[country.id]?.manpower),
    }));
    if (
      countries.some(
        (country) =>
          !balances[country.id]?.treasury.trim() ||
          !balances[country.id]?.manpower.trim() ||
          !Number.isFinite(country.treasury) ||
          Math.abs(country.treasury) > 1e9 ||
          money(country.treasury) !== country.treasury ||
          !Number.isInteger(country.manpower) ||
          country.manpower < 0 ||
          country.manpower > 2147483647,
      ) ||
      !reason.trim()
    ) {
      setError('请核对各国资源，并填写修改说明。');
      return;
    }
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      accept(
        await saveOpeningEconomy(gameId, {
          quarterId: baseline.quarterId,
          expectedPreparationRevision: baseline.preparationRevision,
          rules,
          countries,
          reason: reason.trim(),
          ...(seedBlankProvinces ? { seedBlankProvinces: true } : {}),
        }),
      );
      setNotice('已一次保存各国初始资源和经济规则。');
      onSaved();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '保存失败，全部输入已保留。',
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <section className="opening-balance-panel" aria-label="开局资源与平衡试算">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        开局资源与平衡试算
      </button>
      {open && (
        <div className="opening-balance-body">
          <p>
            参考方案只填入草稿，保存前可试算和逐国调整。试算复用正式经济公式。
          </p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {!baseline && !error && <LoadingSkeleton label="正在读取开局经济…" />}
          {baseline && (
            <fieldset disabled={busy || disabled}>
              <div className="opening-reference-controls">
                <label>
                  目标平均季收入
                  <input
                    type="number"
                    min="1"
                    max="1000000"
                    value={targetIncome}
                    onChange={(e) => setTargetIncome(e.target.value)}
                  />
                </label>
                <button type="button" onClick={() => void calculate(true)}>
                  生成参考经济方案
                </button>
              </div>
              <details>
                <summary>参考方案如何确定数值</summary>
                <p className="muted">
                  税收与生产按目标平均收入校准；现有军费目标约占目标总收入
                  30%，行政费约 10%。
                  贸易系数保留原值，贸易收入另外计算。无收入基础时，参考系数不能凭空产生收入。
                </p>
              </details>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={seedBlankProvinces}
                  onChange={(event) =>
                    setSeedBlankProvinces(event.target.checked)
                  }
                />
                为空白省份采用参考产出：税收 10、生产 10、人力 100
              </label>
              <p>
                保存时将补齐{' '}
                {seedBlankProvinces
                  ? (preview?.unconfiguredProvinceCount ??
                    baseline.unconfiguredProvinceCount)
                  : 0}{' '}
                个未设置产出的省份；已调整过的省份保留原值。
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />
                启用每季自动经济
              </label>
              <details>
                <summary>经济系数微调</summary>
                <div className="resource-form">
                  {fields.map(([key, label]) => (
                    <label key={key}>
                      {label}
                      <input
                        type="number"
                        min="0"
                        max="1000000"
                        step="0.01"
                        value={values[key]}
                        onChange={(e) =>
                          setValues({ ...values, [key]: e.target.value })
                        }
                      />
                    </label>
                  ))}
                </div>
              </details>
              <button type="button" onClick={() => void calculate()}>
                更新收支试算
              </button>
              {!currentPreview && (
                <p role="status">系数有修改，请更新收支试算后核对并保存。</p>
              )}
              {conflict && (
                <p role="alert">
                  其他窗口已修改准备内容。请先保留当前输入，再重新读取并核对；不会用新版本号覆盖旧草稿。
                </p>
              )}
              <div className="opening-reference-controls">
                <label>
                  统一初始国库
                  <input
                    type="number"
                    step="0.01"
                    value={bulkTreasury}
                    onChange={(e) => setBulkTreasury(e.target.value)}
                  />
                </label>
                <label>
                  统一初始人力
                  <input
                    type="number"
                    min="0"
                    step="1"
                    value={bulkManpower}
                    onChange={(e) => setBulkManpower(e.target.value)}
                  />
                </label>
                <button type="button" onClick={fillBalances}>
                  填入各国资源草稿
                </button>
              </div>
              <p className="muted">
                400 国库、1000
                人力是可调整的试跑示例；统一填写会替换本页各国资源草稿。
              </p>
              <div className="table-scroll">
                <table className="opening-outlook-table">
                  <caption>各国开局预算与每季静态试算</caption>
                  <thead>
                    <tr>
                      <th>国家</th>
                      <th>初始国库</th>
                      <th>初始人力</th>
                      <th>季收入</th>
                      <th>军费／行政费</th>
                      <th>季净额</th>
                      <th>人力恢复</th>
                      <th>4 季后国库</th>
                      <th>核对</th>
                    </tr>
                  </thead>
                  <tbody>
                    {baseline.countries.map((country) => {
                      const current = preview?.countries.find(
                        (row) => row.id === country.id,
                      );
                      const balance = balances[country.id]!;
                      const validTreasury =
                        !!balance.treasury.trim() &&
                        Number.isFinite(Number(balance.treasury));
                      const row =
                        current && currentPreview
                          ? openingOutlook(
                              current,
                              validTreasury
                                ? Number(balance.treasury)
                                : country.treasury,
                            )
                          : null;
                      return (
                        <tr key={country.id}>
                          <th scope="row">{country.name}</th>
                          <td>
                            <input
                              aria-label={`${country.name} 初始国库`}
                              type="number"
                              step="0.01"
                              value={balance.treasury}
                              onChange={(e) =>
                                setBalances({
                                  ...balances,
                                  [country.id]: {
                                    ...balance,
                                    treasury: e.target.value,
                                  },
                                })
                              }
                            />
                          </td>
                          <td>
                            <input
                              aria-label={`${country.name} 初始人力`}
                              type="number"
                              min="0"
                              step="1"
                              value={balance.manpower}
                              onChange={(e) =>
                                setBalances({
                                  ...balances,
                                  [country.id]: {
                                    ...balance,
                                    manpower: e.target.value,
                                  },
                                })
                              }
                            />
                          </td>
                          <td>{row?.income ?? '待试算'}</td>
                          <td>
                            {row
                              ? `${row.maintenance}／${row.administration}`
                              : '待试算'}
                          </td>
                          <td>{row?.net ?? '待试算'}</td>
                          <td>{row?.manpowerGrowth ?? '待试算'}</td>
                          <td>
                            {row && validTreasury
                              ? row.afterFourQuarters
                              : '待填写'}
                          </td>
                          <td>
                            {!enabled ? (
                              '自动经济关闭'
                            ) : !row ? (
                              '待试算'
                            ) : (
                              <>
                                {row.income === 0 && (
                                  <p>
                                    季收入为 0，检查省份产出、法定归属与控制方。
                                  </p>
                                )}
                                {row.net < 0 && (
                                  <p>
                                    {validTreasury
                                      ? `持续亏损，国库约可支撑 ${row.runway} 个完整季度。`
                                      : '持续亏损，填写初始国库后可估算支撑季度。'}
                                  </p>
                                )}
                                {row.income > 0 &&
                                  row.maintenance > row.income * 0.5 && (
                                    <p>军费超过收入一半。</p>
                                  )}
                                {row.income > 0 &&
                                  row.net >= 0 &&
                                  row.maintenance <= row.income * 0.5 &&
                                  '当前静态收支非负'}
                              </>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {enabled &&
                currentPreview &&
                preview &&
                preview.countries.length > 1 && (
                  <p>
                    各国季收入范围：
                    {Math.min(
                      ...preview.countries.map(
                        (country) => openingOutlook(country).income,
                      ),
                    )}
                    ～
                    {Math.max(
                      ...preview.countries.map(
                        (country) => openingOutlook(country).income,
                      ),
                    )}
                    。
                    可据此核对预期的强弱差异；省份基础值、自治、领土控制和长期政策都会影响收入。
                  </p>
                )}
              <p className="muted">
                4
                季预测假设领土、部队、系数和当前修正保持不变；新增政策、征募支出、战争损失与修正到期需另行核对，不代表平衡保证。
              </p>
              <label>
                修改说明
                <input
                  maxLength={2000}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!dirty || !currentPreview || conflict}
                onClick={() => void save()}
              >
                保存各国资源与经济规则
              </button>
            </fieldset>
          )}
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => {
              setBaseline(null);
              setPreview(null);
              setError('');
              setNotice('');
              setReload((value) => value + 1);
            }}
          >
            {dirty ? '放弃本页修改并重新读取' : '重新读取开局经济'}
          </button>
        </div>
      )}
    </section>
  );
}
