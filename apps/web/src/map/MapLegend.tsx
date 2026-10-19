import type { CountrySummary, MapTileSummary } from '@srilanka/contracts';
import {
  discoveryStyles,
  mapModes,
  terrainSymbols,
  tileAppearance,
  type MapMode,
} from './map-appearance.js';

export function MapLegend({
  mode,
  countries,
  tiles,
  onClose,
}: {
  mode: MapMode;
  countries: CountrySummary[];
  tiles: MapTileSummary[];
  onClose: () => void;
}) {
  const countriesInView = new Map<string, string>();
  for (const tile of tiles) {
    const appearance = tileAppearance(tile, mode, countries);
    const name = tile.legalOwnerCountryName;
    if (appearance.group && name) countriesInView.set(name, appearance.color);
    if (appearance.occupation?.name)
      countriesInView.set(
        appearance.occupation.name,
        appearance.occupation.color,
      );
  }
  return (
    <aside className="map-legend" aria-label="地图图例">
      <header>
        <strong>{mapModes[mode]}</strong>
        <button aria-label="关闭图例" onClick={onClose}>
          关闭
        </button>
      </header>
      {mode === 'political' && (
        <>
          <div className="map-legend-rows">
            {[...countriesInView].map(([name, color]) => (
              <span key={name}>
                <i style={{ backgroundColor: color }} />
                {name}
              </span>
            ))}
          </div>
          <p className="map-occupation-key">
            <i aria-hidden="true" />
            底色为归属国，细斜纹为占领方。
          </p>
        </>
      )}
      {mode === 'knowledge' && (
        <div className="map-legend-rows">
          {Object.entries(discoveryStyles).map(([key, item]) => (
            <span key={key}>
              <i style={{ backgroundColor: item.color }} />
              {item.label}
            </span>
          ))}
        </div>
      )}
      <div className="map-terrain-key">
        {Object.entries(terrainSymbols).map(([key, symbol]) => (
          <span key={key}>
            <svg viewBox="-18 -16 36 32" aria-hidden="true">
              <path d={symbol.path} />
            </svg>
            {symbol.name}
          </span>
        ))}
      </div>
      <p>地形符号在各模式中保留。圆点为城市，方块为军队。</p>
    </aside>
  );
}
