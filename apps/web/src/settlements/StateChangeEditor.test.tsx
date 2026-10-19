import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import {
  toStateChangeInput,
  type SettlementStateChange,
  type SettlementStateOptions,
} from '@srilanka/contracts';
import { fetchSettlementStateOptions } from '../api.js';
import { StateChangeEditor } from './StateChangeEditor.js';
vi.mock('../api.js', () => ({ fetchSettlementStateOptions: vi.fn() }));
const options: SettlementStateOptions = {
  mapRevision: 7,
  countries: [],
  armies: [],
  tiles: [],
  provinces: [
    {
      id: 'province',
      name: '北方省',
      revision: 2,
      values: {
        taxBase: 8,
        productionBase: 6,
        manpowerBase: 5,
        autonomy: 15,
        unrest: 2,
      },
    },
  ],
};
const old: SettlementStateChange = {
  id: 'old',
  actionId: null,
  kind: 'Province',
  provinceId: 'province',
  expectedProfileRevision: 2,
  values: { taxBase: 9 },
  reason: '税务改革',
  provinceName: '北方省',
  beforeValues: { taxBase: 8 },
  summary: '北方省：税收基础 8 → 9',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue(options);
});
afterEach(cleanup);
it('opens a linked province with current values and keeps unfinished edits when returning from the map', async () => {
  const change = vi.fn(),
    onRevision = vi.fn();
  const props = {
    gameId: 'game',
    quarterId: 'quarter',
    actionId: 'policy',
    changes: [],
    revision: 7,
    busy: false,
    onRevision,
    onChange: change,
    refs: [
      {
        refKind: 'Target' as const,
        objectType: 'Province' as const,
        objectId: 'province',
        label: '北方省',
      },
    ],
  };
  const { rerender } = render(<StateChangeEditor {...props} active />);
  expect(await screen.findByLabelText('生产基础调整后')).toBeVisible();
  expect(screen.getByLabelText('变化类型')).toHaveValue('Province');
  expect(screen.getByLabelText('省份')).toHaveValue('province');
  expect(
    screen.getByRole('option', { name: '北方省（政策目标）' }),
  ).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('生产基础调整后'), {
    target: { value: '9' },
  });
  fireEvent.change(screen.getByLabelText('省份变化原因'), {
    target: { value: '修渠' },
  });
  rerender(<StateChangeEditor {...props} active={false} />);
  rerender(<StateChangeEditor {...props} active />);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '添加变化' })).toBeEnabled(),
  );
  expect(screen.getByLabelText('生产基础调整后')).toHaveValue(9);
  expect(screen.getByLabelText('省份变化原因')).toHaveValue('修渠');
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(change.mock.lastCall![0][0]).toMatchObject({
    actionId: 'policy',
    provinceId: 'province',
    values: { productionBase: 9 },
    beforeValues: { productionBase: 6 },
  });
});
it('stages influence adjustments without coordinates, rejects duplicates and sends only editable inputs', async () => {
  const changed = vi.fn();
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    ...options,
    countries: [{ id: 'north', name: '北国' }],
    tradeZones: [
      {
        id: 'zone',
        name: '海湾',
        revision: 2,
        influences: [{ countryId: 'north', power: 60 }],
      },
    ],
  });
  function Harness() {
    const [changes, setChanges] = useState<SettlementStateChange[]>([]);
    return (
      <StateChangeEditor
        gameId="game"
        quarterId="quarter"
        actionId={null}
        changes={changes}
        revision={7}
        busy={false}
        active
        onRevision={vi.fn()}
        onChange={(next) => {
          changed(next);
          setChanges(next);
        }}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText('状态变化'));
  await screen.findByRole('option', { name: '贸易影响力调整' });
  await waitFor(() => expect(screen.getByLabelText('变化类型')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('变化类型'), {
    target: { value: 'TradeInfluence' },
  });
  fireEvent.change(screen.getByLabelText('贸易区'), {
    target: { value: 'zone' },
  });
  fireEvent.change(screen.getByLabelText('影响力所属国家'), {
    target: { value: 'north' },
  });
  fireEvent.change(screen.getByLabelText('调整后贸易影响力'), {
    target: { value: '80' },
  });
  fireEvent.change(screen.getByLabelText('贸易变化原因'), {
    target: { value: '港口协议' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(toStateChangeInput(changed.mock.lastCall![0][0])).toEqual({
    id: expect.any(String),
    actionId: null,
    kind: 'TradeInfluence',
    zoneId: 'zone',
    countryId: 'north',
    power: 80,
    expectedZoneRevision: 2,
    reason: '港口协议',
  });
  expect(screen.queryByLabelText('目的地列')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('调整后贸易影响力'), {
    target: { value: '90' },
  });
  fireEvent.change(screen.getByLabelText('贸易变化原因'), {
    target: { value: '另一协议' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('已有影响力变化');
  expect(changed).toHaveBeenCalledOnce();
});
async function openProvince() {
  fireEvent.click(screen.getByText(/^状态变化/));
  await screen.findByRole('option', { name: '省份发展与治理' });
  await waitFor(() => expect(screen.getByLabelText('变化类型')).toBeEnabled());
  fireEvent.change(screen.getByLabelText('变化类型'), {
    target: { value: 'Province' },
  });
  fireEvent.change(screen.getByLabelText('省份'), {
    target: { value: 'province' },
  });
}
it('loads on demand, adds only changed fields including zero, rejects conflicting fields and removes the plan', async () => {
  const changed = vi.fn();
  function Harness() {
    const [changes, setChanges] = useState<SettlementStateChange[]>([]);
    return (
      <StateChangeEditor
        gameId="game"
        quarterId="quarter"
        actionId="action"
        changes={changes}
        revision={7}
        busy={false}
        active
        onRevision={vi.fn()}
        onChange={(next) => {
          changed(next);
          setChanges(next);
        }}
      />
    );
  }
  render(<Harness />);
  expect(fetchSettlementStateOptions).not.toHaveBeenCalled();
  await openProvince();
  fireEvent.change(screen.getByLabelText('生产基础调整后'), {
    target: { value: '7' },
  });
  fireEvent.change(screen.getByLabelText('不满调整后'), {
    target: { value: '0' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('填写原因');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('省份变化原因'), {
    target: { value: '修建工坊，安抚地方' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  const input = toStateChangeInput(changed.mock.lastCall![0][0]);
  expect(input).toEqual({
    id: expect.any(String),
    actionId: 'action',
    kind: 'Province',
    provinceId: 'province',
    expectedProfileRevision: 2,
    values: { productionBase: 7, unrest: 0 },
    reason: '修建工坊，安抚地方',
  });
  expect(
    screen.getByText(/北方省：生产基础 6 → 7，不满 2 → 0/),
  ).toHaveTextContent('修建工坊，安抚地方');
  fireEvent.change(screen.getByLabelText('生产基础调整后'), {
    target: { value: '8' },
  });
  fireEvent.change(screen.getByLabelText('省份变化原因'), {
    target: { value: '另一份政策' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('已有变化');
  expect(changed).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole('button', { name: '移除' }));
  expect(changed).toHaveBeenLastCalledWith([]);
});
it('rejects invalid or unchanged values and keeps the old revision when current state is reloaded', async () => {
  const changed = vi.fn(),
    onRevision = vi.fn();
  render(
    <StateChangeEditor
      gameId="game"
      quarterId="quarter"
      actionId="action"
      changes={[old]}
      revision={7}
      busy={false}
      active
      onChange={changed}
      onRevision={onRevision}
    />,
  );
  await openProvince();
  fireEvent.change(screen.getByLabelText('省份变化原因'), {
    target: { value: '治理' },
  });
  fireEvent.change(screen.getByLabelText('生产基础调整后'), {
    target: { value: '1.5' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('基础值须为非负整数');
  fireEvent.change(screen.getByLabelText('生产基础调整后'), {
    target: { value: '6' },
  });
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('至少一项');
  fireEvent.change(screen.getByLabelText('生产基础调整后'), {
    target: { value: '7' },
  });
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    ...options,
    mapRevision: 8,
  });
  fireEvent.click(screen.getByRole('button', { name: '重读当前状态' }));
  await waitFor(() => expect(onRevision).toHaveBeenLastCalledWith(8));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '添加变化' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('地图已变化');
  expect(screen.getByLabelText('生产基础调整后')).toHaveValue(7);
  expect(changed).not.toHaveBeenCalled();
});
it('retains unadded province writing after a read failure and restores it when reading succeeds', async () => {
  render(
    <StateChangeEditor
      gameId="game"
      quarterId="quarter"
      actionId={null}
      changes={[]}
      revision={7}
      busy={false}
      active
      onChange={vi.fn()}
      onRevision={vi.fn()}
    />,
  );
  await openProvince();
  fireEvent.change(screen.getByLabelText('自治（%）调整后'), {
    target: { value: '12.5' },
  });
  fireEvent.change(screen.getByLabelText('省份变化原因'), {
    target: { value: '削减地方特权' },
  });
  vi.mocked(fetchSettlementStateOptions).mockRejectedValueOnce(
    new Error('连接中断'),
  );
  fireEvent.click(screen.getByRole('button', { name: '重读当前状态' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
  fireEvent.click(screen.getByRole('button', { name: '重读当前状态' }));
  expect(await screen.findByLabelText('自治（%）调整后')).toHaveValue(12.5);
  expect(screen.getByLabelText('省份变化原因')).toHaveValue('削减地方特权');
});
