import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MapGenerator } from './MapGenerator.js';
import { createMap, generateMapTerrain, fetchMapSetup } from '../api.js';
import type { CountrySummary, MapSetupData } from '@srilanka/contracts';
vi.mock('../api.js', () => ({
  createMap: vi.fn(),
  generateMapTerrain: vi.fn(),
  fetchMapSetup: vi.fn(),
}));
const setup: MapSetupData = {
  map: {
    id: 'map',
    name: '地图',
    width: 24,
    height: 16,
    orientation: 'Pointy',
    minZoom: 0.5,
    maxZoom: 3,
    revision: 5,
    currentWorldVersion: 1,
    availableLayers: [],
  },
  terrains: [],
  regions: [],
};
const countries = [
  { id: 'b', name: '南国', mapColor: '#bbb' },
  { id: 'a', name: '北国', mapColor: '#aaa' },
] as CountrySummary[];
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(createMap).mockResolvedValue(setup);
  vi.mocked(generateMapTerrain).mockResolvedValue(setup);
  vi.mocked(fetchMapSetup).mockResolvedValue(setup);
});
afterEach(cleanup);
const props = () => ({
  gameId: 'game',
  countries,
  map: null,
  onChanged: vi.fn(),
  onSelection: vi.fn(),
});
it('previews without writing, then creates exactly the selected parameters and optional countries', async () => {
  const callbacks = props();
  render(<MapGenerator {...callbacks} />);
  expect(
    screen.getByRole('img', { name: '待生成地图预览' }),
  ).toBeInTheDocument();
  expect(createMap).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('地图种子'), {
    target: { value: '  shared-seed  ' },
  });
  fireEvent.change(screen.getByLabelText('生成方式'), {
    target: { value: 'Archipelago' },
  });
  fireEvent.change(screen.getByLabelText('海平面'), {
    target: { value: 'High' },
  });
  fireEvent.click(screen.getByLabelText('自动将陆地划分给本局国家'));
  fireEvent.click(screen.getByRole('button', { name: '创建此地图' }));
  await waitFor(() => expect(callbacks.onChanged).toHaveBeenCalledWith(setup));
  expect(createMap).toHaveBeenCalledWith(
    'game',
    expect.objectContaining({
      width: 40,
      height: 28,
      generation: expect.objectContaining({
        mapType: 'Archipelago',
        seed: 'shared-seed',
        seaLevel: 'High',
        countryIds: ['a', 'b'],
      }),
    }),
  );
  expect(callbacks.onSelection).toHaveBeenCalledWith([]);
});
it('preserves blank-map creation and rejects invalid size without writing', async () => {
  render(<MapGenerator {...props()} />);
  fireEvent.change(screen.getByLabelText('生成方式'), {
    target: { value: 'Blank' },
  });
  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('列数'), { target: { value: '101' } });
  expect(screen.getByRole('button', { name: '创建空白地图' })).toBeDisabled();
  fireEvent.change(screen.getByLabelText('列数'), { target: { value: '24' } });
  fireEvent.click(screen.getByRole('button', { name: '创建空白地图' }));
  await waitFor(() => expect(createMap).toHaveBeenCalled());
  expect(vi.mocked(createMap).mock.calls[0]![1].generation).toBeUndefined();
});
it('requires a fresh confirmation after changing options and keeps failures for review', async () => {
  const callbacks = props();
  render(<MapGenerator {...callbacks} map={setup.map} />);
  fireEvent.click(screen.getByRole('button', { name: '使用此预览重新生成' }));
  expect(generateMapTerrain).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('湿度'), { target: { value: 'Wet' } });
  expect(
    screen.queryByRole('button', { name: '确认重新生成' }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '使用此预览重新生成' }));
  vi.mocked(generateMapTerrain).mockRejectedValueOnce(new Error('地图已变化'));
  fireEvent.click(screen.getByRole('button', { name: '确认重新生成' }));
  await screen.findByText('地图已变化');
  expect(screen.getByLabelText('湿度')).toHaveValue('Wet');
  expect(callbacks.onChanged).not.toHaveBeenCalled();
  expect(generateMapTerrain).toHaveBeenCalledWith(
    'game',
    expect.objectContaining({ expectedRevision: 5, rainfall: 'Wet' }),
  );
});
it('does not offer regeneration when existing world content is protected', () => {
  render(
    <MapGenerator
      {...props()}
      map={setup.map}
      blockedReason="已有城市，请使用批量工具"
    />,
  );
  expect(screen.getByRole('status')).toHaveTextContent('已有城市');
  expect(
    screen.queryByRole('button', { name: '使用此预览重新生成' }),
  ).not.toBeInTheDocument();
});
