import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GameSummary, ProvinceData } from '@srilanka/contracts';
import { fetchProvinces, setProvince } from '../api.js';
import { ProvincePanel } from './ProvincePanel.js';
vi.mock('../api.js', () => ({ fetchProvinces: vi.fn(), setProvince: vi.fn() }));
const game: GameSummary = {
  id: 'game',
  name: '诸国',
  role: 'Host',
  status: 'Preparing',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'Preparing',
    actionDeadline: null,
    currentWorldVersion: 0,
  },
};
const data: ProvinceData = {
  canEdit: true,
  mapRevision: 7,
  provinces: [
    {
      id: 'north',
      name: '北境',
      revision: 2,
      partial: false,
      tileCount: 2,
      legalOwners: [
        { countryId: 'country', countryName: '北国', tileCount: 2 },
      ],
      controllers: [
        { countryId: 'country', countryName: '北国', tileCount: 2 },
      ],
      values: {
        description: '农业地区',
        taxBase: 5,
        productionBase: 3,
        manpowerBase: 4,
        autonomy: 10.25,
        unrest: -1.5,
      },
      tiles: [
        { id: 'tile-a', q: 0, r: 0, regionName: '北岸' },
        { id: 'tile-b', q: 1, r: 0, regionName: '北岸' },
      ],
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchProvinces).mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);
it('loads when expanded and locates a province region on the map', async () => {
  const locate = vi.fn();
  render(<ProvincePanel game={game} active onLocate={locate} />);
  expect(fetchProvinces).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('省份（全部）'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看省份：北境' }),
  );
  expect(screen.getByText('5 / 3 / 4')).toBeInTheDocument();
  expect(screen.getByText('农业地区')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '在地图查看地区：北岸' }));
  expect(locate).toHaveBeenCalledWith({
    id: 'tile-a',
    q: 0,
    r: 0,
    regionName: '北岸',
  });
});
it('retains edits and original revisions on failure and across workspace switches until saved', async () => {
  vi.mocked(setProvince)
    .mockRejectedValueOnce(new Error('省份资料已变化'))
    .mockResolvedValueOnce({
      ...data,
      mapRevision: 8,
      provinces: [
        {
          ...data.provinces[0]!,
          revision: 3,
          values: { ...data.provinces[0]!.values!, taxBase: 8 },
        },
      ],
    });
  const view = render(<ProvincePanel game={game} active />);
  fireEvent.click(screen.getByText('省份（全部）'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看省份：北境' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '设置省份资料' }));
  fireEvent.change(screen.getByLabelText('税收基础'), {
    target: { value: '8' },
  });
  fireEvent.change(screen.getByLabelText('修改原因'), {
    target: { value: '开场修订' },
  });
  fireEvent.click(screen.getByRole('button', { name: '保存省份资料' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('省份资料已变化');
  view.rerender(<ProvincePanel game={game} active={false} />);
  view.rerender(<ProvincePanel game={game} active />);
  expect(screen.getByLabelText('税收基础')).toHaveValue(8);
  expect(screen.getByLabelText('修改原因')).toHaveValue('开场修订');
  fireEvent.click(screen.getByRole('button', { name: '保存省份资料' }));
  await waitFor(() => expect(setProvince).toHaveBeenCalledTimes(2));
  expect(vi.mocked(setProvince).mock.lastCall![2]).toMatchObject({
    taxBase: 8,
    expectedRevision: 2,
    expectedMapRevision: 7,
    reason: '开场修订',
  });
  expect(await screen.findByText('省份资料已保存')).toBeInTheDocument();
});
it('hides whole-province values for partial territory and keeps player views read-only', async () => {
  const partial = {
    ...data.provinces[0]!,
    id: 'border',
    name: '边境',
    partial: true,
    values: null,
    tileCount: 1,
    tiles: [data.provinces[0]!.tiles[0]!],
  };
  vi.mocked(fetchProvinces).mockResolvedValue({
    canEdit: false,
    mapRevision: 7,
    provinces: [partial],
  });
  render(<ProvincePanel game={{ ...game, role: 'Player' }} active />);
  fireEvent.click(screen.getByText('省份'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看省份：边境' }),
  );
  expect(screen.getByText(/仅列出本国法定领土/)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '设置省份资料' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText('农业地区')).not.toBeInTheDocument();
  expect(within(screen.getByRole('table')).getAllByText('—')).toHaveLength(3);
});
