import type { TileTagSpec, TileDetails } from '@srilanka/contracts';
export const emptyTileTag: TileTagSpec = {
  name: '',
  description: '',
  taxPercent: 0,
  productionPercent: 0,
  blocksObservation: false,
  duration: 1,
};
export function TileTagFields({
  value,
  onChange,
  disabled = false,
}: {
  value: TileTagSpec;
  onChange: (value: TileTagSpec) => void;
  disabled?: boolean;
}) {
  const update = (patch: Partial<TileTagSpec>) =>
    onChange({ ...value, ...patch });
  return (
    <fieldset className="tile-tag-fields" disabled={disabled}>
      <label>
        状态预设
        <select
          value=""
          onChange={(e) => {
            const presets: Record<string, Partial<TileTagSpec>> = {
              damage: { name: '遭到破坏', productionPercent: -50 },
              harvest: { name: '丰收', productionPercent: 25 },
              mist: { name: '浓雾', blocksObservation: true },
            };
            onChange({ ...emptyTileTag, ...presets[e.target.value] });
          }}
        >
          <option value="">自定义／选择预设</option>
          <option value="damage">遭到破坏</option>
          <option value="harvest">丰收</option>
          <option value="mist">浓雾</option>
        </select>
      </label>
      <label>
        状态名称
        <input
          maxLength={60}
          value={value.name}
          onChange={(e) => update({ name: e.target.value })}
        />
      </label>
      <label>
        状态说明
        <textarea
          rows={2}
          maxLength={2000}
          value={value.description}
          onChange={(e) => update({ description: e.target.value })}
        />
      </label>
      <p className="muted">
        当前效果：
        {[
          value.taxPercent ? `税收贡献 ${value.taxPercent}%` : '',
          value.productionPercent ? `生产贡献 ${value.productionPercent}%` : '',
          value.blocksObservation ? '遮蔽实时视野' : '',
        ]
          .filter(Boolean)
          .join(' · ') || '仅作叙事标记'}
      </p>
      <details>
        <summary>效果与高级设置</summary>
        <div className="map-fields">
          <label>
            税收贡献调整（%）
            <input
              type="number"
              min={-100}
              max={300}
              step={1}
              value={value.taxPercent}
              onChange={(e) => update({ taxPercent: Number(e.target.value) })}
            />
          </label>
          <label>
            生产贡献调整（%）
            <input
              type="number"
              min={-100}
              max={300}
              step={1}
              value={value.productionPercent}
              onChange={(e) =>
                update({ productionPercent: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={value.blocksObservation}
            onChange={(e) => update({ blocksObservation: e.target.checked })}
          />
          遮蔽当地实时视野
        </label>
      </details>
      <label>
        持续回合
        <select
          value={value.duration ?? 'permanent'}
          onChange={(e) =>
            update({
              duration:
                e.target.value === 'permanent' ? null : Number(e.target.value),
            })
          }
        >
          {[1, 2, 3, 4, 8, 12, 20, 40].map((n) => (
            <option value={n} key={n}>
              {n} 回合
            </option>
          ))}
          <option value="permanent">直到主持人移除</option>
        </select>
      </label>
      <p className="muted">
        同名状态覆盖更新；不同状态的修正相加，每格最终贡献限制在
        0%–400%。状态随侦察记录更新。
      </p>
    </fieldset>
  );
}
export function TileTags({ tile }: { tile: TileDetails }) {
  if (tile.discoveryState === 'Unknown') return null;
  return (
    <section className="tile-tags" aria-label="地块状态">
      <h4>
        地块状态
        {tile.discoveryState === 'Mapped' && tile.dynamicKnown
          ? ' · 上次记录'
          : ''}
      </h4>
      {(tile.tags ?? []).length ? (
        tile.tags!.map((tag) => (
          <article key={tag.id}>
            <strong className="tag">{tag.name}</strong>
            {tag.description && <p>{tag.description}</p>}
            <small>
              {[
                tag.taxPercent
                  ? `税收贡献 ${tag.taxPercent > 0 ? '+' : ''}${tag.taxPercent}%`
                  : '',
                tag.productionPercent
                  ? `生产贡献 ${tag.productionPercent > 0 ? '+' : ''}${tag.productionPercent}%`
                  : '',
                tag.blocksObservation ? '遮蔽实时视野' : '',
              ]
                .filter(Boolean)
                .join(' · ') || '叙事状态'}{' '}
              · 第 {tag.startsSequence} 回合起
              {tag.endsSequence !== null
                ? `，至第 ${tag.endsSequence} 回合`
                : ''}
            </small>
          </article>
        ))
      ) : (
        <p className="muted">
          {tile.discoveryState === 'Observed'
            ? '未观察到附加状态。'
            : tile.dynamicKnown
              ? '上次观察未记录附加状态。'
              : '尚无此地的状态情报。'}
        </p>
      )}
      {tile.discoveryState === 'Mapped' && tile.dynamicKnown && (
        <p className="muted">
          记录不代表当前仍然生效；再次侦察或进入有效视野后更新。
        </p>
      )}
    </section>
  );
}
