import { useEffect, useMemo, useState } from 'react';
import {
  generateMap,
  generatedTerrainColors,
  generationDefaults,
  type MapGenerationOptions,
  type MapMetadata,
  type MapSetupData,
  type CountrySummary,
} from '@srilanka/contracts';
import { createMap, generateMapTerrain, fetchMapSetup } from '../api.js';

export function MapGenerator({
  gameId,
  countries,
  map,
  blockedReason,
  onChanged,
  onSelection,
  onRefresh,
}: {
  gameId: string;
  countries: CountrySummary[];
  map: MapMetadata | null;
  blockedReason?: string;
  onChanged: (data: MapSetupData) => void;
  onRefresh?: (data: MapSetupData) => void;
  onSelection: (ids: string[]) => void;
}) {
  const [name, setName] = useState('剧本地图');
  const [revision, setRevision] = useState(map?.revision ?? 1);
  useEffect(() => setRevision(map?.revision ?? 1), [map?.revision]);
  const [width, setWidth] = useState(map?.width ?? 40),
    [height, setHeight] = useState(map?.height ?? 28);
  const [options, setOptions] = useState({
    ...generationDefaults,
    seed: Math.random().toString(36).slice(2, 10),
  });
  const [blank, setBlank] = useState(false),
    [assign, setAssign] = useState(false),
    [political, setPolitical] = useState(false);
  const [busy, setBusy] = useState(false),
    [confirm, setConfirm] = useState(false),
    [error, setError] = useState('');
  const countryIds = useMemo(
    () => (assign ? countries.map((c) => c.id).sort() : []),
    [assign, countries],
  );
  const settings = useMemo(
    () => ({ ...options, seed: options.seed.trim(), countryIds }),
    [options, countryIds],
  );
  const valid =
    Number.isInteger(width) &&
    Number.isInteger(height) &&
    width >= 1 &&
    width <= 100 &&
    height >= 1 &&
    height <= 100 &&
    (blank || !!options.seed.trim());
  const preview = useMemo(() => {
    if (!valid || blank) return { tiles: [], error: '' };
    try {
      return { tiles: generateMap(width, height, settings), error: '' };
    } catch (cause) {
      return {
        tiles: [],
        error: cause instanceof Error ? cause.message : '无法生成预览',
      };
    }
  }, [width, height, settings, valid, blank]);
  const update = <K extends keyof MapGenerationOptions>(
    key: K,
    value: MapGenerationOptions[K],
  ) => {
    setOptions((current) => ({ ...current, [key]: value }));
    setConfirm(false);
  };
  async function apply() {
    if (busy || !valid || preview.error || blockedReason) return;
    setBusy(true);
    setError('');
    try {
      const data = map
        ? await generateMapTerrain(gameId, {
            ...settings,
            seed: options.seed.trim(),
            expectedRevision: revision,
          })
        : await createMap(gameId, {
            name: name.trim(),
            width,
            height,
            ...(!blank
              ? { generation: { ...settings, seed: options.seed.trim() } }
              : {}),
          });
      onSelection([]);
      onChanged(data);
      setConfirm(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : '地图生成失败，请重新读取后重试。',
      );
      setConfirm(false);
      try {
        const fresh = await fetchMapSetup(gameId);
        setRevision(fresh.map?.revision ?? revision);
        onRefresh?.(fresh);
      } catch {
        /* Keep the original error and inputs. */
      }
    } finally {
      setBusy(false);
    }
  }
  const counts = preview.tiles.reduce(
    (result, t) => ({ ...result, [t.terrain]: (result[t.terrain] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  return (
    <section
      className="map-generator"
      aria-label={map ? '重新生成地形' : '创建地图'}
    >
      <h4>{map ? '重新生成地形' : '创建地图'}</h4>
      {blockedReason ? (
        <p role="status">{blockedReason}</p>
      ) : (
        <>
          <fieldset disabled={busy} className="draft-fields">
            {!map && (
              <label>
                地图名称
                <input
                  required
                  maxLength={120}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
            )}
            <label>
              生成方式
              <select
                value={blank ? 'Blank' : options.mapType}
                onChange={(e) => {
                  setBlank(e.target.value === 'Blank');
                  if (e.target.value !== 'Blank')
                    update(
                      'mapType',
                      e.target.value as MapGenerationOptions['mapType'],
                    );
                  setConfirm(false);
                }}
              >
                <option value="Pangaea">盘古大陆 · 以连片陆地为主</option>
                <option value="Continents">多大陆 · 海峡分隔陆地</option>
                <option value="Archipelago">群岛 · 多个小岛</option>
                <option value="InlandSea">内海 · 陆地环绕水域</option>
                {!map && <option value="Blank">空白地图 · 手动布置</option>}
              </select>
            </label>
            {!map && (
              <label>
                地图大小
                <select
                  value={
                    [
                      [24, 16],
                      [40, 28],
                      [64, 44],
                    ].some(([w, h]) => w === width && h === height)
                      ? `${width}x${height}`
                      : 'custom'
                  }
                  onChange={(e) => {
                    if (e.target.value !== 'custom') {
                      const [w, h] = e.target.value.split('x').map(Number);
                      setWidth(w!);
                      setHeight(h!);
                    }
                    setConfirm(false);
                  }}
                >
                  {[
                    [24, 16, '小型'],
                    [40, 28, '标准'],
                    [64, 44, '大型'],
                  ].map(([w, h, label]) => (
                    <option key={label} value={`${w}x${h}`}>
                      {label} · {w} × {h}
                    </option>
                  ))}
                  <option value="custom">自定义</option>
                </select>
              </label>
            )}
            <div className="map-fields">
              <label>
                列数
                <input
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={width}
                  disabled={!!map}
                  onChange={(e) => {
                    setWidth(Number(e.target.value));
                    setConfirm(false);
                  }}
                />
              </label>
              <label>
                行数
                <input
                  type="number"
                  min={1}
                  max={100}
                  required
                  value={height}
                  disabled={!!map}
                  onChange={(e) => {
                    setHeight(Number(e.target.value));
                    setConfirm(false);
                  }}
                />
              </label>
            </div>
            {!blank && (
              <>
                <div className="map-fields">
                  <label>
                    海平面
                    <select
                      value={options.seaLevel}
                      onChange={(e) =>
                        update(
                          'seaLevel',
                          e.target.value as MapGenerationOptions['seaLevel'],
                        )
                      }
                    >
                      <option value="Low">低 · 更多陆地</option>
                      <option value="Normal">标准</option>
                      <option value="High">高 · 更多水域</option>
                    </select>
                  </label>
                  <label>
                    湿度
                    <select
                      value={options.rainfall}
                      onChange={(e) =>
                        update(
                          'rainfall',
                          e.target.value as MapGenerationOptions['rainfall'],
                        )
                      }
                    >
                      <option value="Dry">干燥 · 较少森林</option>
                      <option value="Normal">标准</option>
                      <option value="Wet">湿润 · 较多森林</option>
                    </select>
                  </label>
                  <label>
                    地质年龄
                    <select
                      value={options.worldAge}
                      onChange={(e) =>
                        update(
                          'worldAge',
                          e.target.value as MapGenerationOptions['worldAge'],
                        )
                      }
                    >
                      <option value="Young">年轻 · 更多山地丘陵</option>
                      <option value="Normal">标准</option>
                      <option value="Old">古老 · 更多平地</option>
                    </select>
                  </label>
                </div>
                <label>
                  地图种子
                  <input
                    maxLength={80}
                    value={options.seed}
                    onChange={(e) => update('seed', e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    update('seed', Math.random().toString(36).slice(2, 10))
                  }
                >
                  换一张预览
                </button>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={assign}
                    disabled={!countries.length}
                    onChange={(e) => {
                      setAssign(e.target.checked);
                      setConfirm(false);
                    }}
                  />
                  自动将陆地划分给本局国家
                </label>
                {assign && (
                  <p className="muted">
                    同时设置法理归属与控制方；各国至少获得一块陆地。面积、经济和军事条件仍需主持人检查调整。
                  </p>
                )}
                {!!preview.tiles.length && (
                  <>
                    {assign && (
                      <label className="check-row">
                        <input
                          type="checkbox"
                          checked={political}
                          onChange={(e) => setPolitical(e.target.checked)}
                        />
                        预览国家划分
                      </label>
                    )}
                    <svg
                      className="map-generator-preview"
                      viewBox={`-6 -6 ${width * 10 + 12} ${height * 8.66 + 12}`}
                      role="img"
                      aria-label="待生成地图预览"
                    >
                      {preview.tiles.map((t) => (
                        <polygon
                          key={`${t.q}:${t.r}`}
                          points="0,-5.7 5,-2.9 5,2.9 0,5.7 -5,2.9 -5,-2.9"
                          transform={`translate(${t.q * 10 + (t.r % 2) * 5},${t.r * 8.66})`}
                          fill={
                            assign && political && t.countryId
                              ? (countries.find((c) => c.id === t.countryId)
                                  ?.mapColor ??
                                generatedTerrainColors[t.terrain])
                              : generatedTerrainColors[t.terrain]
                          }
                        />
                      ))}
                    </svg>
                    <p className="map-generator-counts">
                      {[
                        ['plains', '平原'],
                        ['hills', '丘陵'],
                        ['mountains', '山地'],
                        ['forest', '森林'],
                        ['water', '水域'],
                      ].map(([key, label]) => (
                        <span key={key}>
                          <i
                            style={{
                              background:
                                generatedTerrainColors[
                                  key as keyof typeof generatedTerrainColors
                                ],
                            }}
                          />
                          {label} {counts[key!] ?? 0}
                        </span>
                      ))}
                    </p>
                    <p className="muted">
                      参数、尺寸和种子相同时，生成相同地形。预览不会保存或向玩家公开。
                    </p>
                  </>
                )}
              </>
            )}
          </fieldset>
          {(error || preview.error || !valid) && (
            <p role="alert" className="form-error">
              {error || preview.error || '请填写 1–100 的整数行列与地图种子。'}
            </p>
          )}
          {confirm ? (
            <div className="draft-recovery">
              <p>
                将覆盖当前 {width} × {height}{' '}
                地图的地形。已确认此图尚未布置国家、地区、城市、军队或情报。
              </p>
              <button disabled={busy} onClick={() => void apply()}>
                {busy ? '生成中…' : '确认重新生成'}
              </button>
              <button disabled={busy} onClick={() => setConfirm(false)}>
                取消
              </button>
            </div>
          ) : (
            <button
              className="button--primary"
              disabled={
                busy || !valid || !!preview.error || (!map && !name.trim())
              }
              onClick={() => (map ? setConfirm(true) : void apply())}
            >
              {busy
                ? '生成中…'
                : map
                  ? '使用此预览重新生成'
                  : blank
                    ? '创建空白地图'
                    : '创建此地图'}
            </button>
          )}
        </>
      )}
    </section>
  );
}
