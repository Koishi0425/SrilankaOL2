import { type FormEvent, useEffect, useState } from 'react';

import type { GameRulesData, PlayerPerspective } from '@srilanka/contracts';

import { categories, categoryName } from '../actions/action-labels.js';
import { fetchGameRules, saveGameRules } from '../api.js';
import { AssistantSettings } from '../assistant/AssistantPanel.js';

export const perspectiveNames: Record<PlayerPerspective, string> = {
  CountryWill: '国家意志',
  Character: '具体角色',
  Flexible: '按剧本约定',
};

const nationalScenario: GameRulesData['scenario'] = {
  title: '诸国时代',
  playerPerspective: 'CountryWill',
  premise:
    '各国在同一片世界中发展、探索、交涉与争夺。玩家代表国家意志，可以通过君主、将领、使节等角色讲述国家的选择。具体年代、疆域、势力与开局关系由主持人设定。',
  commonRules:
    '每回合由主持人公布局势与行动指引，玩家集中提交政策。政策应说明目标、执行方法、投入与备用计划。\n行动是否可行、成本与结果由主持人结合世界情况和常识裁决；超出常规类别的创意仍可提出。\n所有人的政策收齐后，主持人统一审核，必要时要求补充，再进行结算与叙事反馈。\n探索可能发现事件、资源与道具；外交协议和战争结果由主持人确认。战争规则另行约定，野战与攻城可以采用不同规则。',
};

export function GameRulesPanel({
  gameId,
  rules,
  canManage,
  onSaved,
}: {
  gameId: string;
  rules: GameRulesData;
  canManage: boolean;
  onSaved: (rules: GameRulesData) => void;
}) {
  const [draft, setDraft] = useState(rules);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  useEffect(() => setDraft(rules), [rules]);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await saveGameRules(gameId, draft);
      onSaved(saved);
      setDraft(saved);
      setMessage('已保存。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '规则保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function reload() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const saved = await fetchGameRules(gameId);
      onSaved(saved);
      setDraft(saved);
      setMessage('已刷新。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '规则读取失败');
    } finally {
      setBusy(false);
    }
  }

  function scenarioField<K extends keyof GameRulesData['scenario']>(
    key: K,
    value: GameRulesData['scenario'][K],
  ) {
    setDraft((current) => ({
      ...current,
      scenario: { ...current.scenario, [key]: value },
    }));
    setMessage('');
  }

  function quarterField<K extends keyof GameRulesData['quarter']>(
    key: K,
    value: GameRulesData['quarter'][K],
  ) {
    setDraft((current) => ({
      ...current,
      quarter: { ...current.quarter, [key]: value },
    }));
    setMessage('');
  }

  const emptyScenario =
    !draft.scenario.title &&
    !draft.scenario.premise &&
    !draft.scenario.commonRules;
  const availableCategories = categories.filter(
    ([category]) =>
      !draft.quarter.suggestedLimits.some((item) => item.category === category),
  );

  return (
    <section className="rules-panel">
      <header className="center-heading">
        <h3>剧本与规则</h3>
      </header>
      {canManage && <AssistantSettings key={gameId} gameId={gameId} />}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="save-message" role="status">
          {message}
        </p>
      )}
      {canManage ? (
        <form className="rules-form" onSubmit={(event) => void save(event)}>
          <fieldset disabled={busy}>
            <legend>剧本设定</legend>
            {emptyScenario && (
              <button
                className="button"
                type="button"
                onClick={() => {
                  setDraft((current) => ({
                    ...current,
                    scenario: { ...nationalScenario },
                    quarter: {
                      ...current.quarter,
                      actionGuidelines:
                        current.quarter.actionGuidelines ||
                        '可提出探索、内政、外交和军事等政策，也可按剧情自由发挥。请交代涉及的地点、对象、目标与投入；各类行动额度由主持人按本回合局势决定。',
                    },
                  }));
                  setMessage('模板已填入，尚未保存。');
                }}
              >
                使用国家战略模板
              </button>
            )}
            <label>
              剧本名称
              <input
                maxLength={120}
                value={draft.scenario.title}
                onChange={(event) => scenarioField('title', event.target.value)}
              />
            </label>
            <label>
              玩家扮演主体
              <select
                value={draft.scenario.playerPerspective}
                onChange={(event) =>
                  scenarioField(
                    'playerPerspective',
                    event.target.value as PlayerPerspective,
                  )
                }
              >
                {Object.entries(perspectiveNames).map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            {draft.scenario.playerPerspective === 'Character' && (
              <p className="muted">角色行动归属所控制的国家。</p>
            )}
            <label>
              背景
              <textarea
                rows={3}
                maxLength={10_000}
                value={draft.scenario.premise}
                onChange={(event) =>
                  scenarioField('premise', event.target.value)
                }
              />
            </label>
            <label>
              共同规则
              <textarea
                rows={5}
                maxLength={20_000}
                value={draft.scenario.commonRules}
                onChange={(event) =>
                  scenarioField('commonRules', event.target.value)
                }
              />
            </label>
          </fieldset>
          <fieldset disabled={busy}>
            <legend>本回合指引</legend>
            <label>
              回合公告
              <textarea
                rows={3}
                maxLength={10_000}
                value={draft.quarter.briefing}
                onChange={(event) =>
                  quarterField('briefing', event.target.value)
                }
              />
            </label>
            <label>
              行动说明
              <textarea
                rows={3}
                maxLength={20_000}
                value={draft.quarter.actionGuidelines}
                onChange={(event) =>
                  quarterField('actionGuidelines', event.target.value)
                }
              />
            </label>
            <div className="rules-limits">
              <h4>每国行动建议额度</h4>
              <p className="muted">
                超额仍可提交，由主持人裁决。0 表示不建议，未添加表示不限。
              </p>
              {draft.quarter.suggestedLimits.map((item) => (
                <div className="rules-limit-row" key={item.category}>
                  <span>{categoryName(item.category)}</span>
                  <input
                    type="number"
                    aria-label={`${categoryName(item.category)}建议额度`}
                    min={0}
                    max={100}
                    required
                    value={Number.isNaN(item.limit) ? '' : item.limit}
                    onChange={(event) =>
                      quarterField(
                        'suggestedLimits',
                        draft.quarter.suggestedLimits.map((limit) =>
                          limit.category === item.category
                            ? { ...limit, limit: event.target.valueAsNumber }
                            : limit,
                        ),
                      )
                    }
                  />
                  <span>项 / 回合</span>
                  <button
                    className="button button--quiet"
                    type="button"
                    aria-label={`移除${categoryName(item.category)}额度`}
                    onClick={() =>
                      quarterField(
                        'suggestedLimits',
                        draft.quarter.suggestedLimits.filter(
                          (limit) => limit.category !== item.category,
                        ),
                      )
                    }
                  >
                    移除
                  </button>
                </div>
              ))}
              {availableCategories.length > 0 && (
                <label>
                  添加建议额度
                  <select
                    aria-label="添加建议额度"
                    value=""
                    onChange={(event) => {
                      const category = availableCategories.find(
                        ([value]) => value === event.target.value,
                      )?.[0];
                      if (category)
                        quarterField('suggestedLimits', [
                          ...draft.quarter.suggestedLimits,
                          { category, limit: 1 },
                        ]);
                    }}
                  >
                    <option value="">选择行动类别</option>
                    {availableCategories.map(([category, label]) => (
                      <option key={category} value={category}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
          </fieldset>
          <div className="rules-actions">
            <button
              className="button button--primary"
              type="submit"
              disabled={busy}
            >
              {busy ? '保存中…' : '保存'}
            </button>
            <button
              className="button"
              type="button"
              disabled={busy}
              onClick={() => void reload()}
            >
              放弃修改并刷新
            </button>
          </div>
        </form>
      ) : (
        <div className="rules-reading">
          <h4>{rules.scenario.title || '尚未命名剧本'}</h4>
          <p>
            玩家扮演主体：{perspectiveNames[rules.scenario.playerPerspective]}
          </p>
          {(
            [
              ['背景', rules.scenario.premise],
              ['共同规则', rules.scenario.commonRules],
              ['回合公告', rules.quarter.briefing],
              ['行动说明', rules.quarter.actionGuidelines],
            ] as const
          ).map(([title, content]) => (
            <div key={title}>
              <h4>{title}</h4>
              <p className="rules-text">{content || '未填写'}</p>
            </div>
          ))}
          <h4>每国行动建议额度</h4>
          {rules.quarter.suggestedLimits.length ? (
            <ul>
              {rules.quarter.suggestedLimits.map((item) => (
                <li key={item.category}>
                  {categoryName(item.category)}：{item.limit} 项 / 回合
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">不限</p>
          )}
          <button
            className="button"
            type="button"
            disabled={busy}
            onClick={() => void reload()}
          >
            刷新
          </button>
        </div>
      )}
    </section>
  );
}
