import { useEffect, useRef, useState } from 'react';
import type {
  AssistantInput,
  AssistantResult,
  AssistantStatus,
} from '@srilanka/contracts';
import {
  configureAssistant,
  fetchAssistantStatus,
  generateAssistantResult,
} from '../api.js';
import { resourceNames, signedAmount } from '../countries/resource-labels.js';

export function AssistantSettings({ gameId }: { gameId: string }) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function load() {
    setOpen(true);
    setBusy(true);
    setError('');
    try {
      setStatus(await fetchAssistantStatus(gameId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '读取失败');
    } finally {
      setBusy(false);
    }
  }
  async function toggle() {
    if (!status) return;
    setBusy(true);
    setError('');
    try {
      setStatus(
        await configureAssistant(gameId, !status.enabled, status.enabled),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '设置失败');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="assistant-settings">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void load())}
      >
        模型辅助设置
      </button>
      {open && (
        <div className="assistant-body">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {status && (
            <>
              <p>
                结算速览与反馈起草 · {status.provider} ·{' '}
                {status.enabled ? '本局已开启' : '本局未开启'}
              </p>
              <p>
                点击生成时，相关文字会发送至所配置的模型服务。玩家仅发送其可见的已发布结果。
              </p>
              {!status.configured && (
                <p>
                  模型服务尚未配置，请维护者按项目说明设置服务端密钥和模型名称。
                </p>
              )}
              {status.canManage && (
                <button
                  type="button"
                  disabled={busy || (!status.configured && !status.enabled)}
                  onClick={() => void toggle()}
                >
                  {status.enabled ? '关闭本局辅助' : '开启本局辅助'}
                </button>
              )}
            </>
          )}
          <button type="button" disabled={busy} onClick={() => void load()}>
            {busy ? '读取中…' : '重新读取'}
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  gameId: string;
  input: Omit<AssistantInput, 'length' | 'ruling'>;
  /** Changes to unsaved feedback must invalidate adoption, too. */
  contextKey: string;
  disabled?: boolean;
  disabledReason?: string;
  onAdopt?: (text: string) => void;
}

export function AssistantPanel({
  gameId,
  input,
  contextKey,
  disabled,
  disabledReason,
  onAdopt,
}: Props) {
  const feedback = input.purpose === 'Feedback';
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [length, setLength] = useState<AssistantInput['length']>('Normal');
  const [ruling, setRuling] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [result, setResult] = useState<{
    value: AssistantResult;
    basis: string;
  } | null>(null);
  const pending = useRef(false);
  const generation = useRef(0);
  const controller = useRef<AbortController | null>(null);
  const basis = JSON.stringify([gameId, input, contextKey, ruling, length]);
  const stale = !!result && result.basis !== basis;
  useEffect(
    () => () => {
      generation.current += 1;
      controller.current?.abort();
    },
    [],
  );

  async function load() {
    setOpen(true);
    setError('');
    try {
      setStatus(await fetchAssistantStatus(gameId));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '辅助读取失败');
    }
  }
  async function generate() {
    if (pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    setError('');
    setMessage('');
    setResult(null);
    const current = ++generation.current;
    controller.current = new AbortController();
    try {
      const value = await generateAssistantResult(
        gameId,
        { ...input, length, ...(feedback ? { ruling } : {}) },
        controller.current.signal,
      );
      if (generation.current === current) setResult({ value, basis });
    } catch (cause) {
      if (generation.current === current)
        setError(
          cause instanceof Error ? cause.message : '生成失败，请稍后重试',
        );
    } finally {
      if (generation.current === current) {
        setBusy(false);
        pending.current = false;
      }
    }
  }

  return (
    <section
      className="assistant-panel"
      aria-label={feedback ? '反馈起草' : '结算速览'}
    >
      <button
        type="button"
        aria-expanded={open}
        onClick={() => (open ? setOpen(false) : void load())}
      >
        {feedback ? '起草反馈' : '结算速览'}
      </button>
      {open && (
        <div className="assistant-body">
          {error && (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
          {!status ? (
            <button type="button" onClick={() => void load()}>
              读取辅助状态
            </button>
          ) : !status.enabled || !status.configured ? (
            <p>
              本局暂未启用模型辅助。
              <button type="button" onClick={() => void load()}>
                重新读取
              </button>
            </p>
          ) : (
            <>
              <p className="muted">
                {feedback
                  ? '按主持人裁定和已保存计划起草，填入后仍需保存。'
                  : '归纳你可见的已发布结果，可展开原文核对。'}
                相关文字将发送至{status.provider}。
              </p>
              {feedback && (
                <label>
                  主持人已定结果
                  <textarea
                    rows={3}
                    maxLength={4000}
                    value={ruling}
                    disabled={busy}
                    placeholder="写清成功或失败、代价和发生的事件。"
                    onChange={(event) => setRuling(event.target.value)}
                  />
                </label>
              )}
              <div className="assistant-controls">
                <label>
                  篇幅
                  <select
                    value={length}
                    disabled={busy}
                    onChange={(event) =>
                      setLength(event.target.value as AssistantInput['length'])
                    }
                  >
                    <option value="Brief">简短</option>
                    <option value="Normal">适中</option>
                    <option value="Detailed">详细</option>
                  </select>
                </label>
                <button
                  type="button"
                  disabled={busy || disabled || (feedback && !ruling.trim())}
                  onClick={() => void generate()}
                >
                  {busy
                    ? '生成中…'
                    : result
                      ? '重新生成'
                      : feedback
                        ? '生成反馈草稿'
                        : '生成速览'}
                </button>
              </div>
              {disabled && disabledReason && (
                <p className="muted">{disabledReason}</p>
              )}
              {result && (
                <div className="assistant-result" aria-live="polite">
                  {stale && !message && (
                    <p className="form-error">
                      资料或输入已变化，请重新生成。此内容仅供核对。
                    </p>
                  )}
                  <p>{result.value.answer.overview}</p>
                  {!!result.value.resourceTotals.length && (
                    <table>
                      <caption>本回合已入账收支（含更正，由账目汇总）</caption>
                      <thead>
                        <tr>
                          <th>国家</th>
                          <th>资源</th>
                          <th>净变化</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.value.resourceTotals.map((item) => (
                          <tr key={`${item.countryName}:${item.resource}`}>
                            <td>{item.countryName}</td>
                            <td>{resourceNames[item.resource]}</td>
                            <td>{signedAmount(item.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {!!result.value.answer.highlights.length && (
                    <ul>
                      {result.value.answer.highlights.map((item, index) => (
                        <li key={index}>
                          {item.text}
                          <span className="assistant-source-label">
                            {item.sourceIds
                              .map(
                                (id) =>
                                  result.value.sources.find(
                                    (source) => source.id === id,
                                  )?.label,
                              )
                              .join('；')}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {!!result.value.answer.notices.length && (
                    <div>
                      <strong>资料说明</strong>
                      <ul>
                        {result.value.answer.notices.map((notice, index) => (
                          <li key={index}>{notice}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {result.value.answer.draft && (
                    <>
                      <label>
                        反馈草稿
                        <textarea
                          rows={8}
                          readOnly
                          value={result.value.answer.draft}
                        />
                      </label>
                      {onAdopt && (
                        <button
                          type="button"
                          disabled={disabled || stale || !!message}
                          onClick={() => {
                            onAdopt(result.value.answer.draft!);
                            setMessage('已填入反馈，尚未保存。');
                          }}
                        >
                          填入反馈
                        </button>
                      )}
                    </>
                  )}
                  <details>
                    <summary>核对原文</summary>
                    {result.value.sources.map((source) => (
                      <div key={source.id}>
                        <h5>{source.label}</h5>
                        <p className="rules-text">{source.text}</p>
                      </div>
                    ))}
                  </details>
                  {message && (
                    <p className="save-message" role="status">
                      {message}
                    </p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
