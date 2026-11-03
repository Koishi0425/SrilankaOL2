import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MobileDirectory, MobileNavigation } from './MobileNavigation.js';

afterEach(cleanup);

it.each([true, false])(
  'exposes AI assistance in the phone directory, including for non-hosts (host=%s)',
  (host) => {
    const navigate = vi.fn();
    render(
      <MobileDirectory
        host={host}
        observer={!host}
        preparing={false}
        readOnly={false}
        preview={false}
        onNavigate={navigate}
        onCountry={vi.fn()}
        onOverview={vi.fn()}
        onExitPreview={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /AI 辅助/ }));
    expect(navigate).toHaveBeenCalledWith('assistant');
  },
);

it('marks the phone directory as current while AI assistance is open', () => {
  render(
    <MobileNavigation
      page="assistant"
      more={false}
      host={false}
      observer={false}
      preview={false}
      readOnly={false}
      unread={0}
      onNavigate={vi.fn()}
      onMore={vi.fn()}
    />,
  );
  expect(screen.getByRole('button', { name: '全部功能' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

it('keeps private feature entry points out of the player map preview', () => {
  render(
    <MobileDirectory
      host
      observer={false}
      preparing={false}
      readOnly={false}
      preview
      onNavigate={vi.fn()}
      onCountry={vi.fn()}
      onOverview={vi.fn()}
      onExitPreview={vi.fn()}
    />,
  );
  expect(
    screen.queryByRole('button', { name: /AI 辅助/ }),
  ).not.toBeInTheDocument();
});
