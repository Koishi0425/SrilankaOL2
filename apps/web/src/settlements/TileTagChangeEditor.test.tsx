import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TileTagChangeEditor } from './TileTagChangeEditor.js';
import { fetchSettlementStateOptions } from '../api.js';
import type { SettlementStateChange } from '@srilanka/contracts';
vi.mock('../api.js', () => ({ fetchSettlementStateOptions: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it('stages a status against policy tile targets and keeps its duration explicit', async () => {
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    mapRevision: 3,
    countries: [],
    armies: [],
    tiles: [{ id: 'tile', q: 1, r: 1, passable: true }],
  });
  const change = vi.fn();
  render(
    <TileTagChangeEditor
      gameId="game"
      quarterId="q"
      actionId="action"
      changes={[]}
      busy={false}
      revision={3}
      hasWorldChanges
      onChange={change}
      refs={[
        {
          objectId: 'tile',
          objectType: 'Tile',
          refKind: 'Target',
          label: '地块',
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByText('地块状态'));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: '添加地块状态计划' }),
    ).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('状态预设'), {
    target: { value: 'damage' },
  });
  fireEvent.change(screen.getByLabelText('持续回合'), {
    target: { value: '3' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加地块状态计划' }));
  expect(change).toHaveBeenCalledExactlyOnceWith(
    [
      expect.objectContaining({
        kind: 'TileTag',
        operation: 'Set',
        tileIds: ['tile'],
        tag: expect.objectContaining({
          name: '遭到破坏',
          productionPercent: -50,
          duration: 3,
        }),
      }),
    ],
    3,
  );
});

it('previews the exact province/tile union without staging, and updates the preview when a rectangle changes', async () => {
  const options = {
    mapRevision: 3,
    countries: [],
    armies: [],
    tiles: [
      { id: 'one', q: 1, r: 1, passable: true, provinceId: 'province' },
      { id: 'two', q: 2, r: 1, passable: true, provinceId: 'province' },
      { id: 'other', q: 3, r: 1, passable: true },
    ],
  };
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue(options);
  const change = vi.fn();
  render(
    <TileTagChangeEditor
      gameId="game"
      quarterId="q"
      actionId="action"
      changes={[]}
      busy={false}
      onChange={change}
      refs={[
        {
          objectId: 'province',
          objectType: 'Province',
          refKind: 'Target',
          label: '省份',
        },
        {
          objectId: 'one',
          objectType: 'Tile',
          refKind: 'Target',
          label: '重复地块',
        },
        {
          objectId: 'other',
          objectType: 'Tile',
          refKind: 'Context',
          label: '不应计入的背景',
        },
      ]}
    />,
  );
  fireEvent.click(screen.getByText('地块状态'));
  const preview = await screen.findByRole('button', {
    name: '在地图上预览待添加范围',
  });
  await waitFor(() => expect(preview).toBeEnabled());
  fireEvent.click(preview);
  expect(
    screen.getByRole('img', { name: '地块范围预览，高亮 2 格' }),
  ).toBeVisible();
  expect(screen.getByText('（1,1）、（2,1）')).toBeInTheDocument();
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(screen.getByLabelText('使用政策关联的地块／省份目标'));
  for (const [name, value] of [
    ['起始列', '3'],
    ['结束列', '3'],
    ['起始行', '1'],
    ['结束行', '1'],
  ])
    fireEvent.change(screen.getByLabelText(name!), { target: { value } });
  expect(
    screen.getByRole('img', { name: '地块范围预览，高亮 1 格' }),
  ).toBeVisible();
  expect(screen.getByText('（3,1）')).toBeInTheDocument();
  expect(screen.queryByText('（1,1）、（2,1）')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('状态预设'), {
    target: { value: 'damage' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加地块状态计划' }));
  expect(change).toHaveBeenCalledWith(
    [expect.objectContaining({ tileIds: ['other'] })],
    3,
  );
});

it('previews saved IDs rather than the current target controls and warns about unavailable tiles or a changed map', async () => {
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    mapRevision: 4,
    countries: [],
    armies: [],
    tiles: [{ id: 'saved', q: 8, r: 9, passable: true }],
  });
  const change = vi.fn();
  const saved: SettlementStateChange = {
    id: 'saved-plan',
    actionId: null,
    kind: 'TileTag',
    operation: 'Remove',
    tileIds: ['saved', 'missing'],
    tag: {
      name: '遭到破坏',
      productionPercent: -50,
      taxPercent: 0,
      blocksObservation: false,
      duration: 1,
      description: '',
    },
    summary: '2 格：移除 遭到破坏',
  };
  render(
    <TileTagChangeEditor
      gameId="game"
      quarterId="q"
      actionId={null}
      changes={[saved]}
      revision={3}
      busy={false}
      onChange={change}
    />,
  );
  fireEvent.click(screen.getByText('地块状态（1）'));
  const preview = await screen.findByRole('button', {
    name: '在地图上预览范围',
  });
  await waitFor(() => expect(preview).toBeEnabled());
  fireEvent.click(preview);
  expect(
    screen.getByRole('img', { name: '地块范围预览，高亮 1 格' }),
  ).toBeVisible();
  expect(screen.getByText('（8,9）')).toBeInTheDocument();
  expect(screen.getByText(/有 1 个目标在当前地图中不存在/)).toBeVisible();
  expect(screen.getByText(/地图版本已变化/)).toBeVisible();
  expect(change).not.toHaveBeenCalled();
});

it('shows saved effects, duration and observation rules independently of the new-plan form, including removal semantics', async () => {
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    mapRevision: 1,
    countries: [],
    armies: [],
    tiles: [],
  });
  const saved: Extract<SettlementStateChange, { kind: 'TileTag' }> = {
    id: 'plan',
    actionId: null,
    kind: 'TileTag',
    operation: 'Set',
    tileIds: ['tile'],
    summary: '1 格：设置 遭到破坏（下回合生效）',
    tag: {
      name: '遭到破坏',
      description: '',
      taxPercent: 0,
      productionPercent: -50,
      blocksObservation: false,
      duration: 4,
    },
  };
  const props = {
    gameId: 'game',
    quarterId: 'q',
    actionId: null,
    busy: false,
    onChange: vi.fn(),
  };
  const page = render(<TileTagChangeEditor {...props} changes={[saved]} />);
  fireEvent.click(screen.getByText('地块状态（1）'));
  expect(
    screen.getByText(
      /税收贡献 0% · 生产贡献 -50% · 持续 4 回合 · 不遮蔽实时视野/,
    ),
  ).toBeVisible();
  expect(await screen.findByLabelText('持续回合')).toHaveValue('1');
  page.rerender(
    <TileTagChangeEditor
      {...props}
      changes={[
        {
          ...saved,
          tag: {
            ...saved.tag,
            taxPercent: 25,
            duration: null,
            blocksObservation: true,
          },
        },
      ]}
    />,
  );
  expect(
    screen.getByText(
      /税收贡献 \+25% · 生产贡献 -50% · 持续至主持人移除 · 遮蔽实时视野/,
    ),
  ).toBeVisible();
  page.rerender(
    <TileTagChangeEditor
      {...props}
      changes={[
        { ...saved, operation: 'Remove', summary: '1 格：移除 遭到破坏' },
      ]}
    />,
  );
  expect(screen.getByText(/发布时移除该同名状态及其效果/)).toBeVisible();
  expect(screen.queryByText(/生产贡献 -50%/)).not.toBeInTheDocument();
  expect(props.onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '移除此状态变化' }));
  expect(props.onChange).toHaveBeenCalledExactlyOnceWith([]);
});
