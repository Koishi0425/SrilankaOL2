import { useEffect, useRef, useState } from 'react';
import type { GamePreparation, QuarterSummary } from '@srilanka/contracts';
import { fetchPreparation, openFirstQuarter } from '../api.js';

export type PreparationTarget =
  'members' | 'rules' | 'map' | 'economy' | 'government';
export function GamePreparationPanel({
  gameId,
  active,
  onNavigate,
  onOpened,
}: {
  gameId: string;
  active: boolean;
  onNavigate: (target: PreparationTarget) => void;
  onOpened: (quarter: QuarterSummary) => void;
}) {
  const [data, setData] = useState<GamePreparation | null>(null);
  const [error, setError] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const requestVersion = useRef(0);
  useEffect(() => {
    if (!active || confirming) return;
    const controller = new AbortController();
    const version = ++requestVersion.current;
    let inFlight = false;
    const load = async () => {
      if (document.hidden || inFlight) return;
      inFlight = true;
      try {
        const saved = await fetchPreparation(gameId, controller.signal);
        if (!controller.signal.aborted && version === requestVersion.current) {
          setData(saved);
          setError('');
        }
      } catch (cause) {
        if (!controller.signal.aborted && version === requestVersion.current)
          setError(cause instanceof Error ? cause.message : '准备内容读取失败');
      } finally {
        inFlight = false;
      }
    };
    void load();
    const timer = window.setInterval(() => void load(), 5000);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [active, confirming, gameId, refresh]);

  async function review() {
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    ++requestVersion.current;
    try {
      const saved = await fetchPreparation(gameId);
      setData(saved);
      setError('');
      if (saved.canOpen) setConfirming(true);
      else setError('请先添加玩家并为每位玩家分配国家。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '准备内容读取失败');
    } finally {
      pending.current = false;
      setBusy(false);
      setRefresh((value) => value + 1);
    }
  }
  async function open() {
    if (!data || pending.current) return;
    pending.current = true;
    setBusy(true);
    setError('');
    try {
      onOpened(
        await openFirstQuarter(gameId, {
          quarterId: data.quarter.id,
          expectedRevision: data.revision,
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '开局失败，请重试。');
    } finally {
      pending.current = false;
      setBusy(false);
    }
  }
  return (
    <div className="game-preparation">
      {!data && !error && <p>读取准备内容…</p>}
      {data && (
        <>
          <div className="preparation-row">
            <div>
              <strong>成员与国家</strong>
              <p>
                {data.countryCount} 个国家 · {data.assignedPlayerCount}/
                {data.playerCount} 位玩家已分配
              </p>
              {data.playerCount === 0 && <p>至少添加一位玩家。</p>}
              {data.unassignedPlayers.length > 0 && (
                <p className="form-error">
                  未分配：
                  {data.unassignedPlayers
                    .map((player) => player.displayName)
                    .join('、')}
                </p>
              )}
            </div>
            <button
              disabled={busy || confirming}
              onClick={() => onNavigate('members')}
            >
              分配
            </button>
          </div>
          <p className="muted">以下为可选设置，空白项按当前默认值开局。</p>
          {(
            [
              ['rules', '剧本与规则', data.rulesSaved ? '已保存' : '尚未填写'],
              [
                'map',
                '地图',
                data.map
                  ? `${data.map.name} · ${data.map.tileCount} 格，${data.map.controlledTileCount} 格已有控制方`
                  : '尚未创建',
              ],
              [
                'economy',
                '初始资源',
                `${data.resourceCountryCount}/${data.countryCount} 国已调整余额，其余国库、人力为 0`,
              ],
              [
                'rules',
                '每季经济',
                data.automaticEconomy ? '已启用自动账单' : '未启用自动账单',
              ],
              [
                'government',
                '政府资料',
                `${data.governmentCountryCount}/${data.countryCount} 国已保存`,
              ],
            ] as const
          ).map(([target, title, status]) => (
            <div className="preparation-row" key={title}>
              <div>
                <strong>{title}</strong>
                <p>{status}</p>
              </div>
              <button
                disabled={busy || confirming}
                onClick={() => onNavigate(target)}
              >
                设置
              </button>
            </div>
          ))}
          {confirming ? (
            <div
              className="opening-confirmation"
              role="group"
              aria-label="确认开局"
            >
              <p>确认开放第一回合？玩家将可以提交政策。</p>
              <p>
                开放后，本回合的资源、政府与经济规则停止直接设置；本季经济按开局时的数据计算。
              </p>
              <div className="form-actions">
                <button
                  className="button button--primary"
                  disabled={busy}
                  onClick={() => void open()}
                >
                  {busy ? '正在开放…' : '确认开放'}
                </button>
                <button
                  disabled={busy}
                  onClick={() => {
                    setConfirming(false);
                    setRefresh((value) => value + 1);
                  }}
                >
                  返回准备
                </button>
              </div>
            </div>
          ) : (
            <button
              className="button button--primary"
              disabled={busy || !!error || !data.canOpen}
              onClick={() => void review()}
            >
              {busy ? '正在读取…' : '开放第一回合'}
            </button>
          )}
        </>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {!confirming && (
        <button
          className="button button--quiet"
          disabled={busy}
          onClick={() => setRefresh((value) => value + 1)}
        >
          重新读取
        </button>
      )}
    </div>
  );
}
