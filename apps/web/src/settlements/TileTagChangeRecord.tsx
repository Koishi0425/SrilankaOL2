import type { SettlementStateChange } from '@srilanka/contracts';

export function TileTagChangeRecord({
  change,
  prefix = '',
}: {
  change: Extract<SettlementStateChange, { kind: 'TileTag' }>;
  prefix?: string;
}) {
  const { tag } = change;
  const percent = (value: number) => `${value > 0 ? '+' : ''}${value}%`;
  return (
    <span>
      {prefix}
      {change.summary}
      <br />
      {change.operation === 'Remove' ? (
        '发布时移除该同名状态及其效果。'
      ) : (
        <>
          税收贡献 {percent(tag.taxPercent)} · 生产贡献{' '}
          {percent(tag.productionPercent)} ·{' '}
          {tag.duration === null
            ? '持续至主持人移除'
            : `持续 ${tag.duration} 回合`}{' '}
          · {tag.blocksObservation ? '遮蔽实时视野' : '不遮蔽实时视野'}
        </>
      )}
    </span>
  );
}
