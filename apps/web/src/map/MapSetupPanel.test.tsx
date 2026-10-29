import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameSummary, MapSetupData } from '@srilanka/contracts';
import {
  batchMapTiles,
  fetchMapSetup,
  fetchMapReveal,
  initializeMapKnowledge,
  revealMapKnowledge,
} from '../api.js';
import { MapSetupPanel } from './MapSetupPanel.js';
vi.mock('../api.js', () => ({
  batchMapTiles: vi.fn(),
  changeTileTags: vi.fn(),
  createMap: vi.fn(),
  generateMapTerrain: vi.fn(),
  fetchMapSetup: vi.fn(),
  fetchMapReveal: vi.fn(),
  initializeMapKnowledge: vi.fn(),
  removeMapReveal: vi.fn(),
  revealMapKnowledge: vi.fn(),
}));
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
    currentWorldVersion: 1,
  },
};
const setup: MapSetupData = {
  map: {
    id: 'map',
    name: '地图',
    width: 12,
    height: 8,
    orientation: 'Pointy',
    minZoom: 0.5,
    maxZoom: 3,
    currentWorldVersion: 1,
    revision: 2,
    availableLayers: [],
  },
  terrains: [
    {
      id: 'forest',
      name: '森林',
      color: '#123456',
      passable: true,
      movementCost: 2,
    },
  ],
  regions: [],
};
const countries = [
  { id: 'a', name: '北国', mapColor: '#123456' },
  { id: 'b', name: '南国', mapColor: '#654321' },
];
const props = () => ({
  game,
  countries,
  selectedIds: ['tile'],
  onSelection: vi.fn(),
  onRectangle: vi.fn(),
  onChanged: vi.fn(),
});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchMapSetup).mockResolvedValue(structuredClone(setup));
});
afterEach(cleanup);
describe('map editing and reveal workflow', () => {
  it('retains a failed batch and selection, then retries against the refreshed revision', async () => {
    const callbacks = props();
    render(<MapSetupPanel {...callbacks} />);
    fireEvent.change(await screen.findByLabelText('地形'), {
      target: { value: 'forest' },
    });
    fireEvent.change(screen.getByLabelText('地区名称'), {
      target: { value: '北地' },
    });
    vi.mocked(batchMapTiles).mockRejectedValueOnce(new Error('地图已变化'));
    vi.mocked(fetchMapSetup).mockResolvedValue({
      ...setup,
      map: { ...setup.map!, revision: 3 },
    });
    fireEvent.click(screen.getByRole('button', { name: '应用到所选地块' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('地区名称')).toHaveValue('北地');
    expect(screen.getByText('已选 1 个地块')).toBeInTheDocument();
    expect(callbacks.onChanged).not.toHaveBeenCalled();
    vi.mocked(batchMapTiles).mockResolvedValue({
      ...setup,
      map: { ...setup.map!, revision: 4 },
    });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '应用到所选地块' }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '应用到所选地块' }));
    await screen.findByText('地块已更新');
    expect(batchMapTiles).toHaveBeenLastCalledWith('game', {
      expectedRevision: 3,
      tileIds: ['tile'],
      terrainTypeId: 'forest',
      regionName: '北地',
    });
  });
  it('checks the receiving country before an immediate reveal and resets confirmation when it changes', async () => {
    render(<MapSetupPanel {...props()} />);
    fireEvent.click(await screen.findByRole('button', { name: '揭示信息' }));
    fireEvent.change(screen.getByLabelText('给玩家的信息'), {
      target: { value: '发现矿脉' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发布所选信息' }));
    expect(
      screen.getByText('向北国立即发布 1 个地块的地理信息。'),
    ).toBeInTheDocument();
    expect(revealMapKnowledge).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('接收国家'), {
      target: { value: 'b' },
    });
    expect(
      screen.queryByRole('button', { name: '确认发布' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '发布所选信息' }));
    vi.mocked(revealMapKnowledge).mockResolvedValue(setup);
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await screen.findByText('已知范围已更新');
    expect(revealMapKnowledge).toHaveBeenCalledWith('game', {
      expectedRevision: 2,
      countryId: 'b',
      tileIds: ['tile'],
      state: 'Mapped',
      note: '发现矿脉',
    });
  });
  it('loads an existing policy reveal and saves it as a staged result', async () => {
    vi.mocked(fetchMapReveal).mockResolvedValue({
      actionId: 'action',
      countryId: 'a',
      tileIds: ['tile'],
      state: 'Observed',
      note: '上次保存的报告',
      armyErrorPercent: 20,
      publishedAt: null,
    });
    const callbacks = props();
    render(
      <MapSetupPanel
        {...callbacks}
        seed={{
          key: 1,
          actionId: 'action',
          title: '向北探索',
          countryId: 'a',
          tileIds: [],
        }}
      />,
    );
    expect(await screen.findByLabelText('给玩家的信息')).toHaveValue(
      '上次保存的报告',
    );
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '保存探索结果' }),
      ).toBeEnabled(),
    );
    expect(screen.getByLabelText('接收国家')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: '发布所选信息' }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('给玩家的信息'), {
      target: { value: '找到一座要塞' },
    });
    vi.mocked(revealMapKnowledge).mockResolvedValue(setup);
    fireEvent.click(screen.getByRole('button', { name: '保存探索结果' }));
    await screen.findByText('探索结果已保存，尚未发布');
    expect(revealMapKnowledge).toHaveBeenCalledWith('game', {
      expectedRevision: 2,
      countryId: 'a',
      tileIds: ['tile'],
      state: 'Observed',
      note: '找到一座要塞',
      armyErrorPercent: 20,
      sourceActionId: 'action',
    });
    expect(initializeMapKnowledge).not.toHaveBeenCalled();
  });
});
