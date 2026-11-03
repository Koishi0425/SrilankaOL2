import {
  Component,
  Suspense,
  lazy,
  useState,
  type FunctionComponent,
  type ReactNode,
} from 'react';
import { LoadingSkeleton } from './LoadingSkeleton.js';

class FeatureBoundary extends Component<
  { children: ReactNode; onRetry: () => void },
  { failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    return this.state.failed ? (
      <div role="alert" className="empty-state">
        <p>此功能暂时无法打开，请重试。</p>
        <button type="button" onClick={this.props.onRetry}>
          重新加载此功能
        </button>
        <p className="muted">
          若网站刚刚更新，请先保存正在编辑的内容，再刷新页面。
        </p>
      </div>
    ) : (
      this.props.children
    );
  }
}

/** Retry only this feature, preserving drafts in other mounted panels. */
export function lazyFeature<Props extends object>(
  load: () => Promise<{ default: FunctionComponent<Props> }>,
  label: string,
) {
  let pending: ReturnType<typeof load> | undefined;
  const loadOnce = () => {
    pending ??= load().catch((error: unknown) => {
      pending = undefined;
      throw error;
    });
    return pending;
  };
  let currentContent = lazy(loadOnce);
  function LazyFeature(props: Props) {
    const [{ content, attempt }, setContent] = useState(() => ({
      content: currentContent,
      attempt: 0,
    }));
    const Content = content as FunctionComponent<Props>;
    return (
      <FeatureBoundary
        key={attempt}
        onRetry={() => {
          currentContent = lazy(loadOnce);
          setContent({ content: currentContent, attempt: attempt + 1 });
        }}
      >
        <Suspense fallback={<LoadingSkeleton label={label} />}>
          <Content {...props} />
        </Suspense>
      </FeatureBoundary>
    );
  }
  return Object.assign(LazyFeature, {
    // Pointer/keyboard intent warms code only; no panel is mounted or data read.
    preload: () => {
      void loadOnce().catch(() => undefined);
    },
  });
}
