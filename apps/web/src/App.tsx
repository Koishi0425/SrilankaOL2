import { useCallback, useEffect, useState } from 'react';

import type { HealthResponse } from '@srilanka/contracts';

import { fetchHealth } from './api.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; health: HealthResponse }
  | { kind: 'error'; message: string };

function StatusPill({ status }: { status: 'up' | 'down' }) {
  return (
    <span className={`status status--${status}`}>
      {status === 'up' ? '正常' : '不可用'}
    </span>
  );
}

export function App() {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  const load = useCallback(async (signal?: AbortSignal) => {
    setState({ kind: 'loading' });
    try {
      const health = await fetchHealth(signal);
      setState({ kind: 'ready', health });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      setState({
        kind: 'error',
        message: error instanceof Error ? error.message : '未知错误',
      });
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  return (
    <main>
      <header className="hero">
        <p className="eyebrow">SRILANKA ONLINE · M0</p>
        <h1>世界运行基线</h1>
        <p className="lede">
          主持人驱动的异步战略世界，正从可靠的工程边界开始构建。
        </p>
      </header>

      <section className="panel" aria-live="polite">
        <div className="panel__heading">
          <div>
            <p className="eyebrow">SYSTEM READINESS</p>
            <h2>服务状态</h2>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={state.kind === 'loading'}
          >
            重新检查
          </button>
        </div>

        {state.kind === 'loading' && (
          <p className="message">正在检查 API 与基础依赖…</p>
        )}
        {state.kind === 'error' && (
          <div className="message message--error">
            <strong>无法连接后端</strong>
            <span>{state.message}</span>
          </div>
        )}
        {state.kind === 'ready' && (
          <>
            <div className="service-grid">
              <article>
                <span>API</span>
                <StatusPill
                  status={state.health.data.status === 'ok' ? 'up' : 'down'}
                />
              </article>
              <article>
                <span>PostgreSQL</span>
                <StatusPill status={state.health.data.dependencies.database} />
              </article>
              <article>
                <span>Redis</span>
                <StatusPill status={state.health.data.dependencies.redis} />
              </article>
            </div>
            <p className="request-id">追踪 ID：{state.health.meta.requestId}</p>
          </>
        )}
      </section>

      <footer>M0 工程基线 · 下一阶段：游戏与身份基础</footer>
    </main>
  );
}
