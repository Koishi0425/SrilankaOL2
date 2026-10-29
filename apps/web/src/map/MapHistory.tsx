import { useEffect, useState } from 'react';
import type { MapHistoryEntry } from '@srilanka/contracts';
import { fetchMapHistory } from '../api.js';

const names: Record<string, string> = {
  Correction: '结算更正',
  CreateMap: '创建地图',
  GenerateMap: '生成地形',
  TileTags: '地块状态',
  TileTagPeriod: '状态回合更新',
  EditTiles: '批量布置',
  EditProvince: '设置省份资料',
  EditTile: '修改地块',
  CreateCity: '创建城市',
  CreateArmy: '创建军队',
  MoveArmy: '移动军队',
  InitializeKnowledge: '设置初始范围',
  RevealKnowledge: '揭示信息',
  PrepareExploration: '准备探索结果',
  RemoveExploration: '移除探索结果',
  PublishExploration: '发布探索结果',
  PublishStateChanges: '结算状态变化',
};
export function MapHistory({
  gameId,
  revision,
  active,
  previewMemberId,
}: {
  gameId: string;
  revision?: number;
  active: boolean;
  previewMemberId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [entries, setEntries] = useState<MapHistoryEntry[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !active) return;
    let live = true;
    void fetchMapHistory(gameId, previewMemberId)
      .then((rows) => {
        if (live) {
          setEntries(rows);
          setError('');
        }
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : '记录加载失败');
      });
    return () => {
      live = false;
    };
  }, [active, gameId, open, revision, previewMemberId]);
  return (
    <details
      className="map-history"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>地图记录</summary>
      {error ? (
        <p className="form-error">{error}</p>
      ) : entries.length ? (
        <ol>
          {entries.map((entry) => (
            <li key={entry.id}>
              <time>{new Date(entry.createdAt).toLocaleString('zh-CN')}</time> ·{' '}
              {names[entry.kind] ?? entry.kind}
              {entry.countryName && ` · ${entry.countryName}`}
              {entry.tileCount > 0 && ` · ${entry.tileCount} 个地块`}
              {entry.sourceActionTitle && <div>{entry.sourceActionTitle}</div>}
              {entry.note && <p className="rules-text">{entry.note}</p>}
            </li>
          ))}
        </ol>
      ) : (
        <p>暂无记录。</p>
      )}
    </details>
  );
}
