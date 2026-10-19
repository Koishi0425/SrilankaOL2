import { useState, type FormEvent } from 'react';
import { isGameReadOnly, type GameSummary } from '@srilanka/contracts';
import { endGame } from '../api.js';

export function GameLifecyclePanel({
  game,
  onEnded,
}: {
  game: GameSummary;
  onEnded: (game: GameSummary) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function finish(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      onEnded(
        await endGame(game.id, {
          expectedQuarterId: game.currentQuarter.id,
          expectedQuarterState: game.currentQuarter.state,
          reason: reason.trim(),
        }),
      );
      setConfirming(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '结束失败，请重试。');
    } finally {
      setBusy(false);
    }
  }
  if (isGameReadOnly(game.status))
    return (
      <section className="game-lifecycle" aria-label="本局状态">
        <h4>本局已结束</h4>
        {game.endedAt && (
          <p>{new Date(game.endedAt).toLocaleString('zh-CN')}</p>
        )}
        {game.endingReason && <p className="rules-text">{game.endingReason}</p>}
        <p>历史记录按原权限保留，可从游戏列表另开新局。</p>
      </section>
    );
  return (
    <section className="game-lifecycle" aria-label="结束本局">
      {!confirming ? (
        <button
          className="button button--quiet"
          onClick={() => setConfirming(true)}
        >
          结束本局
        </button>
      ) : (
        <form onSubmit={(event) => void finish(event)}>
          <h4>结束并归档本局</h4>
          <p>
            结束后只能查看历史，未发布内容不会结算或公开。确认前请保存需要保留的草稿。
          </p>
          <label>
            结束说明
            <textarea
              required
              maxLength={2000}
              rows={3}
              value={reason}
              disabled={busy}
              onChange={(event) => setReason(event.target.value)}
            />
          </label>
          <div className="form-actions">
            <button
              type="submit"
              className="button button--danger"
              disabled={busy || !reason.trim()}
            >
              {busy ? '正在结束…' : '确认结束并归档'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setConfirming(false);
                setError('');
              }}
            >
              取消
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
