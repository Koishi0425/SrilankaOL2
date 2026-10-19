import { useEffect, useState } from 'react';
import type {
  ActionSummary,
  GameSummary,
  GameDetails,
  NationalStatus,
  QuarterSummary,
} from '@srilanka/contracts';
import { fetchActions, fetchNationalStatus, fetchGame } from '../api.js';
import { statusNames } from '../actions/ActionCenter.js';

export function useWorkspaceOverview(game: GameSummary, active: boolean) {
  const [national, setNational] = useState<NationalStatus | null>(null),
    [actions, setActions] = useState<ActionSummary[]>([]),
    [loadedQuarter, setLoadedQuarter] = useState(''),
    [nationalError, setNationalError] = useState(''),
    [actionError, setActionError] = useState(''),
    [reload, setReload] = useState(0);
  const host = ['Host', 'Administrator'].includes(game.role);
  const [quarter, setQuarter] = useState<QuarterSummary | null>(null);
  const [currentGame, setCurrentGame] = useState<GameDetails | null>(null);
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    let reading = false;
    async function read() {
      if (reading || document.hidden) return;
      reading = true;
      const results = await Promise.allSettled([
        game.role === 'Observer'
          ? Promise.resolve(null)
          : fetchNationalStatus(game.id, controller.signal),
        game.role === 'Observer'
          ? Promise.resolve([])
          : fetchActions(game.id, host),
        fetchGame(game.id),
      ]);
      if (!controller.signal.aborted) {
        const [n, a, g] = results;
        const current =
          g.status === 'fulfilled'
            ? g.value.currentQuarter
            : game.currentQuarter;
        if (g.status === 'fulfilled') {
          setQuarter(current);
          setCurrentGame(g.value);
        }
        if (n.status === 'fulfilled') {
          setNational(n.value);
          setNationalError('');
        } else setNationalError('国家资料读取失败');
        if (a.status === 'fulfilled') {
          setActions(a.value.filter((i) => i.quarterId === current.id));
          setLoadedQuarter(current.id);
          setActionError('');
        } else setActionError('政策列表读取失败');
      }
      reading = false;
    }
    void read();
    const timer = window.setInterval(() => void read(), 5000);
    document.addEventListener('visibilitychange', read);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', read);
    };
  }, [
    game.id,
    game.role,
    game.currentQuarter.id,
    game.currentQuarter.state,
    game.currentQuarter.currentWorldVersion,
    host,
    active,
    reload,
  ]);
  return {
    national,
    currentGame,
    quarter,
    actions: loadedQuarter === game.currentQuarter.id ? actions : [],
    nationalError,
    actionError,
    refresh: () => setReload((v) => v + 1),
  };
}
export function TurnOverview({
  game,
  actions,
  country,
  unread,
  error,
  onOpenAction,
  onOpenMilitary,
  onOpenMessages,
  onOpenSettlement,
  onRetry,
  onClose,
}: {
  game: GameSummary;
  actions: ActionSummary[];
  country?: NationalStatus['countries'][number];
  unread: number;
  error: string;
  onOpenAction: (id: string) => void;
  onOpenMilitary: () => void;
  onOpenMessages: () => void;
  onOpenSettlement: () => void;
  onRetry: () => void;
  onClose: () => void;
}) {
  const pending = actions.filter(
    (a) =>
      !['Completed', 'Rejected', 'Withdrawn', 'Invalidated'].includes(a.status),
  );
  return (
    <aside id="turn-overview" className="turn-overview" aria-label="回合事务">
      <header className="workspace-drawer__heading">
        <h3>回合事务</h3>
        <button aria-label="收起回合事务" onClick={onClose}>
          收起
        </button>
      </header>
      <section>
        <h3>本季政策{pending.length > 0 && <span>{pending.length}</span>}</h3>
        {error ? (
          <p role="alert">
            {error}
            <button onClick={onRetry}>重试</button>
          </p>
        ) : pending.length ? (
          <ul>
            {pending.map((a) => (
              <li key={a.id}>
                <button onClick={() => onOpenAction(a.id)}>
                  <strong>{a.title}</strong>
                  <span>
                    {['Host', 'Administrator'].includes(game.role)
                      ? `${a.countryName} · `
                      : ''}
                    {statusNames[a.status]}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">暂无待处理政策。</p>
        )}
        <button className="turn-link" onClick={onOpenSettlement}>
          {['Host', 'Administrator'].includes(game.role)
            ? '回合结算'
            : '查看回合结果'}
        </button>
      </section>
      <section>
        <h3>消息{unread > 0 && <span>{unread}</span>}</h3>
        <button className="turn-link" onClick={onOpenMessages}>
          {unread > 0 ? `${unread} 条未读消息` : '打开讨论'}
        </button>
      </section>
      {!!country?.armies.length && (
        <section>
          <h3>{country.name}军队</h3>
          <ul>
            {country.armies.map((a) => (
              <li key={a.id}>
                <button onClick={onOpenMilitary}>
                  <strong>{a.name}</strong>
                  <span>
                    {a.strength.toLocaleString('zh-CN')} 人 · {a.q}，{a.r}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </aside>
  );
}
