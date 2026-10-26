import { useCallback, useEffect, useState, useRef } from 'react';

import type { GameSummary, MeData } from '@srilanka/contracts';
import { isGameReadOnly } from '@srilanka/contracts';
import {
  ApiRequestError,
  beginSession,
  onSessionExpired,
  fetchMe,
  logout,
} from './api.js';
import { GameWorkspace } from './workspace/GameWorkspace.js';
import { NewGameForm } from './workspace/NewGameForm.js';
import { DraftAccountProvider } from './drafts/local-drafts.js';
import { gameStatusNames, roleNames, seasonNames } from './game-labels.js';
import { LoginPanel, PasswordPanel } from './accounts/AccountPanels.js';
import { GlobalAssistantSettings } from './assistant/GlobalAssistantSettings.js';

type SessionState =
  | { kind: 'loading' }
  | { kind: 'guest'; message?: string }
  | { kind: 'ready'; me: MeData }
  | { kind: 'error'; message: string };

function Dashboard({ me }: { me: MeData }) {
  const refreshGeneration = useRef(0);
  const [games, setGames] = useState(me.games);
  const [creating, setCreating] = useState(false);
  const [canCreate, setCanCreate] = useState(
    me.canCreateGame ?? !me.games.some((game) => !isGameReadOnly(game.status)),
  );
  const [selectedGameId, setSelectedGameId] = useState<string | null>(() => {
    const activeGame = me.games.find((game) =>
      ['Preparing', 'Running', 'Paused', 'Correcting'].includes(game.status),
    );
    return activeGame?.id ?? me.games[0]?.id ?? null;
  });
  const updateGame = useCallback((next: GameSummary) => {
    setGames((previous) =>
      previous.map((item) => {
        if (
          item.id !== next.id ||
          (isGameReadOnly(item.status) && !isGameReadOnly(next.status))
        )
          return item;
        return {
          ...next,
          currentQuarter:
            item.currentQuarter.sequenceNumber >
            next.currentQuarter.sequenceNumber
              ? item.currentQuarter
              : next.currentQuarter,
        };
      }),
    );
    if (isGameReadOnly(next.status)) {
      if (['Host', 'Administrator'].includes(next.role)) setCanCreate(true);
      const generation = ++refreshGeneration.current;
      void fetchMe()
        .then((current) => {
          if (refreshGeneration.current !== generation) return;
          setGames(current.games);
          setCanCreate(
            current.canCreateGame ??
              !current.games.some((game) => !isGameReadOnly(game.status)),
          );
        })
        .catch(() => undefined);
    }
  }, []);

  return (
    <>
      {canCreate &&
        !games.some((game) => !isGameReadOnly(game.status)) &&
        !creating && (
          <div className="dashboard-actions">
            <button className="button" onClick={() => setCreating(true)}>
              新建一局
            </button>
          </div>
        )}
      {creating && (
        <NewGameForm
          onCancel={() => setCreating(false)}
          onCreated={(game) => {
            ++refreshGeneration.current;
            setGames((previous) => [
              game,
              ...previous.filter((item) => item.id !== game.id),
            ]);
            setSelectedGameId(game.id);
            setCanCreate(false);
            setCreating(false);
          }}
        />
      )}
      {!creating && games.length > 1 && (
        <div className="game-switcher">
          <label>
            游戏{' '}
            <select
              aria-label="选择游戏"
              value={selectedGameId ?? ''}
              onChange={(event) =>
                setSelectedGameId(event.target.value || null)
              }
            >
              <option value="">选择游戏</option>
              {[false, true].map((history) => (
                <optgroup
                  key={String(history)}
                  label={history ? '历史游戏' : '当前游戏'}
                >
                  {games
                    .filter((game) => isGameReadOnly(game.status) === history)
                    .map((game) => (
                      <option key={game.id} value={game.id}>
                        {game.name} · {roleNames[game.role]} ·{' '}
                        {gameStatusNames[game.status]} · 第{' '}
                        {game.currentQuarter.gameYear} 年{' '}
                        {seasonNames[game.currentQuarter.season]}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          </label>
        </div>
      )}
      {!creating && games.length === 0 && (
        <div className="empty-state">
          <strong>尚未加入游戏</strong>
          <span>请将用户名提供给主持人，让主持人添加你。</span>
        </div>
      )}

      {!creating && selectedGameId && (
        <DraftAccountProvider key={me.id} userId={me.id}>
          <GameWorkspace
            key={selectedGameId}
            game={games.find((game) => game.id === selectedGameId)!}
            onGameChange={updateGame}
          />
        </DraftAccountProvider>
      )}
    </>
  );
}

export function App() {
  const [session, setSession] = useState<SessionState>({ kind: 'loading' });
  const [accountOpen, setAccountOpen] = useState(false);
  const [globalAssistantOpen, setGlobalAssistantOpen] = useState(false);
  const [sessionExpired, setSessionExpired] = useState(false);
  const [sessionError, setSessionError] = useState('');
  const [signingOut, setSigningOut] = useState(false);
  const sessionKind = useRef(session.kind);
  sessionKind.current = session.kind;

  const loadSession = useCallback(async () => {
    try {
      const me = await fetchMe();
      beginSession();
      setSessionExpired(false);
      setSessionError('');
      setSession({ kind: 'ready', me });
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
  useEffect(
    () =>
      onSessionExpired(() => {
        if (sessionKind.current === 'ready') setSessionExpired(true);
      }),
    [],
  );

  async function signOut() {
    if (signingOut) return;
    setSigningOut(true);
    setSessionError('');
    try {
      await logout();
      beginSession();
      setSessionExpired(false);
      setAccountOpen(false);
      setGlobalAssistantOpen(false);
      setSession({ kind: 'guest' });
    } catch (reason) {
      setSessionError(
        reason instanceof Error ? reason.message : '退出失败，请重试。',
      );
    } finally {
      setSigningOut(false);
    }
  }

  return (
    <main className={session.kind === 'ready' ? 'app-shell--wide' : undefined}>
      <header className="site-header">
        <div className="brand">
          <h1>SrilankaOL</h1>
        </div>
        <div className="header-actions">
          {session.kind === 'ready' &&
            session.me.systemRole === 'Administrator' && (
              <button
                className="button button--quiet global-assistant-trigger"
                type="button"
                aria-expanded={globalAssistantOpen}
                onClick={() => setGlobalAssistantOpen((value) => !value)}
              >
                全局 AI 设置
              </button>
            )}
          {session.kind === 'ready' && (
            <span className="current-user">{session.me.displayName}</span>
          )}
          {session.kind === 'ready' && (
            <button
              className="button button--quiet"
              type="button"
              aria-expanded={accountOpen}
              onClick={() => setAccountOpen((value) => !value)}
            >
              账号
            </button>
          )}
          {session.kind === 'ready' && (
            <button
              className="button button--quiet"
              type="button"
              disabled={signingOut}
              onClick={() => void signOut()}
            >
              退出登录
            </button>
          )}
        </div>
      </header>

      {session.kind === 'ready' && sessionExpired && (
        <div className="session-notice" role="alert">
          <span>
            登录已失效。未保存的文字仍在本页，请先保留文字再重新登录。
          </span>
          <button
            className="button"
            type="button"
            onClick={() => {
              beginSession();
              setAccountOpen(false);
              setSessionExpired(false);
              setSession({ kind: 'guest', message: '请重新登录。' });
            }}
          >
            重新登录
          </button>
        </div>
      )}
      {session.kind === 'ready' && sessionError && (
        <p className="form-error" role="alert">
          {sessionError}
        </p>
      )}

      {session.kind === 'loading' && <p className="loading">加载中…</p>}
      {session.kind === 'guest' && (
        <LoginPanel message={session.message} onSuccess={loadSession} />
      )}
      {session.kind === 'ready' &&
        session.me.systemRole === 'Administrator' &&
        globalAssistantOpen && (
          <GlobalAssistantSettings
            onClose={() => setGlobalAssistantOpen(false)}
          />
        )}
      {session.kind === 'ready' && <Dashboard me={session.me} />}
      {session.kind === 'ready' && accountOpen && (
        <PasswordPanel
          username={session.me.username}
          onClose={() => setAccountOpen(false)}
          onChanged={() => {
            setAccountOpen(false);
            setSession({
              kind: 'guest',
              message: '密码已修改，请使用新密码重新登录。',
            });
          }}
        />
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
    </main>
  );
}
