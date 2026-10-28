import { type FormEvent, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CountrySummary,
  GameSummary,
  MapMetadata,
  MapObjectLocation,
  MapSearchResult,
  MapTileSummary,
  MapViewportData,
  TileDetails,
} from '@srilanka/contracts';

import { isGameReadOnly } from '@srilanka/contracts';
import { LoadingSkeleton } from '../ui/LoadingSkeleton.js';
import {
  ApiRequestError,
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
  fitMap,
  fitTiles,
  screenToAxial,
  splitViewport,
  visibleBounds,
  zoomAt,
  type ViewTransform,
} from './hex-math.js';
import { MapSetupPanel, type MapRevealSeed } from './MapSetupPanel.js';
import { MapHistory } from './MapHistory.js';
import { MapLegend } from './MapLegend.js';
import { TileContextPanel, type ProvinceScope } from './TileContextPanel.js';
import type { MapActionIntent } from './map-actions.js';
import {
  drawOccupation,
  drawTerrain,
  fogOpacity,
  mapModes,
  tileAppearance,
  type MapMode,
} from './map-appearance.js';

const HEX_SIZE = 27;

const discoveryStateNames: Record<MapTileSummary['discoveryState'], string> = {
  Unknown: '未知',
  Rumored: '传闻',
  Discovered: '已发现',
  Mapped: '已测绘',
  Observed: '当前可见',
  Outdated: '旧情报',
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
  onCreateAction,
  compact = false,
  active = true,
  revealSeed,
  onReturnSettlement,
  tileFocus,
  overlay = false,
  onInspectTile,
  showSetupWhenMissing = true,
  showDetails = true,
  countryId,
  returnTarget,
}: {
  game: GameSummary;
  countries: CountrySummary[];
  previewMemberId?: string;
  onCreateAction?: (tile: TileDetails, intent?: MapActionIntent) => void;
  countryId?: string;
  returnTarget?: { label: string; onReturn: () => void };
  compact?: boolean;
  active?: boolean;
  revealSeed?: MapRevealSeed;
  onReturnSettlement?: () => void;
  tileFocus?: MapObjectLocation & { key: number };
  overlay?: boolean;
  onInspectTile?: () => void;
  showSetupWhenMissing?: boolean;
  showDetails?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const searchResults = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    id: number;
    x: number;
    y: number;
    startX: number;
    startY: number;
    moved: boolean;
  } | null>(null);
  const fittedMap = useRef('');
  const autoFit = useRef(true);
  const previousSize = useRef<{ width: number; height: number } | null>(null);
  const searchRequest = useRef(0);
  const mutationPending = useRef(false);
  const selectionRequest = useRef(0);
  const consumedFocus = useRef<number | undefined>(undefined);
  const fittedScopeFocus = useRef<number | undefined>(undefined);
  const [metadata, setMetadata] = useState<MapMetadata | null>(null);
  const [missingMap, setMissingMap] = useState(false);
  const [viewport, setViewport] = useState<MapViewportData | null>(null);
  const [selected, setSelected] = useState<TileDetails | null>(null);
  const [provinceScope, setProvinceScope] = useState<ProvinceScope>([]);
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
  const [searchState, setSearchState] = useState<'idle' | 'loading' | 'done'>(
    'idle',
  );
  const [hovered, setHovered] = useState<MapTileSummary | null>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [destination, setDestination] = useState<MapTileSummary | null>(null);
  const [cityName, setCityName] = useState('');
  const [armyName, setArmyName] = useState('');
  const [armyStrength, setArmyStrength] = useState(1000);
  const [editCountryId, setEditCountryId] = useState(countries[0]?.id ?? '');
  const [movingArmy, setMovingArmy] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [editing, setEditing] = useState(false);
  const [setupOpened, setSetupOpened] = useState(false);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [layer, setLayer] = useState<MapMode>('political');
  const [legendOpen, setLegendOpen] = useState(false);
  const [correcting, setCorrecting] = useState(false);
  const [correctionReason, setCorrectionReason] = useState('');
  const canEdit =
    !isGameReadOnly(game.status) &&
    !previewMemberId &&
    (game.role === 'Host' || game.role === 'Administrator');
  const showingEditor = canEdit && editing && showDetails;
  const preparing =
    game.currentQuarter.state === 'Preparing' && game.status === 'Preparing';
  const canChangeTruth =
    canEdit && (preparing || (correcting && !!correctionReason.trim()));
  const correction = preparing
    ? {}
    : {
        correctionReason: correctionReason.trim(),
        expectedRevision: metadata?.revision,
      };
  useEffect(() => {
    if (editing) setSetupOpened(true);
  }, [editing]);
  useEffect(() => {
    if (!editCountryId && countries[0]) setEditCountryId(countries[0].id);
  }, [countries, editCountryId]);
  const fit = useMemo(
    () =>
      metadata
        ? fitMap(
            metadata.width,
            metadata.height,
            size.width,
            size.height,
            HEX_SIZE,
            metadata.maxZoom,
          )
        : null,
    [metadata, size],
  );
  const minZoom = Math.min(metadata?.minZoom ?? 0.5, fit?.scale ?? 0.5);

  function zoom(
    factor: number,
    point = { x: size.width / 2, y: size.height / 2 },
  ) {
    autoFit.current = false;
    setView((current) =>
      zoomAt(current, point, factor, minZoom, metadata?.maxZoom ?? 3),
    );
  }

  function closeDetails() {
    ++selectionRequest.current;
    setSelected(null);
    setMovingArmy(null);
    setDestination(null);
    canvasRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    if (!showDetails) {
      setMovingArmy(null);
      setDestination(null);
    }
  }, [showDetails]);

  useEffect(() => {
    if (!active || !showDetails) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        (event.target as HTMLElement)?.tagName === 'SELECT'
      )
        return;
      if (searchState !== 'idle') {
        ++searchRequest.current;
        setSearchState('idle');
      } else if (movingArmy) {
        setMovingArmy(null);
        setDestination(null);
      } else if (legendOpen) {
        setLegendOpen(false);
      } else if (selected) closeDetails();
      else return;
      event.preventDefault();
    };
    window.addEventListener('keydown', escape);
    return () => window.removeEventListener('keydown', escape);
  });

  useEffect(() => {
    if (!active || !metadata || !fit) return;
    if (fittedMap.current !== metadata.id) {
      fittedMap.current = metadata.id;
      autoFit.current = true;
      setView(fit);
    } else if (autoFit.current) {
      setView(fit);
    } else if (previousSize.current) {
      const before = previousSize.current;
      // Preserve the viewed location when a panel opens or the window resizes.
      setView((current) => ({
        ...current,
        offsetX: current.offsetX + (size.width - before.width) / 2,
        offsetY: current.offsetY + (size.height - before.height) / 2,
      }));
    }
    previousSize.current = size;
  }, [active, metadata?.id, size]);

  useEffect(() => {
    if (!active) return;
    let live = true;
    const load = () => {
      if (document.hidden) return;
      void fetchMap(game.id)
        .then((next) => {
          if (live) {
            setMissingMap(false);
            setMetadata((current) =>
              current?.revision === next.revision &&
              current?.id === next.id &&
              current?.viewCountryId === next.viewCountryId &&
              current?.currentWorldVersion === next.currentWorldVersion
                ? current
                : next,
            );
          }
        })
        .catch((reason: unknown) => {
          if (!live) return;
          if (
            reason instanceof ApiRequestError &&
            reason.code === 'MAP_NOT_FOUND'
          ) {
            setMissingMap(true);
            setMetadata(null);
            setEditing(
              canEdit &&
                game.currentQuarter.state === 'Preparing' &&
                showSetupWhenMissing,
            );
            setError('');
            return;
          }
          setError(reason instanceof Error ? reason.message : '地图尚未初始化');
        });
    };
    load();
    const timer = window.setInterval(load, 5000);
    document.addEventListener('visibilitychange', load);
    return () => {
      live = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [
    active,
    canEdit,
    game.id,
    game.currentQuarter.state,
    revision,
    showSetupWhenMissing,
  ]);

  useEffect(() => {
    if (revealSeed) setEditing(true);
  }, [revealSeed]);

  useEffect(() => {
    const resize = () => {
      const canvas = canvasRef.current;
      if (canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0)
        setSize({
          width: canvas.clientWidth,
          height: canvas.clientHeight,
        });
    };
    resize();
    const observer = new ResizeObserver(resize);
    if (canvasRef.current) observer.observe(canvasRef.current);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = canvas.getBoundingClientRect();
      const delta =
        event.deltaY *
        (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? size.height : 1);
      zoom(Math.exp(-Math.max(-100, Math.min(100, delta)) * 0.002), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    canvas.addEventListener('wheel', handleWheel, { passive: false });
    return () => canvas.removeEventListener('wheel', handleWheel);
  }, [metadata?.maxZoom, minZoom, size]);

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
    if (
      !active ||
      !metadata ||
      bounds.minQ > bounds.maxQ ||
      bounds.minR > bounds.maxR
    )
      return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void Promise.all(
        splitViewport(bounds).map((part) =>
          fetchMapViewport(game.id, part, controller.signal, previewMemberId),
        ),
      )
        .then((parts) => {
          if (!controller.signal.aborted && parts[0])
            setViewport({
              ...parts[0],
              bounds,
              tiles: parts.flatMap((part) => part.tiles),
            });
        })
        .catch((reason: unknown) => {
          if (
            !controller.signal.aborted &&
            !(reason instanceof DOMException && reason.name === 'AbortError')
          ) {
            setError(reason instanceof Error ? reason.message : '地图加载失败');
          }
        });
    }, 100);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [active, bounds, game.id, metadata, previewMemberId, revision]);

  const selectedId = selected?.id;
  useEffect(() => {
    if (!active || !selectedId) return;
    let live = true;
    void fetchTile(game.id, selectedId, previewMemberId)
      .then((tile) => {
        if (live) setSelected(tile);
      })
      .catch((cause: unknown) => {
        if (live)
          setError(cause instanceof Error ? cause.message : '地块读取失败');
      });
    return () => {
      live = false;
    };
  }, [active, game.id, selectedId, metadata, previewMemberId]);

  useEffect(() => {
    ++selectionRequest.current;
    ++searchRequest.current;
    setViewport(null);
    setSelected(null);
    setMovingArmy(null);
    setResults([]);
    setSearch('');
    setSearchState('idle');
    setDestination(null);
    setHovered(null);
    setError('');
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
    context.fillStyle = '#e8ede9';
    context.fillRect(0, 0, size.width, size.height);
    const tiles = viewport?.tiles ?? [];
    const appearances = new Map(
      tiles.map((tile) => [tile.id, tileAppearance(tile, layer, countries)]),
    );
    const byPosition = new Map(
      tiles.map((tile) => [`${tile.q},${tile.r}`, tile]),
    );
    for (const tile of tiles) {
      const point = axialToPixel(tile.q, tile.r, HEX_SIZE);
      const x = view.offsetX + point.x * view.scale;
      const y = view.offsetY + point.y * view.scale;
      const radius = HEX_SIZE * view.scale - 0.35;
      drawHex(context, x, y, radius);
      const appearance = appearances.get(tile.id)!;
      context.fillStyle = appearance.color;
      context.globalAlpha = 1;
      context.fill();
      if (appearance.occupation) {
        drawOccupation(
          context,
          appearance.occupation.color,
          x,
          y,
          radius,
          view.scale,
          view.offsetX + view.offsetY,
        );
        drawHex(context, x, y, radius);
      }
      context.globalAlpha = 1;
      context.strokeStyle =
        (canEdit && editing && selectedIds.includes(tile.id)) ||
        selected?.id === tile.id
          ? '#2563eb'
          : hovered?.id === tile.id
            ? '#748276'
            : 'rgba(53,73,64,.16)';
      context.lineWidth =
        (canEdit && editing && selectedIds.includes(tile.id)) ||
        selected?.id === tile.id
          ? 3
          : 1;
      context.stroke();
      if (appearance.group) {
        const neighbors = [
          [1, 0],
          [tile.r & 1, 1],
          [(tile.r & 1) - 1, 1],
          [-1, 0],
          [(tile.r & 1) - 1, -1],
          [tile.r & 1, -1],
        ];
        neighbors.forEach(([dq, dr], edge) => {
          const neighbor = byPosition.get(`${tile.q + dq!},${tile.r + dr!}`);
          if (
            !neighbor ||
            !appearances.get(neighbor.id)?.group ||
            appearances.get(neighbor.id)?.group === appearance.group
          )
            return;
          const a = (Math.PI / 180) * (edge * 60 - 30);
          const b = a + Math.PI / 3;
          context.beginPath();
          context.moveTo(x + radius * Math.cos(a), y + radius * Math.sin(a));
          context.lineTo(x + radius * Math.cos(b), y + radius * Math.sin(b));
          context.strokeStyle = 'rgba(39,57,48,.55)';
          context.lineWidth = Math.max(1, view.scale * 1.4);
          context.stroke();
        });
      }
      drawTerrain(context, tile, x, y, view.scale);
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
      if (showingEditor && view.scale > 1.1) {
        context.fillStyle = '#14201d';
        context.font = `${Math.max(9, 10 * view.scale)}px sans-serif`;
        context.textAlign = 'center';
        context.fillText(`${tile.q},${tile.r}`, x, y + 4);
      }
      const fog = fogOpacity(tile, layer);
      if (fog) {
        drawHex(context, x, y, radius);
        context.fillStyle = `rgba(18,32,26,${fog})`;
        context.fill();
      }
    }
    if (showDetails && !showingEditor) {
      const scope = new Set(provinceScope.map((tile) => `${tile.q},${tile.r}`));
      for (const tile of provinceScope) {
        const point = axialToPixel(tile.q, tile.r, HEX_SIZE);
        const x = view.offsetX + point.x * view.scale;
        const y = view.offsetY + point.y * view.scale;
        const radius = HEX_SIZE * view.scale;
        const neighbors = [
          [1, 0],
          [tile.r & 1, 1],
          [(tile.r & 1) - 1, 1],
          [-1, 0],
          [(tile.r & 1) - 1, -1],
          [tile.r & 1, -1],
        ];
        neighbors.forEach(([dq, dr], edge) => {
          if (scope.has(`${tile.q + dq!},${tile.r + dr!}`)) return;
          const neighbor = byPosition.get(`${tile.q + dq!},${tile.r + dr!}`);
          if (
            viewport?.viewMode !== 'Truth' &&
            (!neighbor || !neighbor.regionId)
          )
            return;
          const angle = (Math.PI / 180) * (edge * 60 - 30);
          context.beginPath();
          context.moveTo(
            x + radius * Math.cos(angle),
            y + radius * Math.sin(angle),
          );
          context.lineTo(
            x + radius * Math.cos(angle + Math.PI / 3),
            y + radius * Math.sin(angle + Math.PI / 3),
          );
          context.strokeStyle = '#466ea5';
          context.lineWidth = 2;
          context.stroke();
        });
      }
    }
    // Paint labels last so neighboring terrain cannot cover them. Only use
    // markers from the server's permission-filtered viewport.
    if (!showingEditor && view.scale >= 0.65) {
      const occupied: Array<{ x: number; y: number; width: number }> = [];
      context.font = '500 12px system-ui, sans-serif';
      context.textAlign = 'center';
      for (const tile of tiles) {
        const name = tile.cities[0]?.name;
        if (!name) continue;
        const point = axialToPixel(tile.q, tile.r, HEX_SIZE);
        const x = view.offsetX + point.x * view.scale;
        const y = view.offsetY + point.y * view.scale + 19;
        const width = context.measureText(name).width + 10;
        if (
          occupied.some(
            (box) =>
              Math.abs(box.y - y) < 20 &&
              Math.abs(box.x - x) < (box.width + width) / 2,
          )
        )
          continue;
        occupied.push({ x, y, width });
        context.fillStyle = 'rgba(253,253,249,.92)';
        context.fillRect(x - width / 2, y - 13, width, 18);
        context.fillStyle = '#293d35';
        context.fillText(name, x, y);
      }
    }
    const highlight = destination ?? selected;
    if (highlight) {
      const point = axialToPixel(highlight.q, highlight.r, HEX_SIZE);
      drawHex(
        context,
        view.offsetX + point.x * view.scale,
        view.offsetY + point.y * view.scale,
        HEX_SIZE * view.scale - 1,
      );
      context.strokeStyle = '#fff';
      context.lineWidth = 5;
      context.stroke();
      context.strokeStyle = '#245bb5';
      context.lineWidth = 2.5;
      context.stroke();
    }
  }, [
    canEdit,
    editing,
    layer,
    selectedIds,
    selected?.id,
    size,
    view,
    viewport,
    hovered?.id,
    destination,
    showingEditor,
    countries,
    provinceScope,
    showDetails,
  ]);

  async function selectTile(tile: MapTileSummary | undefined) {
    if (!tile || mutationPending.current) return;
    if (showingEditor) {
      setSelectedIds((current) =>
        current.includes(tile.id)
          ? current.filter((id) => id !== tile.id)
          : [...current, tile.id].slice(0, 2500),
      );
      return;
    }
    if (movingArmy) {
      setDestination(tile);
      return;
    }
    if (editing) setEditing(false);
    const request = ++selectionRequest.current;
    try {
      const next = await fetchTile(game.id, tile.id, previewMemberId);
      if (request !== selectionRequest.current) return;
      setSelected(next);
      onInspectTile?.();
      setError('');
    } catch (reason) {
      if (request !== selectionRequest.current) return;
      setError(reason instanceof Error ? reason.message : '地块读取失败');
    }
  }

  async function submitSearch(event: FormEvent) {
    event.preventDefault();
    if (!search.trim()) return;
    const request = ++searchRequest.current;
    setSearchState('loading');
    setResults([]);
    try {
      const found = await searchMap(game.id, search.trim(), previewMemberId);
      if (request !== searchRequest.current) return;
      setResults(found);
      setSearchState('done');
      setError('');
    } catch (reason) {
      if (request !== searchRequest.current) return;
      setSearchState('idle');
      setError(reason instanceof Error ? reason.message : '搜索失败');
    }
  }

  function focusResult(result: MapSearchResult, selectForEditing = true) {
    if (result.q === null || result.r === null) return;
    autoFit.current = false;
    canvasRef.current?.focus({ preventScroll: true });
    const point = axialToPixel(result.q, result.r, HEX_SIZE);
    setView((current) => ({
      ...current,
      offsetX: size.width / 2 - point.x * current.scale,
      offsetY: size.height / 2 - point.y * current.scale,
    }));
    setResults([]);
    setSearchState('idle');
    ++searchRequest.current;
    if (result.tileId) {
      if (showingEditor && selectForEditing) {
        setSelectedIds((current) =>
          current.includes(result.tileId!)
            ? current
            : [...current, result.tileId!].slice(0, 2500),
        );
        return;
      }
      if (editing) setEditing(false);
      const request = ++selectionRequest.current;
      void fetchTile(game.id, result.tileId, previewMemberId)
        .then((tile) => {
          if (request === selectionRequest.current) {
            if (movingArmy) setDestination(tile);
            else setSelected(tile);
            setError('');
            onInspectTile?.();
          }
        })
        .catch((cause: unknown) => {
          if (request === selectionRequest.current)
            setError(cause instanceof Error ? cause.message : '地块读取失败');
        });
    }
  }

  useEffect(() => {
    if (!active || !tileFocus || consumedFocus.current === tileFocus.key)
      return;
    consumedFocus.current = tileFocus.key;
    focusResult(
      {
        id: tileFocus.id,
        type: 'Tile',
        name: '',
        tileId: tileFocus.id,
        q: tileFocus.q,
        r: tileFocus.r,
      },
      false,
    );
  }, [active, tileFocus]);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (
      !active ||
      !showDetails ||
      !tileFocus?.scope?.length ||
      selected?.id !== tileFocus.id ||
      fittedScopeFocus.current === tileFocus.key ||
      !canvas ||
      size.width !== canvas.clientWidth ||
      size.height !== canvas.clientHeight
    )
      return;
    fittedScopeFocus.current = tileFocus.key;
    setView(
      fitTiles(
        tileFocus.scope,
        size.width,
        size.height,
        HEX_SIZE,
        metadata?.maxZoom ?? 3,
      ),
    );
  }, [active, showDetails, tileFocus, selected?.id, size, metadata?.maxZoom]);

  async function refreshSelected(
    action: () => Promise<TileDetails>,
  ): Promise<boolean> {
    if (mutationPending.current || !canChangeTruth) return false;
    mutationPending.current = true;
    setBusy(true);
    const request = ++selectionRequest.current;
    try {
      const tile = await action();
      if (request === selectionRequest.current) setSelected(tile);
      setRevision((value) => value + 1);
      if (request === selectionRequest.current) setError('');
      return true;
    } catch (reason) {
      if (request === selectionRequest.current)
        setError(reason instanceof Error ? reason.message : '地图编辑失败');
      return false;
    } finally {
      mutationPending.current = false;
      setBusy(false);
    }
  }

  return (
    <section
      className={`map-shell${compact ? ' map-shell--compact' : ''}${overlay ? ' map-shell--overlay' : ''}`}
    >
      {missingMap && !editing && <p className="muted">本局尚未设置地图。</p>}
      {!missingMap && !error && (!metadata || !viewport) && (
        <div className="map-loading">
          <LoadingSkeleton label="正在读取地图…" layout="map" />
        </div>
      )}
      <div className="map-toolbar-region">
        <div className="map-toolbar" hidden={!metadata}>
          {metadata && (
            <div className="map-modes" role="group" aria-label="地图显示">
              {Object.entries(mapModes).map(([value, name]) => (
                <button
                  key={value}
                  type="button"
                  aria-label={name}
                  title={name}
                  aria-pressed={layer === value}
                  onClick={() => setLayer(value as MapMode)}
                >
                  {
                    { political: '政治', terrain: '地形', knowledge: '情报' }[
                      value as MapMode
                    ]
                  }
                </button>
              ))}
            </div>
          )}
          {returnTarget && (
            <button onClick={returnTarget.onReturn}>
              {returnTarget.label}
            </button>
          )}
          {canEdit && metadata && (
            <button
              aria-pressed={editing}
              onClick={() => {
                setEditing(!editing);
                setMovingArmy(null);
                setDestination(null);
                onInspectTile?.();
              }}
            >
              {editing ? '收起工具' : preparing ? '布置地图' : '地图工具'}
            </button>
          )}
          {canEdit && !preparing && metadata && (
            <button
              aria-pressed={correcting}
              onClick={() => {
                setCorrecting(!correcting);
                setMovingArmy(null);
                setDestination(null);
                setCorrectionReason('');
              }}
            >
              {correcting ? '结束更正' : '即时更正'}
            </button>
          )}
          <form
            className="map-search"
            onSubmit={(event) => void submitSearch(event)}
          >
            <input
              ref={searchInput}
              aria-label="搜索地图对象"
              maxLength={120}
              type="search"
              value={search}
              onChange={(event) => {
                ++searchRequest.current;
                setSearch(event.target.value);
                setSearchState('idle');
                setResults([]);
              }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && results.length > 0) {
                  event.preventDefault();
                  searchResults.current
                    ?.querySelector<HTMLButtonElement>('button')
                    ?.focus();
                }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  ++searchRequest.current;
                  setSearchState('idle');
                  setResults([]);
                }
              }}
              placeholder="搜索城市或军队"
            />
            <button
              className="button"
              type="submit"
              disabled={!search.trim() || searchState === 'loading'}
            >
              {searchState === 'loading' ? '搜索中…' : '搜索'}
            </button>
          </form>
        </div>
        {searchState === 'done' && (
          <div
            className="search-results"
            role="region"
            aria-label="地图搜索结果"
            ref={searchResults}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                setSearchState('idle');
                searchInput.current?.focus();
              }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                const buttons = [
                  ...event.currentTarget.querySelectorAll<HTMLButtonElement>(
                    'button',
                  ),
                ];
                const current = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                event.preventDefault();
                buttons[
                  (current +
                    (event.key === 'ArrowDown' ? 1 : -1) +
                    buttons.length) %
                    buttons.length
                ]?.focus();
              }
            }}
          >
            {results.length === 0 && (
              <p role="status">没有找到匹配的地点或军队。</p>
            )}
            {results.map((result) => (
              <button
                type="button"
                key={`${result.type}-${result.id}`}
                onClick={() => focusResult(result)}
              >
                {
                  { City: '城市', Army: '军队', Region: '地区', Tile: '地块' }[
                    result.type
                  ]
                }{' '}
                · {result.name}
              </button>
            ))}
            <button
              aria-label="关闭搜索结果"
              onClick={() => setSearchState('idle')}
            >
              关闭
            </button>
          </div>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}{' '}
          <button
            onClick={() => {
              setError('');
              setRevision((value) => value + 1);
            }}
          >
            刷新地图
          </button>
        </p>
      )}
      {canEdit && !preparing && correcting && (
        <div className="map-correction-bar">
          <label>
            即时更正原因
            <input
              maxLength={2000}
              value={correctionReason}
              onChange={(event) => setCorrectionReason(event.target.value)}
              disabled={busy}
            />
          </label>
          <span>
            此处修改立即生效并留记录。普通移动、占领与征兵请在回合结算中发布。
          </span>
        </div>
      )}
      {movingArmy && canChangeTruth && (
        <div className="map-move-bar" role="status">
          <span>
            <strong>{movingArmy.name}</strong> ·{' '}
            {destination
              ? `移至 ${destination.regionName ?? '地块'}（${destination.q}, ${destination.r}）`
              : '点击目标地块'}
          </span>
          <button
            className="button--primary"
            disabled={!destination || busy}
            onClick={async () => {
              if (!destination) return;
              if (
                await refreshSelected(() =>
                  moveArmy(game.id, movingArmy.id, destination.id, correction),
                )
              ) {
                setMovingArmy(null);
                setDestination(null);
              }
            }}
          >
            {busy ? '移动中…' : '确认移动'}
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setMovingArmy(null);
              setDestination(null);
            }}
          >
            取消
          </button>
        </div>
      )}
      <div
        className={`map-layout${showingEditor ? ' map-layout--editing' : ''}${overlay ? ' map-layout--overlay' : ''}${showDetails && (showingEditor || selected) ? ' map-layout--inspecting' : ''}`}
        hidden={missingMap && !editing}
      >
        {canEdit && (editing || setupOpened) && (
          <aside className="map-setup-panel" hidden={!showingEditor}>
            <MapSetupPanel
              correctionReason={correcting ? correctionReason : undefined}
              game={game}
              countries={countries}
              selectedIds={selectedIds}
              onSelection={setSelectedIds}
              seed={revealSeed}
              onReturn={onReturnSettlement}
              onChanged={(map) => {
                setMetadata(map);
                setRevision((value) => value + 1);
                setError('');
              }}
              onRectangle={async (rectangle) => {
                if (
                  rectangle.minQ > rectangle.maxQ ||
                  rectangle.minR > rectangle.maxR ||
                  (rectangle.maxQ - rectangle.minQ + 1) *
                    (rectangle.maxR - rectangle.minR + 1) >
                    2500
                )
                  throw new Error('请选择有效矩形，最多 2500 个地块。');
                const result = await fetchMapViewport(game.id, rectangle);
                setSelectedIds(result.tiles.map((tile) => tile.id));
              }}
            />
          </aside>
        )}
        <div className="map-stage">
          <canvas
            ref={canvasRef}
            className={`hex-map${dragging ? ' hex-map--dragging' : ''}${movingArmy || showingEditor ? ' hex-map--selecting' : ''}`}
            tabIndex={0}
            aria-label="交互地图：方向键平移，加减号缩放，0 查看全图"
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                if (movingArmy) {
                  setMovingArmy(null);
                  setDestination(null);
                } else closeDetails();
                event.preventDefault();
              } else if (event.key === '+' || event.key === '=') {
                event.preventDefault();
                zoom(1.25);
              } else if (event.key === '-') {
                event.preventDefault();
                zoom(0.8);
              } else if (event.key === '0' && fit) {
                event.preventDefault();
                autoFit.current = true;
                setView(fit);
              } else if (
                ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(
                  event.key,
                )
              ) {
                event.preventDefault();
                autoFit.current = false;
                setView((current) => ({
                  ...current,
                  offsetX:
                    current.offsetX +
                    (event.key === 'ArrowLeft'
                      ? 60
                      : event.key === 'ArrowRight'
                        ? -60
                        : 0),
                  offsetY:
                    current.offsetY +
                    (event.key === 'ArrowUp'
                      ? 60
                      : event.key === 'ArrowDown'
                        ? -60
                        : 0),
                }));
              }
            }}
            onPointerDown={(event) => {
              if (event.button !== 0 || !event.isPrimary) return;
              event.currentTarget.focus({ preventScroll: true });
              dragRef.current = {
                id: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                startX: event.clientX,
                startY: event.clientY,
                moved: false,
              };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) {
                const rect = event.currentTarget.getBoundingClientRect();
                const coordinate = screenToAxial(
                  event.clientX - rect.left,
                  event.clientY - rect.top,
                  view,
                  HEX_SIZE,
                );
                const tile =
                  viewport?.tiles.find(
                    (t) => t.q === coordinate.q && t.r === coordinate.r,
                  ) ?? null;
                setHovered((current) =>
                  current?.id === tile?.id ? current : tile,
                );
                return;
              }
              if (drag.id !== event.pointerId) return;
              if (
                !drag.moved &&
                Math.hypot(
                  event.clientX - drag.startX,
                  event.clientY - drag.startY,
                ) < 5
              )
                return;
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              drag.moved = true;
              autoFit.current = false;
              setDragging(true);
              setHovered(null);
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
              if (!drag || drag.id !== event.pointerId) return;
              dragRef.current = null;
              setDragging(false);
              if (event.currentTarget.hasPointerCapture(event.pointerId))
                event.currentTarget.releasePointerCapture(event.pointerId);
              if (
                drag.moved ||
                Math.hypot(
                  event.clientX - drag.startX,
                  event.clientY - drag.startY,
                ) >= 5
              )
                return;
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
            onPointerCancel={() => {
              dragRef.current = null;
              setDragging(false);
            }}
            onLostPointerCapture={() => {
              dragRef.current = null;
              setDragging(false);
            }}
            onPointerLeave={() => setHovered(null)}
          />
          {metadata && (
            <div className="map-view-controls" aria-label="地图视图工具">
              <button
                aria-label="放大地图"
                title="放大（+）"
                disabled={view.scale >= metadata.maxZoom}
                onClick={() => zoom(1.25)}
              >
                +
              </button>
              <button
                aria-label="缩小地图"
                title="缩小（−）"
                disabled={view.scale <= minZoom}
                onClick={() => zoom(0.8)}
              >
                −
              </button>
              <button
                title="查看全图（0）"
                onClick={() => {
                  if (fit) {
                    autoFit.current = true;
                    setView(fit);
                  }
                }}
              >
                全图
              </button>
              <button
                aria-expanded={legendOpen}
                onClick={() => setLegendOpen((open) => !open)}
              >
                图例
              </button>
            </div>
          )}
          {legendOpen && metadata && (
            <MapLegend
              mode={layer}
              countries={countries}
              tiles={viewport?.tiles ?? []}
              onClose={() => setLegendOpen(false)}
            />
          )}
          {hovered && !dragging && (
            <div className="map-hover-info">
              {hovered.regionName ??
                discoveryStateNames[hovered.discoveryState]}{' '}
              · {hovered.q}, {hovered.r}
              {hovered.terrainName ? ` · ${hovered.terrainName}` : ''}
            </div>
          )}
        </div>
        {!showingEditor && showDetails && (!overlay || selected) && (
          <aside className="tile-panel" aria-label="地块详情">
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
                  {overlay && (
                    <button aria-label="关闭地块详情" onClick={closeDetails}>
                      关闭
                    </button>
                  )}
                </div>
                <dl>
                  <dt>坐标</dt>
                  <dd>
                    {selected.q}, {selected.r}
                  </dd>
                  <dt>法理归属</dt>
                  <dd>
                    {selected.legalOwnerCountryName ??
                      (canEdit ? '无归属' : '未知')}
                  </dd>
                  <dt>实际控制</dt>
                  <dd>{selected.controllerCountryName ?? '未知'}</dd>
                  <dt>移动消耗</dt>
                  <dd>{selected.movementCost ?? '未知'}</dd>
                  <dt>地图认知</dt>
                  <dd>{discoveryStateNames[selected.discoveryState]}</dd>
                  <dt>城市</dt>
                  <dd>
                    {selected.cities.map((city) => city.name).join('、') ||
                      (['Unknown', 'Rumored'].includes(selected.discoveryState)
                        ? '未知'
                        : '无')}
                  </dd>
                  <dt>军队</dt>
                  <dd>
                    {selected.armies.length === 0
                      ? canEdit || selected.discoveryState === 'Observed'
                        ? '无'
                        : '未获知'
                      : selected.armies.map((army) => (
                          <span className="army-entry" key={army.id}>
                            {army.name ?? '未确认部队'} ({formatStrength(army)})
                            {army.outdated && ' · 已过时'}
                            {canChangeTruth && (
                              <button
                                type="button"
                                onClick={() => {
                                  setDestination(null);
                                  setMovingArmy({
                                    id: army.id,
                                    name: army.name ?? '未确认部队',
                                  });
                                }}
                              >
                                移动
                              </button>
                            )}
                          </span>
                        ))}
                  </dd>
                </dl>
                {selected.knowledgeNote && (
                  <p className="rules-text">{selected.knowledgeNote}</p>
                )}
                <TileContextPanel
                  key={`${selected.id}:${previewMemberId ?? ''}`}
                  gameId={game.id}
                  tile={selected}
                  countryId={countryId}
                  previewMemberId={previewMemberId}
                  active={active && showDetails}
                  refreshKey={`${game.currentQuarter.id}:${game.currentQuarter.currentWorldVersion}:${metadata?.revision}:${revision}`}
                  onScopeChange={setProvinceScope}
                  onCreateAction={
                    game.role === 'Player' && !previewMemberId
                      ? onCreateAction
                      : undefined
                  }
                />
                {canChangeTruth && (
                  <details className="map-editor">
                    <summary>
                      {preparing ? '编辑此地块' : '即时更正此地块'}
                    </summary>
                    <fieldset disabled={busy} className="map-editor-fields">
                      <label>
                        控制国家
                        <select
                          value={selected.controllerCountryId ?? ''}
                          onChange={(event) =>
                            void refreshSelected(() =>
                              updateTileControl(
                                game.id,
                                selected.id,
                                event.target.value || null,
                                correction,
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
                          void refreshSelected(() =>
                            createCity(game.id, {
                              ...correction,
                              tileId: selected.id,
                              name: cityName,
                              countryId: selected.controllerCountryId,
                            }),
                          ).then((saved) => {
                            if (saved) setCityName('');
                          });
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
                          void refreshSelected(() =>
                            createArmy(game.id, {
                              ...correction,
                              tileId: selected.id,
                              name: armyName,
                              countryId: editCountryId,
                              strength: armyStrength,
                            }),
                          ).then((saved) => {
                            if (saved) setArmyName('');
                          });
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
                          onChange={(event) =>
                            setEditCountryId(event.target.value)
                          }
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
                    </fieldset>
                  </details>
                )}
              </>
            )}
          </aside>
        )}
      </div>
      {metadata && (
        <MapHistory
          key={previewMemberId ?? 'self'}
          gameId={game.id}
          revision={metadata.revision}
          active={active}
          previewMemberId={previewMemberId}
        />
      )}
    </section>
  );
}
