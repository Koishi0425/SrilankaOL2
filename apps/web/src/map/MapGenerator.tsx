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
  const [step, setStep] = useState<'terrain' | 'territory'>('terrain');
  const [busy, setBusy] = useState(false),
    [elapsed, setElapsed] = useState(0),
    [error, setError] = useState('');
  useEffect(() => {
    if (!busy) return;
    const started = Date.now();
    setElapsed(0);
    const timer = window.setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [busy]);
  const countryIds = useMemo(
    () =>
      step === 'territory' && assign && !blank
        ? countries.map((c) => c.id).sort()
        : [],
    [step, assign, blank, countries],
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
  };
  async function apply() {
    if (busy || !valid || preview.error || blockedReason) return;
    setBusy(true);
    setError('');
    try {
      const signal = AbortSignal.timeout(120_000);
      const data = map
        ? await generateMapTerrain(
            gameId,
            {
              ...settings,
              seed: options.seed.trim(),
              expectedRevision: revision,
            },
            signal,
          )
        : await createMap(
            gameId,
            {
              name: name.trim(),
              width,
              height,
              ...(!blank
                ? { generation: { ...settings, seed: options.seed.trim() } }
                : {}),
            },
            signal,
          );
      onSelection([]);
      onChanged(data);
    } catch (cause) {
      setError(
        typeof cause === 'object' &&
          cause !== null &&
          'name' in cause &&
          cause.name === 'TimeoutError'
          ? '保存等待超时，服务器可能仍在处理。请重新读取地图确认状态，避免重复创建。'
          : cause instanceof Error
            ? cause.message
            : '地图生成失败，请重新读取后重试。',
      );
      try {
        const fresh = await fetchMapSetup(gameId, AbortSignal.timeout(10_000));
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
          <p className="map-generator-steps" aria-label="地图创建步骤">
            <span aria-current={step === 'terrain' ? 'step' : undefined}>
              1. 选择地形
            </span>
            <span aria-current={step === 'territory' ? 'step' : undefined}>
              2. 分配领土
            </span>
            <span>3. 保存后布置</span>
          </p>
          <fieldset disabled={busy} className="draft-fields">
            {step === 'terrain' ? (
              <>
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
                              e.target
                                .value as MapGenerationOptions['seaLevel'],
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
                              e.target
                                .value as MapGenerationOptions['rainfall'],
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
                              e.target
                                .value as MapGenerationOptions['worldAge'],
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
                      重新生成预览
                    </button>
                  </>
                )}
              </>
            ) : (
              <>
                <p>
                  <strong>
                    已选定地形：{width} × {height}，共 {width * height} 个地块。
                  </strong>{' '}
                  保存前仍可返回调整。
                </p>
                {blank ? (
                  <p>空白地图将保留全部平原与无主地块，保存后手动布置。</p>
                ) : (
                  <>
                    <label className="check-row">
                      <input
                        type="checkbox"
                        checked={assign}
                        disabled={!countries.length}
                        onChange={(e) => {
                          setAssign(e.target.checked);
                        }}
                      />
                      自动将陆地划分给本局国家
                    </label>
                    {assign && (
                      <p className="muted">
                        同时设置法理归属与控制方；各国至少获得一块陆地。面积、经济和军事条件仍需主持人检查调整。
                      </p>
                    )}
                    {!assign && (
                      <p className="muted">
                        陆地保持无主，保存后可用笔刷与批量工具手动分配。
                      </p>
                    )}
                    {!countries.length && (
                      <p className="muted">
                        本局尚无可分配的国家。可先保存地形，添加国家后手动布置。
                      </p>
                    )}
                  </>
                )}
              </>
            )}
            {!!preview.tiles.length && (
              <>
                {step === 'territory' && assign && (
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
                        step === 'territory' &&
                        assign &&
                        political &&
                        t.countryId
                          ? (countries.find((c) => c.id === t.countryId)
                              ?.mapColor ?? generatedTerrainColors[t.terrain])
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
                  参数、尺寸和种子相同时，生成相同地形。当前为本地预览，尚未保存。
                </p>
              </>
            )}
          </fieldset>
          {(error || preview.error || !valid) && (
            <p role="alert" className="form-error">
              {error || preview.error || '请填写 1–100 的整数行列与地图种子。'}
            </p>
          )}
          {step === 'terrain' ? (
            <button
              className="button--primary"
              disabled={
                busy || !valid || !!preview.error || (!map && !name.trim())
              }
              onClick={() => {
                setStep('territory');
                setError('');
              }}
            >
              确认地形，下一步
            </button>
          ) : (
            <>
              <p className="muted">
                {map ? '保存会覆盖当前地形。' : ''}
                保存后进入地图布置；开始手动布置或揭示情报后，整体重新生成将锁定。
              </p>
              <div className="map-generator-actions">
                <button
                  disabled={busy}
                  onClick={() => {
                    setStep('terrain');
                    setError('');
                  }}
                >
                  返回调整地形
                </button>
                <button
                  className="button--primary"
                  disabled={
                    busy || !valid || !!preview.error || (!map && !name.trim())
                  }
                  onClick={() => void apply()}
                >
                  {busy
                    ? '正在保存地图…'
                    : map
                      ? '确认覆盖并进入布置'
                      : '保存地图并进入布置'}
                </button>
              </div>
            </>
          )}
          {busy && (
            <p role="status">
              正在保存 {width * height} 个地块
              {assign && !blank ? '并计算初始视野' : ''}… 已等待 {elapsed} 秒。
              {elapsed >= 10 ? '请保持页面打开，无需重复点击。' : ''}
            </p>
          )}
        </>
      )}
    </section>
  );
}
