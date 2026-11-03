import { useEffect, useState } from 'react';
import {
  isGameReadOnly,
  type AssistantStatus,
  type GameSummary,
} from '@srilanka/contracts';
import { fetchAssistantStatus } from '../api.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';

export function AssistantHome({
  game,
  onOpenSettlement,
  onOpenRules,
}: {
  game: GameSummary;
  onOpenSettlement: () => void;
  onOpenRules: () => void;
}) {
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const host = game.role === 'Host' || game.role === 'Administrator';
  const readOnly = isGameReadOnly(game.status);
  const published = ['Published', 'Completed'].includes(
    game.currentQuarter.state,
  );

  useEffect(() => {
    let controller: AbortController | null = null;
    const read = () => {
      controller?.abort();
      const request = new AbortController();
      controller = request;
      setStatus(null);
      setError('');
      void fetchAssistantStatus(game.id, request.signal)
        .then((next) => {
          if (!request.signal.aborted) setStatus(next);
        })
        .catch((cause: unknown) => {
          if (!request.signal.aborted)
            setError(
              cause instanceof Error ? cause.message : '读取 AI 服务状态失败。',
            );
        });
    };
    read();
    window.addEventListener('focus', read);
    window.addEventListener('srilanka-assistant-settings-changed', read);
    return () => {
      controller?.abort();
      window.removeEventListener('focus', read);
      window.removeEventListener('srilanka-assistant-settings-changed', read);
    };
  }, [game.id, game.role, reload]);

  return (
    <section className="assistant-home" aria-label="AI 使用入口">
      <h4>从这里使用 AI</h4>
      <p>当前提供结算速览和主持人反馈起草，点击对应功能后再手动生成。</p>
      <div className="assistant-service-status" aria-label="AI 服务状态">
        {!status && !error && <LoadingSkeleton label="正在读取 AI 服务状态…" />}
        {error && <p role="alert">{error}</p>}
        {status && (
          <>
            <p role="status">
              {!status.configured
                ? 'AI 服务尚未配置完整或保存的密钥无法读取。'
                : !status.enabled
                  ? status.scope === 'Global'
                    ? '全站 AI 服务已停用。'
                    : '本局尚未开启 AI 辅助。'
                  : status.scope === 'Global'
                    ? '全站 AI 服务已启用，无需逐局开启。'
                    : '本局 AI 辅助已开启。'}
            </p>
            <p className="muted">
              {status.provider}
              {status.model ? ` · ${status.model}` : ''}
            </p>
            {!status.configured && (
              <p>请系统管理员打开顶部“全局 AI 设置”，保存配置并测试连接。</p>
            )}
            {status.configured &&
              !status.enabled &&
              status.scope === 'Global' && (
                <p>
                  请系统管理员在顶部“全局 AI 设置”中勾选“启用全站 AI
                  服务”并保存。
                </p>
              )}
            {status.canManage && status.configured && !status.enabled && (
              <button type="button" onClick={onOpenRules}>
                前往本局模型辅助设置
              </button>
            )}
          </>
        )}
        <button type="button" onClick={() => setReload((value) => value + 1)}>
          重新读取 AI 状态
        </button>
      </div>

      {host && !readOnly && (
        <section className="assistant-entry" aria-label="主持人反馈起草入口">
          <h4>主持人：起草政策结算反馈</h4>
          <ol>
            <li>进入“回合结算”，完成审核后点击“开始结算”。</li>
            <li>选择一份政策，先保存当前结算草稿。</li>
            <li>
              打开“起草反馈”，填写“主持人已定结果”，再点击“生成反馈草稿”。
            </li>
            <li>核对后点击“填入反馈”，再按原流程保存和发布。</li>
          </ol>
          {game.currentQuarter.state === 'Resolving' ? (
            <p>当前已进入结算阶段，可选择政策起草反馈。</p>
          ) : published ? (
            <p>本回合已发布。反馈起草用于当前未发布的结算草稿。</p>
          ) : (
            <p>当前尚未进入结算阶段，完成政策提交与审核后可使用。</p>
          )}
          <button type="button" onClick={onOpenSettlement}>
            前往回合结算
          </button>
        </section>
      )}
      <section className="assistant-entry" aria-label="结算速览入口">
        <h4>查看已发布结果：结算速览</h4>
        <ol>
          <li>进入回合结果，选择已发布的回合。</li>
          <li>打开“结算速览”，选择篇幅，再点击“生成速览”。</li>
        </ol>
        {!published && (
          <p>
            本回合尚未发布。若已有历史结果，可在回合选择器切换到已发布回合。
          </p>
        )}
        <p className="muted">速览只归纳你有权查看的已发布资料。</p>
        <button type="button" onClick={onOpenSettlement}>
          前往回合结果
        </button>
      </section>
    </section>
  );
}
