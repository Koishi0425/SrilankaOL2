import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CountrySummary,
  GameSummary,
  MapMetadata,
  MapSearchResult,
  MapTileSummary,
  MapViewportData,
  TileDetails,
} from '@srilanka/contracts';

import {
  createArmy,
  createCity,
  fetchMap,
  fetchMapViewport,
  fetchTile,
  moveArmy,
  searchMap,
  updateTileControl,
} from '../api.js';
import {
  axialToPixel,
  screenToAxial,
  visibleBounds,
  type ViewTransform,
} from './hex-math.js';

const HEX_SIZE = 27;

const discoveryStateNames: Record<MapTileSummary['discoveryState'], string> = {
  Unknown: '未知',
  Rumored: '传闻',
  Discovered: '已发现',
  Mapped: '已测绘',
  Observed: '近期观察',
  Outdated: '信息过时',
};

function drawHex(
  context: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
) {
  context.beginPath();
  for (let index = 0; index < 6; index += 1) {
    const angle = (Math.PI / 180) * (60 * index - 30);
    const px = x + size * Math.cos(angle);
    const py = y + size * Math.sin(angle);
    if (index === 0) context.moveTo(px, py);
    else context.lineTo(px, py);
  }
  context.closePath();
}

function formatStrength(army: MapTileSummary['armies'][number]): string {
  if (army.strength.kind === 'Exact') return String(army.strength.value);
  if (army.strength.kind === 'Range') {
    return `约 ${army.strength.min}–${army.strength.max}`;
  }
  return '人数未知';
}

export function HexMap({
  game,
  countries,
  previewMemberId,
}: {
  game: GameSummary;
  countries: CountrySummary[];
  previewMemberId?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [metadata, setMetadata] = useState<MapMetadata | null>(null);
  const [viewport, setViewport] = useState<MapViewportData | null>(null);
  const [selected, setSelected] = useState<TileDetails | null>(null);
  const [view, setView] = useState<ViewTransform>({
    offsetX: 70,
    offsetY: 65,
    scale: 1,
  });
  const [size, setSize] = useState({ width: 900, height: 520 });
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [results, setResults] = useState<MapSearchResult[]>([]);
  const [cityName, setCityName] = useState('');
  const [armyName, setArmyName] = useState('');
  const [armyStrength, setArmyStrength] = useState(1000);
  const [editCountryId, setEditCountryId] = useState(countries[0]?.id ?? '');
  const [movingArmy, setMovingArmy] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const canEdit =
    !previewMemberId && (game.role === 'Host' || game.role === 'Administrator');

  useEffect(() => {
    void fetchMap(game.id)
      .then(setMetadata)
      .catch((reason: unknown) => {
        setError(reason instanceof Error ? reason.message : '地图尚未初始化');
      });
  }, [game.id]);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (canvas)
        setSize({
          width: canvas.clientWidth || 900,
          height: canvas.clientHeight || 520,
        });
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const factor = event.deltaY < 0 ? 1.12 : 0.89;
      setView((current) => ({
        ...current,
        scale: Math.min(
          metadata?.maxZoom ?? 3,
          Math.max(metadata?.minZoom ?? 0.5, current.scale * factor),
        ),
      }));
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [metadata?.maxZoom, metadata?.minZoom]);

  const bounds = useMemo(() => {
    const raw = visibleBounds(size.width, size.height, view, HEX_SIZE);
    return metadata
      ? {
          minQ: Math.max(0, raw.minQ),
          maxQ: Math.min(metadata.width - 1, raw.maxQ),
          minR: Math.max(0, raw.minR),
          maxR: Math.min(metadata.height - 1, raw.maxR),
        }
      : raw;
  }, [metadata, size, view]);

  useEffect(() => {
    if (!metadata || bounds.minQ > bounds.maxQ || bounds.minR > bounds.maxR)
      return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void fetchMapViewport(game.id, bounds, controller.signal, previewMemberId)
        .then(setViewport)
        .catch((reason: unknown) => {
          if (!(
            reason instanceof DOMException && reason.name === 'AbortError'
          )) {
            setError(reason instanceof Error ? reason.message : '地图加载失败');
          }
        });
    }, 100);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [bounds, game.id, metadata, previewMemberId, revision]);

  useEffect(() => {
    setSelected(null);
    setMovingArmy(null);
    setResults([]);
  }, [previewMemberId]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.width * ratio;
    canvas.height = size.height * ratio;
    const context = canvas.getContext('2d');
    if (!context) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, size.width, size.height);
    context.fillStyle = '#0c1715';
    context.fillRect(0, 0, size.width, size.height);
    for (const tile of viewport?.tiles ?? []) {
      const point = axialToPixel(tile.q, tile.r, HEX_SIZE);
      const x = view.offsetX + point.x * view.scale;
      const y = view.offsetY + point.y * view.scale;
      const radius = HEX_SIZE * view.scale - 1;
      drawHex(context, x, y, radius);
      context.fillStyle =
        tile.controllerColor ?? tile.terrainColor ?? '#1c2926';
      context.globalAlpha =
        tile.discoveryState === 'Unknown'
          ? 0.35
          : tile.discoveryState === 'Rumored' ||
              tile.discoveryState === 'Discovered'
            ? 0.55
            : tile.discoveryState === 'Outdated'
              ? 0.68
              : tile.controllerColor
                ? 0.82
                : 1;
      context.fill();
      context.globalAlpha = 1;
      context.strokeStyle =
        selected?.id === tile.id ? '#f6d58f' : 'rgba(220,235,225,.28)';
      context.lineWidth = selected?.id === tile.id ? 3 : 1;
      context.stroke();
      if (tile.cities.length > 0) {
        context.fillStyle = '#f4e5bd';
        context.beginPath();
        context.arc(
          x - radius * 0.25,
          y,
          Math.max(3, 5 * view.scale),
          0,
          Math.PI * 2,
        );
        context.fill();
      }
      if (tile.armies.length > 0) {
        context.fillStyle = '#241b17';
        context.fillRect(
          x + radius * 0.05,
          y - 5,
          Math.max(6, 9 * view.scale),
          Math.max(6, 9 * view.scale),
        );
      }
      if (view.scale > 1.25) {
        context.fillStyle = '#14201d';
        context.font = `${Math.max(9, 10 * view.scale)}px sans-serif`;
        context.textAlign = 'center';
        context.fillText(`${tile.q},${tile.r}`, x, y + 4);
      }
    }
  }, [selected?.id, size, view, viewport]);

  async function selectTile(tile: MapTileSummary | undefined) {
    if (!tile) return;
    try {
      setSelected(
        movingArmy
          ? await moveArmy(game.id, movingArmy.id, tile.id)
          : await fetchTile(game.id, tile.id, previewMemberId),
      );
      if (movingArmy) {
        setMovingArmy(null);
        setRevision((value) => value + 1);
      }
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '地块读取失败');
    }
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (!search.trim()) return;
    try {
      setResults(await searchMap(game.id, search.trim(), previewMemberId));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '搜索失败');
    }
  }

  function focusResult(result: MapSearchResult) {
    if (result.q === null || result.r === null) return;
    const point = axialToPixel(result.q, result.r, HEX_SIZE);
    setView((current) => ({
      ...current,
      offsetX: size.width / 2 - point.x * current.scale,
      offsetY: size.height / 2 - point.y * current.scale,
    }));
    setResults([]);
  }

  async function refreshSelected(action: Promise<TileDetails>) {
    try {
      setSelected(await action);
      setRevision((value) => value + 1);
      setError('');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '地图编辑失败');
    }
  }

  return (
    <section className="map-shell">
      <div className="map-toolbar">
        <div>
          <p className="eyebrow">WORLD MAP</p>
          <h3>{metadata?.name ?? '地图'}</h3>
        </div>
        <form
          className="map-search"
          onSubmit={(event) => void submitSearch(event)}
        >
          <input
            aria-label="搜索地图对象"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="搜索城市或军队"
          />
          <button className="button" type="submit">
            搜索
          </button>
        </form>
        <span className="muted">
          {movingArmy
            ? `选择 ${movingArmy.name} 的目标地块`
            : '滚轮缩放 · 拖动平移 · 点击地块'}
        </span>
      </div>
      {results.length > 0 && (
        <div className="search-results">
          {results.map((result) => (
            <button
              type="button"
              key={`${result.type}-${result.id}`}
              onClick={() => focusResult(result)}
            >
              {result.type} · {result.name}
            </button>
          ))}
        </div>
      )}
      {error && <p className="form-error">{error}</p>}
      <div className="map-layout">
        <canvas
          ref={canvasRef}
          className="hex-map"
          onPointerDown={(event) => {
            dragRef.current = {
              x: event.clientX,
              y: event.clientY,
              moved: false,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (!drag) return;
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 2) drag.moved = true;
            drag.x = event.clientX;
            drag.y = event.clientY;
            setView((current) => ({
              ...current,
              offsetX: current.offsetX + dx,
              offsetY: current.offsetY + dy,
            }));
          }}
          onPointerUp={(event) => {
            const drag = dragRef.current;
            dragRef.current = null;
            if (drag?.moved) return;
            const rect = event.currentTarget.getBoundingClientRect();
            const coordinate = screenToAxial(
              event.clientX - rect.left,
              event.clientY - rect.top,
              view,
              HEX_SIZE,
            );
            void selectTile(
              viewport?.tiles.find(
                (tile) => tile.q === coordinate.q && tile.r === coordinate.r,
              ),
            );
          }}
        />
        <aside className="tile-panel">
          {!selected && <p className="muted">选择一个地块查看详情。</p>}
          {selected && (
            <>
              <div className="tile-panel__title">
                <h3>
                  {selected.regionName ?? `地块 ${selected.q},${selected.r}`}
                </h3>
                <span className="tag">
                  {selected.terrainName ?? '未知地形'}
                </span>
              </div>
              <dl>
                <dt>坐标</dt>
                <dd>
                  {selected.q}, {selected.r}
                </dd>
                <dt>省份</dt>
                <dd>{selected.provinceName ?? '未知'}</dd>
                <dt>控制</dt>
                <dd>{selected.controllerCountryName ?? '未知'}</dd>
                <dt>移动消耗</dt>
                <dd>{selected.movementCost ?? '未知'}</dd>
                <dt>地图认知</dt>
                <dd>
                  {discoveryStateNames[selected.discoveryState]}
                  {selected.observedWorldVersion !== null &&
                    ` · 世界版本 ${selected.observedWorldVersion}`}
                </dd>
                <dt>城市</dt>
                <dd>
                  {selected.cities.map((city) => city.name).join('、') || '无'}
                </dd>
                <dt>军队</dt>
                <dd>
                  {selected.armies.length === 0
                    ? '无'
                    : selected.armies.map((army) => (
                        <span className="army-entry" key={army.id}>
                          {army.name ?? '未确认部队'} ({formatStrength(army)})
                          {army.outdated && ' · 已过时'}
                          {canEdit && (
                            <button
                              type="button"
                              onClick={() =>
                                setMovingArmy({
                                  id: army.id,
                                  name: army.name ?? '未确认部队',
                                })
                              }
                            >
                              移动
                            </button>
                          )}
                        </span>
                      ))}
                </dd>
              </dl>
              {canEdit && (
                <div className="map-editor">
                  <h4>主持人编辑</h4>
                  <label>
                    控制国家
                    <select
                      value={selected.controllerCountryId ?? ''}
                      onChange={(event) =>
                        void refreshSelected(
                          updateTileControl(
                            game.id,
                            selected.id,
                            event.target.value || null,
                          ),
                        )
                      }
                    >
                      <option value="">无</option>
                      {countries.map((country) => (
                        <option key={country.id} value={country.id}>
                          {country.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!cityName) return;
                      void refreshSelected(
                        createCity(game.id, {
                          tileId: selected.id,
                          name: cityName,
                          countryId: selected.controllerCountryId,
                        }),
                      );
                      setCityName('');
                    }}
                  >
                    <input
                      aria-label="新城市名称"
                      value={cityName}
                      onChange={(event) => setCityName(event.target.value)}
                      placeholder="新城市名称"
                    />
                    <button className="button" type="submit">
                      创建城市
                    </button>
                  </form>
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!armyName || !editCountryId) return;
                      void refreshSelected(
                        createArmy(game.id, {
                          tileId: selected.id,
                          name: armyName,
                          countryId: editCountryId,
                          strength: armyStrength,
                        }),
                      );
                      setArmyName('');
                    }}
                  >
                    <input
                      aria-label="新军队名称"
                      value={armyName}
                      onChange={(event) => setArmyName(event.target.value)}
                      placeholder="新军队名称"
                    />
                    <input
                      aria-label="军队兵力"
                      type="number"
                      min={0}
                      value={armyStrength}
                      onChange={(event) =>
                        setArmyStrength(Number(event.target.value))
                      }
                    />
                    <select
                      aria-label="军队所属国家"
                      value={editCountryId}
                      onChange={(event) => setEditCountryId(event.target.value)}
                    >
                      {countries.map((country) => (
                        <option key={country.id} value={country.id}>
                          {country.name}
                        </option>
                      ))}
                    </select>
                    <button className="button" type="submit">
                      创建军队
                    </button>
                  </form>
                </div>
              )}
            </>
          )}
        </aside>
      </div>
    </section>
  );
}
