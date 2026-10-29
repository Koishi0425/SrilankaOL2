import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

export const mobileQuery =
  '(max-width: 760px), (max-width: 1000px) and (max-height: 500px)';
function subscribe(callback: () => void) {
  const media = window.matchMedia?.(mobileQuery);
  media?.addEventListener('change', callback);
  return () => media?.removeEventListener('change', callback);
}
export function useMobile() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia?.(mobileQuery).matches ?? false,
    () => false,
  );
}

// Size the application to the visible area on browsers whose keyboard overlays
// the layout viewport. Pinch-zoom remains available and does not resize the app.
export function useMobileViewport() {
  const mobile = useMobile();
  useEffect(() => {
    if (!mobile) return;
    const viewport = window.visualViewport;
    const update = () => {
      if (!viewport || viewport.scale === 1) {
        document.documentElement.style.setProperty(
          '--mobile-height',
          `${viewport?.height ?? window.innerHeight}px`,
        );
        document.documentElement.style.setProperty(
          '--mobile-top',
          `${viewport?.offsetTop ?? 0}px`,
        );
      }
    };
    update();
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    return () => {
      viewport?.removeEventListener('resize', update);
      viewport?.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      document.documentElement.style.removeProperty('--mobile-height');
      document.documentElement.style.removeProperty('--mobile-top');
    };
  }, [mobile]);
  return mobile;
}

// Both panes stay mounted so returning to the list never destroys editor state.
export function useMobileDetail(initial = false) {
  const [detail, setDetail] = useState(initial);
  const mobile = useMobile();
  const paneRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!mobile) return;
    const target = paneRef.current?.querySelector<HTMLElement>(
      detail ? '.mobile-back' : '.center-list__active, .center-list button',
    );
    target?.focus({ preventScroll: true });
  }, [detail, mobile]);
  return {
    detail,
    paneRef,
    open: useCallback(() => setDetail(true), []),
    back: useCallback(() => setDetail(false), []),
    pane: detail ? 'detail' : 'list',
  };
}

export function MobileBack({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button type="button" className="mobile-back" onClick={onClick}>
      ← {children}
    </button>
  );
}
