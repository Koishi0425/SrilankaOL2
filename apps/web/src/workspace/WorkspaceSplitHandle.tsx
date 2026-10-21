import { useRef } from 'react';

export function WorkspaceSplitHandle({
  value,
  onChange,
}: {
  value: number;
  onChange: (value: number) => void;
}) {
  const bounds = useRef<{
    left: number;
    width: number;
    pointer: number;
  } | null>(null);
  function constrain(next: number, width: number) {
    const minimum = width ? Math.max(32, Math.ceil((480 / width) * 100)) : 32;
    const maximum = width
      ? Math.min(76, Math.floor(((width - 300) / width) * 100))
      : 76;
    return Math.max(minimum, Math.min(maximum, Math.round(next)));
  }
  function resize(clientX: number) {
    const rect = bounds.current;
    if (!rect?.width) return;
    onChange(constrain(((clientX - rect.left) / rect.width) * 100, rect.width));
  }
  return (
    <div
      className="workspace-split-handle"
      role="separator"
      aria-label="调整面板与地图宽度"
      aria-orientation="vertical"
      aria-valuemin={32}
      aria-valuemax={76}
      aria-valuenow={value}
      aria-valuetext={`面板占 ${value}%`}
      tabIndex={0}
      title="拖动调整宽度，双击还原"
      onDoubleClick={() => onChange(52)}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 5 : 2;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const width =
            event.currentTarget
              .closest('.strategy-main')
              ?.getBoundingClientRect().width ?? 0;
          onChange(
            constrain(
              value + (event.key === 'ArrowRight' ? step : -step),
              width,
            ),
          );
        } else if (event.key === 'Home') {
          event.preventDefault();
          onChange(52);
        }
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        const container = event.currentTarget.closest('.strategy-main');
        if (!container) return;
        const rect = container.getBoundingClientRect();
        bounds.current = {
          left: rect.left,
          width: rect.width,
          pointer: event.pointerId,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.preventDefault();
      }}
      onPointerMove={(event) => {
        if (bounds.current?.pointer === event.pointerId) resize(event.clientX);
      }}
      onPointerUp={(event) => {
        if (bounds.current?.pointer !== event.pointerId) return;
        resize(event.clientX);
        bounds.current = null;
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => {
        bounds.current = null;
      }}
      onLostPointerCapture={() => {
        bounds.current = null;
      }}
    />
  );
}
