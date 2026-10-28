import { useEffect, useState } from 'react';
import { treatyKindLabel } from '@srilanka/contracts';
import type {
  ActionCategory,
  MapTileContext,
  TileDetails,
} from '@srilanka/contracts';
import { fetchTileContext } from '../api.js';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import type { MapActionIntent } from './map-actions.js';

export type ProvinceScope = NonNullable<MapTileContext['province']>['tiles'];
const actionKinds: Array<[ActionCategory, string]> = [
  ['Construction', '建设'],
  ['Exploration', '探索'],
  ['Military', '军事'],
  ['Policy', '自由政策'],
];

export function TileContextPanel({
  gameId,
  tile,
  previewMemberId,
  countryId,
  refreshKey,
  active,
  onScopeChange,
  onCreateAction,
}: {
  gameId: string;
  tile: TileDetails;
  previewMemberId?: string;
  countryId?: string;
  refreshKey: string;
  active: boolean;
  onScopeChange: (tiles: ProvinceScope) => void;
  onCreateAction?: (tile: TileDetails, intent?: MapActionIntent) => void;
}) {
  const [data, setData] = useState<MapTileContext | null>(null);
  const [error, setError] = useState('');
  const [reload, setReload] = useState(0);
  const [highlight, setHighlight] = useState(true);
  const [target, setTarget] = useState<'province' | 'tile'>('province');
  const identity = `${gameId}:${tile.id}:${previewMemberId ?? ''}:${countryId ?? ''}:${refreshKey}`;
  const [loadedIdentity, setLoadedIdentity] = useState('');
  const current = loadedIdentity === identity ? data : null;
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setError('');
    void fetchTileContext(gameId, tile.id, {
      previewMemberId,
      countryId,
      signal: controller.signal,
    })
      .then((next) => {
        if (!controller.signal.aborted) {
          setData(next);
          setLoadedIdentity(identity);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : '省份资料读取失败');
      });
    return () => controller.abort();
  }, [
    gameId,
    tile.id,
    previewMemberId,
    countryId,
    refreshKey,
    active,
    reload,
    identity,
  ]);
  useEffect(() => {
    onScopeChange(active && highlight ? (current?.province?.tiles ?? []) : []);
    return () => onScopeChange([]);
  }, [active, current, highlight, onScopeChange]);
  const province = current?.province;
  const values = province?.values;
  const provinceTarget =
    target === 'province' && province?.id
      ? { id: province.id, name: province.name }
      : undefined;
  const targetName =
    provinceTarget?.name ?? tile.regionName ?? `地块 ${tile.q},${tile.r}`;
  const act = (category: ActionCategory) =>
    onCreateAction?.(tile, { category, province: provinceTarget });
  return (
    <section className="tile-context" aria-label="省份事务">
      {error && (
        <p role="alert" className="form-error">
          {error} <button onClick={() => setReload((n) => n + 1)}>重试</button>
        </p>
      )}
      {!current && !error && <LoadingSkeleton label="读取省份资料…" />}
      {province && (
        <div className="tile-province-heading">
          <strong>{province.name}</strong>
          <button
            aria-pressed={highlight}
            onClick={() => setHighlight((value) => !value)}
          >
            {province.knownOnly ? '已知范围' : '省份范围'} ·{' '}
            {province.tiles.length} 格
          </button>
        </div>
      )}
      {onCreateAction && (
        <div className="map-policy-entry">
          {province?.id && (
            <label>
              行动目标
              <select
                aria-label="地图行动目标"
                value={target}
                onChange={(event) =>
                  setTarget(event.target.value as 'province' | 'tile')
                }
              >
                <option value="province">省份 · {province.name}</option>
                <option value="tile">
                  地块 · {tile.q},{tile.r}
                </option>
              </select>
            </label>
          )}
          <div className="map-policy-buttons">
            {actionKinds.map(([category, label]) => (
              <button
                key={category}
                aria-label={`针对${targetName}编写${label}`}
                onClick={() => act(category)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      )}
      {province && (
        <details>
          <summary>经济与贸易</summary>
          {values ? (
            <>
              <dl>
                <dt>税收基础</dt>
                <dd>{values.taxBase}</dd>
                <dt>生产基础</dt>
                <dd>{values.productionBase}</dd>
                <dt>人力基础</dt>
                <dd>{values.manpowerBase}</dd>
              </dl>
              {current?.economy?.enabled ? (
                <>
                  <dl>
                    <dt>预计税收</dt>
                    <dd>{current.economy.tax.toLocaleString()}</dd>
                    <dt>预计生产</dt>
                    <dd>{current.economy.production.toLocaleString()}</dd>
                    <dt>预计人力</dt>
                    <dd>{current.economy.manpower.toLocaleString()}</dd>
                  </dl>
                  <p className="muted">
                    本省每季对{current.economy.countryName}
                    的贡献估算，最终以结算为准。
                  </p>
                </>
              ) : (
                <p className="muted">自动经济尚未启用。</p>
              )}
              <dl>
                <dt>贸易区</dt>
                <dd>
                  {current?.tradeZones?.map((z) => z.name).join('、') ||
                    '暂无可见记录'}
                </dd>
              </dl>
            </>
          ) : (
            <p className="muted">暂无可见的完整省份经济资料。</p>
          )}
        </details>
      )}
      {current?.diplomacy && (
        <details>
          <summary>外交关系</summary>
          {current.diplomacy.referenceCountryName && (
            <p>以{current.diplomacy.referenceCountryName}为准</p>
          )}
          {current.diplomacy.relations.map((r) => (
            <p key={r.countryIds.join(':')}>
              {r.countryNames.join(' · ')}：
              {r.state === 'War' ? '战争中' : '和平'}
            </p>
          ))}
          {current.diplomacy.treaties.map((t) => (
            <details key={t.id}>
              <summary>
                {t.title} · {treatyKindLabel(t.type)}
              </summary>
              <p>{t.countryNames.join('、')}</p>
              <p className="rules-text">{t.terms}</p>
            </details>
          ))}
          {!current.diplomacy.relations.length &&
            !current.diplomacy.treaties.length && (
              <p className="muted">暂无相关外交记录。</p>
            )}
          {onCreateAction && (
            <button onClick={() => act('Diplomacy')}>编写外交政策</button>
          )}
        </details>
      )}
      {province && (
        <details>
          <summary>行政与长期政策</summary>
          {values ? (
            <dl>
              <dt>自治</dt>
              <dd>{values.autonomy}%</dd>
              <dt>不满</dt>
              <dd>{values.unrest}</dd>
            </dl>
          ) : (
            <p className="muted">暂无可见的省份行政资料。</p>
          )}
          {values?.description && (
            <p className="rules-text">{values.description}</p>
          )}
          {current?.government && (
            <>
              <dl>
                <dt>政府</dt>
                <dd>{current.government.profile.regime || '未设置'}</dd>
                <dt>执政者</dt>
                <dd>{current.government.profile.authority || '未设置'}</dd>
              </dl>
              {current.government.policies.map((p) => (
                <details key={p.id}>
                  <summary>{p.title}</summary>
                  <p className="rules-text">{p.text}</p>
                </details>
              ))}
              {!current.government.policies.length && (
                <p className="muted">暂无生效中的长期政策。</p>
              )}
            </>
          )}
        </details>
      )}
    </section>
  );
}
