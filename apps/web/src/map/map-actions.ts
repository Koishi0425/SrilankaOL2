import type { ActionCategory, TileDetails } from '@srilanka/contracts';
import type { ActionDraftSeed } from '../actions/ActionCenter.js';
export interface MapActionIntent {
  category?: ActionCategory;
  province?: { id: string; name: string };
}
export function mapActionSeed(
  tile: TileDetails,
  key: number,
  intent?: MapActionIntent,
): ActionDraftSeed {
  const place =
    intent?.province?.name ?? tile.regionName ?? `地块 ${tile.q},${tile.r}`;
  const details = [
    `坐标 ${tile.q},${tile.r}`,
    tile.terrainName ?? '未知地形',
    tile.controllerCountryName
      ? `由${tile.controllerCountryName}控制`
      : '控制方未知',
  ].join(' · ');
  return {
    key,
    title: `关于${place}的政策 / 行动`.slice(0, 160),
    category: intent?.category,
    ref: {
      refKind: 'Target',
      objectType: intent?.province ? 'Province' : 'Tile',
      objectId: intent?.province?.id ?? tile.id,
      label: (intent?.province
        ? `省份：${place}`
        : `${place}（${details}）`
      ).slice(0, 160),
    },
  };
}
