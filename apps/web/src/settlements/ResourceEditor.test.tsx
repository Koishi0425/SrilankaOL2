import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { ResourceChange } from '@srilanka/contracts';
import { fetchNationalStatus } from '../api.js';
import { ResourceEditor } from './ResourceEditor.js';
vi.mock('../api.js', () => ({ fetchNationalStatus: vi.fn() }));
const country = {
  id: 'north',
  name: '北国',
  mapColor: '#000000',
  treasury: 100,
  manpower: 1000,
  resourceRevision: 3,
  controlledTileCount: 2,
  legalTileCount: 2,
  cities: [],
  armies: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    countries: [country],
    canSetBalances: false,
  });
});
afterEach(cleanup);
it('includes economic manpower in available funds and recalculates after corrections without duplicating income', async () => {
  const changed = vi.fn();
  let saved: ResourceChange[] = [];
  const automatic = {
    countryId: 'north',
    resource: 'Manpower' as const,
    amount: 300,
    expectedResourceRevision: 3,
  };
  const view = render(
    <ResourceEditor
      gameId="game"
      actionId={null}
      changes={saved}
      automaticResources={[automatic]}
      busy={false}
      active
      onChange={(next) => {
        saved = next;
        changed(next);
      }}
    />,
  );
  fireEvent.click(screen.getByText('资源收支'));
  await screen.findByRole('option', { name: '北国' });
  fireEvent.change(screen.getByLabelText('资源'), {
    target: { value: 'Manpower' },
  });
  fireEvent.change(
    screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
    { target: { value: '-1200' } },
  );
  fireEvent.change(screen.getByLabelText('原因'), {
    target: { value: '新兵动员' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
  expect(saved).toHaveLength(1);
  expect(saved[0]).toMatchObject({ amount: -1200, before: 1300, after: 100 });
  view.rerender(
    <ResourceEditor
      gameId="game"
      actionId={null}
      changes={saved}
      automaticResources={[{ ...automatic, amount: 400 }]}
      busy={false}
      active
      onChange={changed}
    />,
  );
  expect(screen.getByText(/1,400 → 200/)).toBeInTheDocument();
});
it('loads only when opened, adds signed costs, recalculates remaining entries after removal', async () => {
  const changed = vi.fn();
  function Harness() {
    const [changes, setChanges] = useState<ResourceChange[]>([]);
    return (
      <ResourceEditor
        gameId="game"
        actionId={null}
        changes={changes}
        busy={false}
        active
        onChange={(next) => {
          changed(next);
          setChanges(next);
        }}
      />
    );
  }
  render(<Harness />);
  expect(fetchNationalStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('资源收支'));
  await screen.findByRole('option', { name: '北国' });
  fireEvent.change(
    screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
    { target: { value: '20.15' } },
  );
  fireEvent.change(screen.getByLabelText('原因'), {
    target: { value: '税收' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
  fireEvent.change(
    screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
    { target: { value: '-30.1' } },
  );
  fireEvent.change(screen.getByLabelText('原因'), {
    target: { value: '建设' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
  expect(changed.mock.lastCall![0][1]).toMatchObject({
    before: 120.15,
    after: 90.05,
    expectedResourceRevision: 3,
  });
  fireEvent.click(screen.getByRole('button', { name: '移除收支：税收' }));
  expect(changed.mock.lastCall![0][0]).toMatchObject({
    before: 100,
    after: 69.9,
  });
});
it('blocks fractional manpower, overspending and adding onto stale baselines', async () => {
  const changed = vi.fn();
  const previous: ResourceChange = {
    id: 'old',
    actionId: null,
    countryId: 'north',
    countryName: '北国',
    resource: 'Treasury',
    amount: -5,
    reason: '旧支出',
    before: 100,
    after: 95,
    expectedResourceRevision: 2,
  };
  const view = render(
    <ResourceEditor
      gameId="game"
      actionId={null}
      changes={[]}
      busy={false}
      active
      onChange={changed}
    />,
  );
  fireEvent.click(screen.getByText('资源收支'));
  await screen.findByRole('option', { name: '北国' });
  fireEvent.change(screen.getByLabelText('资源'), {
    target: { value: 'Manpower' },
  });
  fireEvent.change(screen.getByLabelText('原因'), {
    target: { value: '征募' },
  });
  fireEvent.change(
    screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
    { target: { value: '-1001' } },
  );
  fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('人力不能为负');
  fireEvent.change(
    screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
    { target: { value: '1.5' } },
  );
  fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
  expect(screen.getByRole('alert')).toHaveTextContent('人力为整数');
  view.rerender(
    <ResourceEditor
      gameId="game"
      actionId={null}
      changes={[previous]}
      busy={false}
      active
      onChange={changed}
    />,
  );
  fireEvent.change(
    screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
    { target: { value: '10' } },
  );
  fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('该国余额已变化'),
  );
  expect(changed).not.toHaveBeenCalled();
});
