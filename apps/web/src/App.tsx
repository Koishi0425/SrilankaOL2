import { type FormEvent, useCallback, useEffect, useState } from 'react';

import type {
  CountrySummary,
  GameMemberSummary,
  GameSummary,
  HealthResponse,
  MeData,
} from '@srilanka/contracts';

import {
  ApiRequestError,
  addMember,
  assignCountry,
  createGame,
  fetchCountries,
  fetchHealth,
  fetchMembers,
  fetchMe,
  login,
  logout,
} from './api.js';

type SessionState =
  | { kind: 'loading' }
  | { kind: 'guest'; message?: string }
  | { kind: 'ready'; me: MeData }
  | { kind: 'error'; message: string };

const seasonNames: Record<GameSummary['currentQuarter']['season'], string> = {
  Spring: '春季',
  Summer: '夏季',
  Autumn: '秋季',
  Winter: '冬季',
};

function SystemStatus() {
  const [health, setHealth] = useState<HealthResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetchHealth(controller.signal)
      .then(setHealth)
      .catch(() => setHealth(null));
    return () => controller.abort();
  }, []);

  return (
    <span className={`system-status ${health ? 'system-status--up' : ''}`}>
      <span aria-hidden="true" />
      {health ? '系统正常' : '系统状态未知'}
    </span>
  );
}

function LoginPanel({
  message,
  onSuccess,
}: {
  message?: string;
  onSuccess: () => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(message ?? '');
  const [submitting, setSubmitting] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login(email, password);
      await onSuccess();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '登录失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="auth-card">
      <div>
        <p className="eyebrow">MEMBER ACCESS</p>
        <h2>进入你的世界</h2>
        <p className="muted">
          使用主持人创建的账号登录。首版暂不开放自主注册。
        </p>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          邮箱
          <input
            required
            type="email"
            autoComplete="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>
        <label>
          密码
          <input
            required
            minLength={8}
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button
          className="button button--primary"
          disabled={submitting}
          type="submit"
        >
          {submitting ? '正在验证…' : '登录'}
        </button>
      </form>
    </section>
  );
}

function GameCard({
  game,
  selected,
  onSelect,
}: {
  game: GameSummary;
  selected: boolean;
  onSelect: () => void;
}) {
  const quarter = game.currentQuarter;
  return (
    <article className="game-card">
      <div className="game-card__topline">
        <span className="tag">{game.role}</span>
        <span className="muted">{game.status}</span>
      </div>
      <h3>{game.name}</h3>
      <p>
        第 {quarter.gameYear} 年 · {seasonNames[quarter.season]}
      </p>
      <div className="game-card__footer">
        <span>{quarter.state}</span>
        <span>世界版本 {quarter.currentWorldVersion}</span>
      </div>
      <button className="button button--quiet" type="button" onClick={onSelect}>
        {selected ? '收起游戏' : '进入游戏'}
      </button>
    </article>
  );
}

function GameWorkspace({ game }: { game: GameSummary }) {
  const [members, setMembers] = useState<GameMemberSummary[]>([]);
  const [countries, setCountries] = useState<CountrySummary[]>([]);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<'Player' | 'Observer'>('Player');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const canManage = game.role === 'Host' || game.role === 'Administrator';

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const countryList = await fetchCountries(game.id);
      setCountries(countryList);
      if (canManage) setMembers(await fetchMembers(game.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '游戏上下文加载失败');
    } finally {
      setLoading(false);
    }
  }, [canManage, game.id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function submitMember(event: FormEvent) {
    event.preventDefault();
    setError('');
    try {
      await addMember(game.id, { email, role });
      setEmail('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '添加成员失败');
    }
  }

  async function changeCountry(memberId: string, countryId: string) {
    if (!countryId) return;
    setError('');
    try {
      await assignCountry(game.id, memberId, countryId);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '国家分配失败');
    }
  }

  return (
    <section className="workspace-card">
      <div className="workspace-card__heading">
        <div>
          <p className="eyebrow">CURRENT GAME</p>
          <h2>{game.name}</h2>
        </div>
        <div className="quarter-chip">
          第 {game.currentQuarter.gameYear} 年 ·{' '}
          {seasonNames[game.currentQuarter.season]}
          <small>{game.currentQuarter.state}</small>
        </div>
      </div>

      {loading && <p className="muted">正在读取游戏上下文…</p>}
      {error && <p className="form-error">{error}</p>}
      {!loading && (
        <div className="context-grid">
          <div>
            <h3>国家</h3>
            <div className="tag-list">
              {countries.map((country) => (
                <span className="tag" key={country.id}>
                  {country.name}
                </span>
              ))}
              {countries.length === 0 && (
                <span className="muted">暂无国家</span>
              )}
            </div>
          </div>

          {canManage && (
            <div>
              <h3>成员管理</h3>
              <form
                className="member-form"
                onSubmit={(event) => void submitMember(event)}
              >
                <input
                  required
                  aria-label="成员邮箱"
                  type="email"
                  placeholder="已存在用户的邮箱"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
                <select
                  value={role}
                  onChange={(event) =>
                    setRole(event.target.value as 'Player' | 'Observer')
                  }
                >
                  <option value="Player">玩家</option>
                  <option value="Observer">观察者</option>
                </select>
                <button className="button" type="submit">
                  添加
                </button>
              </form>
              <div className="member-list">
                {members.map((member) => (
                  <div className="member-row" key={member.id}>
                    <span>
                      <strong>{member.displayName}</strong>
                      <small>
                        {member.email} · {member.role}
                      </small>
                    </span>
                    {member.role === 'Player' ? (
                      <select
                        aria-label={`为 ${member.displayName} 分配国家`}
                        value={member.controlledCountryId ?? ''}
                        onChange={(event) =>
                          void changeCountry(member.id, event.target.value)
                        }
                      >
                        <option value="">未分配国家</option>
                        {countries.map((country) => (
                          <option key={country.id} value={country.id}>
                            {country.name}
                          </option>
                        ))}
                      </select>
                    ) : (
                      <span className="muted">
                        {member.controlledCountryName ?? '—'}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function Dashboard({
  me,
  refresh,
}: {
  me: MeData;
  refresh: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [countries, setCountries] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');
  const [selectedGameId, setSelectedGameId] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setCreating(true);
    setError('');
    try {
      await createGame({
        name,
        countryNames: countries
          .split(/[，,\n]/)
          .map((value) => value.trim())
          .filter(Boolean),
      });
      setName('');
      setCountries('');
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '创建失败');
    } finally {
      setCreating(false);
    }
  }

  return (
    <>
      <section className="dashboard-heading">
        <div>
          <p className="eyebrow">YOUR CAMPAIGNS</p>
          <h2>游戏大厅</h2>
          <p className="muted">欢迎回来，{me.displayName}</p>
        </div>
        <span className="count">{me.games.length} 场游戏</span>
      </section>

      <section className="game-grid">
        {me.games.map((game) => (
          <GameCard
            key={game.id}
            game={game}
            selected={selectedGameId === game.id}
            onSelect={() =>
              setSelectedGameId(selectedGameId === game.id ? null : game.id)
            }
          />
        ))}
        {me.games.length === 0 && (
          <div className="empty-state">
            <strong>尚未加入游戏</strong>
            <span>创建一场新游戏，或等待主持人添加你。</span>
          </div>
        )}
      </section>

      {selectedGameId && (
        <GameWorkspace
          game={me.games.find((game) => game.id === selectedGameId)!}
        />
      )}

      <section className="create-card">
        <div>
          <p className="eyebrow">NEW CAMPAIGN</p>
          <h2>创建游戏</h2>
          <p className="muted">
            创建后，你会自动成为主持人并获得第一个准备中季度。
          </p>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <label>
            游戏名称
            <input
              required
              maxLength={120}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            初始国家（可选）
            <textarea
              rows={3}
              placeholder="以逗号或换行分隔"
              value={countries}
              onChange={(event) => setCountries(event.target.value)}
            />
          </label>
          {error && <p className="form-error">{error}</p>}
          <button
            className="button button--primary"
            disabled={creating}
            type="submit"
          >
            {creating ? '正在建立世界…' : '创建游戏'}
          </button>
        </form>
      </section>
    </>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });

  const loadSession = useCallback(async () => {
    try {
      setSession({ kind: 'ready', me: await fetchMe() });
    } catch (reason) {
      if (reason instanceof ApiRequestError && reason.status === 401) {
        setSession({ kind: 'guest' });
      } else {
        setSession({
          kind: 'error',
          message: reason instanceof Error ? reason.message : '加载失败',
        });
      }
    }
  }, []);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  async function signOut() {
    await logout();
    setSession({ kind: 'guest' });
  }

  return (
    <main>
      <header className="site-header">
        <div className="brand">
          <span className="brand__mark">SL</span>
          <div>
            <strong>SrilankaOL</strong>
            <small>主持人驱动的异步战略世界</small>
          </div>
        </div>
        <div className="header-actions">
          <SystemStatus />
          {session.kind === 'ready' && (
            <button
              className="button button--quiet"
              type="button"
              onClick={() => void signOut()}
            >
              退出登录
            </button>
          )}
        </div>
      </header>

      <section className="hero hero--compact">
        <p className="eyebrow">SRILANKA ONLINE · M1</p>
        <h1>世界从身份开始</h1>
        <p className="lede">
          每一场游戏、每一个角色、每一段已知历史，都从明确的成员边界中展开。
        </p>
      </section>

      {session.kind === 'loading' && (
        <p className="loading">正在读取游戏身份…</p>
      )}
      {session.kind === 'guest' && (
        <LoginPanel message={session.message} onSuccess={loadSession} />
      )}
      {session.kind === 'ready' && (
        <Dashboard me={session.me} refresh={loadSession} />
      )}
      {session.kind === 'error' && (
        <section className="empty-state">
          <strong>暂时无法读取游戏数据</strong>
          <span>{session.message}</span>
          <button
            className="button"
            type="button"
            onClick={() => void loadSession()}
          >
            重试
          </button>
        </section>
      )}

      <footer>M1 游戏与身份基础 · 服务端强制成员隔离</footer>
    </main>
  );
}
