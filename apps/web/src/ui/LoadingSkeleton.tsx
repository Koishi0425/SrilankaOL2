type Layout = 'content' | 'list' | 'messages' | 'table' | 'map';

/** Decorative shapes stay out of the accessibility tree; announce one status. */
export function LoadingSkeleton({
  label = '正在加载内容…',
  layout = 'content',
}: {
  label?: string;
  layout?: Layout;
}) {
  return (
    <div
      className={`loading-skeleton loading-skeleton--${layout}`}
      role="status"
      aria-label={label}
    >
      <span className="sr-only">{label}</span>
      <div className="loading-skeleton__shapes" aria-hidden="true">
        <span className="loading-skeleton__heading" />
        {Array.from({ length: layout === 'table' ? 5 : 3 }, (_, index) => (
          <div className="loading-skeleton__row" key={index}>
            <span />
            <span />
            <span />
          </div>
        ))}
      </div>
    </div>
  );
}
