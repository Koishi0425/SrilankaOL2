import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { mobileQuery, useMobileViewport } from './mobile.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Viewport() {
  return <span>{useMobileViewport() ? 'phone' : 'desktop'}</span>;
}

it('tracks the visible keyboard area, ignores pinch zoom and cleans up on desktop', () => {
  const media = Object.assign(new EventTarget(), { matches: true });
  const viewport = Object.assign(new EventTarget(), {
    height: 844,
    offsetTop: 0,
    scale: 1,
  });
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => media),
  );
  vi.stubGlobal('visualViewport', viewport);
  const page = render(<Viewport />);
  expect(window.matchMedia).toHaveBeenCalledWith(mobileQuery);
  expect(page.container).toHaveTextContent('phone');
  const style = document.documentElement.style;
  expect(style.getPropertyValue('--mobile-height')).toBe('844px');
  act(() => {
    viewport.height = 390;
    viewport.offsetTop = 20;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(style.getPropertyValue('--mobile-height')).toBe('390px');
  expect(style.getPropertyValue('--mobile-top')).toBe('20px');
  act(() => {
    viewport.scale = 2;
    viewport.height = 195;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(style.getPropertyValue('--mobile-height')).toBe('390px');
  act(() => {
    media.matches = false;
    media.dispatchEvent(new Event('change'));
  });
  expect(page.container).toHaveTextContent('desktop');
  expect(style.getPropertyValue('--mobile-height')).toBe('');
  expect(style.getPropertyValue('--mobile-top')).toBe('');
  act(() => {
    viewport.scale = 1;
    viewport.dispatchEvent(new Event('resize'));
  });
  expect(style.getPropertyValue('--mobile-height')).toBe('');
});
