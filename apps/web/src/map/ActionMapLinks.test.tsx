import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { ActionMapLinks } from './ActionMapLinks.js';
afterEach(cleanup);
it('keeps a missing map target recoverable and displays the failure beside its link', async () => {
  const locate = vi
    .fn()
    .mockRejectedValueOnce(new Error('该省份暂无可定位的地理记录。'))
    .mockResolvedValueOnce(undefined);
  render(
    <ActionMapLinks
      refs={[
        {
          refKind: 'Target',
          objectType: 'Province',
          objectId: 'old',
          label: '旧省份',
        },
      ]}
      onLocate={locate}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: '旧省份' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('暂无可定位');
  fireEvent.click(screen.getByRole('button', { name: '旧省份' }));
  expect(locate).toHaveBeenCalledTimes(2);
});
