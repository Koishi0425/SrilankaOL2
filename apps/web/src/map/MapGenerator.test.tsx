import {
  act,
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
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
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
  expect(
    screen.queryByLabelText('自动将陆地划分给本局国家'),
  ).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('地图种子'), {
    target: { value: '  shared-seed  ' },
  });
  fireEvent.change(screen.getByLabelText('生成方式'), {
    target: { value: 'Archipelago' },
  });
  fireEvent.change(screen.getByLabelText('海平面'), {
    target: { value: 'High' },
  });
  fireEvent.click(screen.getByRole('button', { name: '重新生成预览' }));
  fireEvent.change(screen.getByLabelText('地图种子'), {
    target: { value: '  shared-seed  ' },
  });
  const terrain = Array.from(
    screen.getByRole('img').querySelectorAll('polygon'),
    (p) => p.getAttribute('fill'),
  );
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  expect(createMap).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('自动将陆地划分给本局国家'));
  expect(
    Array.from(screen.getByRole('img').querySelectorAll('polygon'), (p) =>
      p.getAttribute('fill'),
    ),
  ).toEqual(terrain);
  fireEvent.click(screen.getByRole('button', { name: '返回调整地形' }));
  expect(screen.getByLabelText('地图种子')).toHaveValue('  shared-seed  ');
  expect(createMap).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  expect(screen.getByLabelText('自动将陆地划分给本局国家')).toBeChecked();
  fireEvent.click(screen.getByRole('button', { name: '保存地图并进入布置' }));
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
    expect.any(AbortSignal),
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
  expect(
    screen.getByRole('button', { name: '确认地形，下一步' }),
  ).toBeDisabled();
  fireEvent.change(screen.getByLabelText('列数'), { target: { value: '24' } });
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  expect(
    screen.queryByLabelText('自动将陆地划分给本局国家'),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '保存地图并进入布置' }));
  await waitFor(() => expect(createMap).toHaveBeenCalled());
  expect(vi.mocked(createMap).mock.calls[0]![1].generation).toBeUndefined();
});
it('allows going back before overwriting and keeps failed choices for review', async () => {
  const callbacks = props();
  render(<MapGenerator {...callbacks} map={setup.map} />);
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  expect(generateMapTerrain).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '返回调整地形' }));
  fireEvent.change(screen.getByLabelText('湿度'), { target: { value: 'Wet' } });
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  vi.mocked(generateMapTerrain).mockRejectedValueOnce(new Error('地图已变化'));
  fireEvent.click(screen.getByRole('button', { name: '确认覆盖并进入布置' }));
  await screen.findByText('地图已变化');
  expect(callbacks.onChanged).not.toHaveBeenCalled();
  expect(generateMapTerrain).toHaveBeenCalledWith(
    'game',
    expect.objectContaining({ expectedRevision: 5, rainfall: 'Wet' }),
    expect.any(AbortSignal),
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '返回调整地形' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '返回调整地形' }));
  expect(screen.getByLabelText('湿度')).toHaveValue('Wet');
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
    screen.queryByRole('button', { name: '确认地形，下一步' }),
  ).not.toBeInTheDocument();
});
it('saves without allocation by default and explains a long save without duplicate writes', async () => {
  vi.useFakeTimers();
  let done!: (data: MapSetupData) => void;
  vi.mocked(createMap).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        done = resolve;
      }),
  );
  const callbacks = props();
  render(<MapGenerator {...callbacks} />);
  fireEvent.change(screen.getByLabelText('地图大小'), {
    target: { value: '64x44' },
  });
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '保存地图并进入布置' }));
  expect(screen.getByRole('button', { name: '正在保存地图…' })).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_000);
  });
  expect(screen.getByRole('status')).toHaveTextContent(
    '2816 个地块… 已等待 11 秒',
  );
  expect(screen.getByRole('status')).toHaveTextContent('无需重复点击');
  expect(createMap).toHaveBeenCalledTimes(1);
  expect(vi.mocked(createMap).mock.calls[0]![1].generation?.countryIds).toEqual(
    [],
  );
  await act(async () => {
    done(setup);
  });
  expect(callbacks.onChanged).toHaveBeenCalledWith(setup);
});
it('keeps the wizard usable when both saving and refreshing fail', async () => {
  vi.mocked(createMap).mockRejectedValueOnce(new Error('连接中断'));
  vi.mocked(fetchMapSetup).mockRejectedValueOnce(new Error('仍无法连接'));
  render(<MapGenerator {...props()} />);
  fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
  fireEvent.click(screen.getByRole('button', { name: '保存地图并进入布置' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '返回调整地形' })).toBeEnabled(),
  );
  expect(screen.getByRole('alert')).toHaveTextContent('连接中断');
});
it('recovers from an interrupted save even if the follow-up read also times out', async () => {
  const requests: AbortController[] = [];
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
    const controller = new AbortController();
    requests.push(controller);
    return controller.signal;
  });
  const pending = (signal?: AbortSignal) =>
    new Promise<MapSetupData>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(signal!.reason), {
        once: true,
      });
    });
  vi.mocked(createMap).mockImplementationOnce((_game, _input, signal) =>
    pending(signal),
  );
  vi.mocked(fetchMapSetup).mockImplementationOnce((_game, signal) =>
    pending(signal),
  );
  try {
    render(<MapGenerator {...props()} />);
    fireEvent.click(screen.getByRole('button', { name: '确认地形，下一步' }));
    fireEvent.click(screen.getByLabelText('自动将陆地划分给本局国家'));
    fireEvent.click(screen.getByRole('button', { name: '保存地图并进入布置' }));
    await act(async () => {
      requests[0]!.abort(new DOMException('保存超时', 'TimeoutError'));
    });
    expect(screen.getByRole('alert')).toHaveTextContent('服务器可能仍在处理');
    await act(async () => {
      requests[1]!.abort(new DOMException('读取超时', 'TimeoutError'));
    });
    expect(screen.getByRole('button', { name: '返回调整地形' })).toBeEnabled();
    expect(screen.getByLabelText('自动将陆地划分给本局国家')).toBeChecked();
    expect(createMap).toHaveBeenCalledTimes(1);
  } finally {
    timeout.mockRestore();
  }
});
