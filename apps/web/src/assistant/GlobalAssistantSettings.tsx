import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { GlobalAssistantSettings as Settings } from '@srilanka/contracts';
import {
  fetchGlobalAssistantSettings,
  saveGlobalAssistantSettings,
  testGlobalAssistantConnection,
} from '../api.js';

export function GlobalAssistantSettings({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current;
    if (element?.showModal) element.showModal();
    else element?.setAttribute('open', '');
    return () => element?.close?.();
  }, []);
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const dirty =
    JSON.stringify(saved) !== JSON.stringify(draft) || !!apiKey.trim();

  async function load() {
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const data = await fetchGlobalAssistantSettings();
      setSaved(data);
      setDraft(data);
      setApiKey('');
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : '读取全局 AI 设置失败。',
      );
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !saved || busy) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const data = await saveGlobalAssistantSettings({
        expectedRevision: saved.revision,
        enabled: draft.enabled,
        provider: draft.provider,
        baseUrl: draft.baseUrl,
        model: draft.model,
        jsonMode: draft.jsonMode,
        disableThinking: draft.disableThinking,
        timeoutMs: draft.timeoutMs,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
      });
      setSaved(data);
      setDraft(data);
      setApiKey('');
      window.dispatchEvent(new Event('srilanka-assistant-settings-changed'));
      setMessage(
        data.enabled
          ? '已保存，全站玩家立即共用此 AI 服务，无需逐局开启或重启服务器。'
          : '已保存，全站 AI 服务已停用。',
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败。');
    } finally {
      setBusy(false);
    }
  }
  async function test() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const result = await testGlobalAssistantConnection();
      setMessage(
        `连接成功：${result.provider} · ${result.model}，响应 ${(result.latencyMs / 1000).toFixed(1)} 秒。请求与结构化输出均已验证。`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接测试失败。');
    } finally {
      setBusy(false);
    }
  }
  function field<K extends keyof Settings>(key: K, value: Settings[K]) {
    setDraft((current) => (current ? { ...current, [key]: value } : current));
    setMessage('');
  }
  return (
    <dialog
      ref={dialog}
      className="global-assistant-settings"
      aria-label="全局 AI 设置"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <header className="assistant-settings-heading">
        <h2>全局 AI 设置</h2>
        <button type="button" disabled={busy} onClick={onClose}>
          关闭设置
        </button>
      </header>
      <p>
        仅系统管理员可修改。保存并启用后，所有游戏中的玩家共用此服务；每次调用仍只发送该玩家有权查看的资料。
      </p>
      {loading && <p>正在读取配置…</p>}
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {message && (
        <p role="status" className="save-message">
          {message}
        </p>
      )}
      {draft && (
        <form onSubmit={(event) => void save(event)}>
          {draft.source === 'Environment' && (
            <p className="muted">
              尚未保存网页全局配置，当前仅沿用服务器环境变量。点击保存后，将统一应用到所有游戏。
            </p>
          )}
          <fieldset disabled={busy || loading}>
            <label className="assistant-checkbox">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(event) => field('enabled', event.target.checked)}
              />
              启用全站 AI 服务
            </label>
            <label>
              服务类型
              <select
                value={draft.provider}
                onChange={(event) => {
                  const provider = event.target.value as Settings['provider'];
                  setDraft((current) =>
                    current
                      ? {
                          ...current,
                          provider,
                          baseUrl:
                            provider === 'deepseek'
                              ? 'https://api.deepseek.com'
                              : provider === 'glm'
                                ? 'https://open.bigmodel.cn/api/paas/v4'
                                : '',
                          disableThinking: provider !== 'compatible',
                        }
                      : current,
                  );
                  setApiKey('');
                  setMessage('');
                }}
              >
                <option value="compatible">OpenAI 兼容服务 / 自定义地址</option>
                <option value="deepseek">DeepSeek</option>
                <option value="glm">GLM</option>
              </select>
            </label>
            <label>
              AI 调用地址
              <input
                type="url"
                required
                value={draft.baseUrl}
                maxLength={2048}
                placeholder="https://example.com/v1"
                onChange={(event) => field('baseUrl', event.target.value)}
              />
            </label>
            <p className="muted">
              可填写服务基础地址或完整的 /chat/completions
              地址，不要在地址中放入密钥。
            </p>
            <label>
              API Key
              <input
                type="password"
                autoComplete="off"
                value={apiKey}
                maxLength={8192}
                required={!draft.hasApiKey}
                placeholder={
                  draft.hasApiKey
                    ? '已配置，留空保留现有密钥'
                    : '填写服务商提供的 API Key'
                }
                onChange={(event) => {
                  setApiKey(event.target.value);
                  setMessage('');
                }}
              />
            </label>
            <p className="muted">
              密钥保存后不回显，普通玩家无法读取。更换服务地址或类型时需重新填写密钥。
            </p>
            {draft.hasApiKey && !draft.configured && (
              <p className="form-error">
                现有配置尚不可用；若加密密钥文件遗失，请重新填写 API Key。
              </p>
            )}
            <label>
              模型名称
              <input
                required
                value={draft.model}
                maxLength={160}
                placeholder="填写服务商控制台中的模型标识"
                onChange={(event) => field('model', event.target.value)}
              />
            </label>
            <details>
              <summary>兼容选项</summary>
              <label className="assistant-checkbox">
                <input
                  type="checkbox"
                  checked={draft.jsonMode}
                  onChange={(event) => field('jsonMode', event.target.checked)}
                />
                请求 JSON 输出模式
              </label>
              <label className="assistant-checkbox">
                <input
                  type="checkbox"
                  checked={draft.disableThinking}
                  onChange={(event) =>
                    field('disableThinking', event.target.checked)
                  }
                />
                关闭供应商思考模式（仅 DeepSeek / GLM）
              </label>
              <label>
                请求超时（秒）
                <input
                  type="number"
                  min={1}
                  max={120}
                  step={1}
                  value={draft.timeoutMs / 1000}
                  onChange={(event) =>
                    field('timeoutMs', Number(event.target.value) * 1000)
                  }
                />
              </label>
              <p className="muted">
                兼容端点不支持 JSON
                模式时可关闭此选项，返回内容仍需通过格式和来源校验。
              </p>
            </details>
            <div className="assistant-controls">
              <button type="submit">{busy ? '处理中…' : '保存全局设置'}</button>
              <button
                type="button"
                disabled={busy || dirty || !saved?.configured}
                onClick={() => void test()}
              >
                测试已保存的连接
              </button>
              <button type="button" onClick={() => void load()}>
                重新读取配置
              </button>
            </div>
            {dirty && (
              <p className="muted">有未保存的修改，请先保存再测试连接。</p>
            )}
          </fieldset>
        </form>
      )}
      {!draft && !loading && (
        <button type="button" onClick={() => void load()}>
          重新读取配置
        </button>
      )}
    </dialog>
  );
}
