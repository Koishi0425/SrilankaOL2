import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { SettlementRecruitment } from '@srilanka/contracts';
import { fetchNationalStatus, fetchSettlementStateOptions } from '../api.js';
import { RecruitmentEditor, toRecruitmentInput } from './RecruitmentEditor.js';
vi.mock('../api.js', () => ({
  fetchNationalStatus: vi.fn(),
  fetchSettlementStateOptions: vi.fn(),
}));
const country = {
  id: 'north',
  name: '北国',
  mapColor: '#000000',
  treasury: 100,
  manpower: 1000,
  resourceRevision: 3,
  controlledTileCount: 1,
  legalTileCount: 1,
  cities: [],
  armies: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    countries: [country],
    canSetBalances: false,
  });
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    mapRevision: 7,
    countries: [{ id: 'north', name: '北国' }],
    tiles: [{ id: 'tile', q: 0, r: 0, passable: true }],
    armies: [
      {
        id: 'army',
        name: '第一军',
        countryId: 'north',
        countryName: '北国',
        tileId: 'tile',
        q: 0,
        r: 0,
        strength: 100,
      },
    ],
  });
});
afterEach(cleanup);
function fillCosts(people = '300', money = '20') {
  fireEvent.change(screen.getByLabelText('征募人数'), {
    target: { value: people },
  });
  fireEvent.change(screen.getByLabelText('国库消耗'), {
    target: { value: money },
  });
  fireEvent.change(screen.getByLabelText('人力消耗'), {
    target: { value: people },
  });
  fireEvent.change(screen.getByLabelText('征募说明'), {
    target: { value: '本地志愿兵' },
  });
}
it('loads on demand, creates and reinforces armies, prevents duplicate reinforcement and removes attached fees', async () => {
  const changed = vi.fn(),
    revision = vi.fn();
  function Harness() {
    const [items, setItems] = useState<SettlementRecruitment[]>([]);
    return (
      <RecruitmentEditor
        gameId="game"
        quarterId="quarter"
        actionId={null}
        initialCountryId="north"
        items={items}
        manualResources={[]}
        strengthTargets={[]}
        revision={7}
        hasWorldChanges={!!items.length}
        busy={false}
        active
        onRevision={revision}
        onChange={(next) => {
          changed(next);
          setItems(next);
        }}
      />
    );
  }
  render(<Harness />);
  expect(fetchNationalStatus).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('征兵'));
  await screen.findByRole('option', { name: '北国' });
  fireEvent.change(screen.getByLabelText('军队名称'), {
    target: { value: '第二军' },
  });
  fireEvent.change(screen.getByLabelText('驻地列'), { target: { value: '0' } });
  fireEvent.change(screen.getByLabelText('驻地行'), { target: { value: '0' } });
  fillCosts();
  fireEvent.click(screen.getByRole('button', { name: '添加征兵' }));
  const created = changed.mock.lastCall![0][0] as SettlementRecruitment;
  expect(toRecruitmentInput(created)).toMatchObject({
    kind: 'Create',
    countryId: 'north',
    tileId: 'tile',
    name: '第二军',
    strength: 300,
    treasuryCost: 20,
    manpowerCost: 300,
    expectedResourceRevision: 3,
  });
  expect(toRecruitmentInput(created)).not.toHaveProperty('costs');
  fireEvent.change(screen.getByLabelText('征兵方式'), {
    target: { value: 'Reinforce' },
  });
  fireEvent.change(screen.getByLabelText('补充军队'), {
    target: { value: 'army' },
  });
  fillCosts('200');
  fireEvent.click(screen.getByRole('button', { name: '添加征兵' }));
  expect(changed.mock.lastCall![0][1]).toMatchObject({
    kind: 'Reinforce',
    beforeStrength: 100,
    afterStrength: 300,
  });
  fillCosts('10');
  fireEvent.click(screen.getByRole('button', { name: '添加征兵' }));
  expect(screen.getByRole('alert')).toHaveTextContent('已有补兵或兵力裁决');
  fireEvent.click(screen.getByRole('button', { name: '移除征兵：第二军' }));
  expect(changed.mock.lastCall![0]).toHaveLength(1);
  expect(revision).toHaveBeenCalledWith(7);
});
it('checks combined manpower expenses, stale map and manual final-strength conflicts', async () => {
  const changed = vi.fn();
  const props = {
    gameId: 'game',
    quarterId: 'quarter',
    actionId: null,
    items: [],
    manualResources: [],
    strengthTargets: [],
    revision: 7,
    hasWorldChanges: false,
    busy: false,
    active: true,
    onRevision: vi.fn(),
    onChange: changed,
  };
  const view = render(<RecruitmentEditor {...props} />);
  fireEvent.click(screen.getByText('征兵'));
  await screen.findByRole('option', { name: '北国' });
  fireEvent.change(screen.getByLabelText('征兵方式'), {
    target: { value: 'Reinforce' },
  });
  fireEvent.change(screen.getByLabelText('补充军队'), {
    target: { value: 'army' },
  });
  fillCosts('1001');
  fireEvent.click(screen.getByRole('button', { name: '添加征兵' }));
  expect(screen.getByRole('alert')).toHaveTextContent('人力不足');
  view.rerender(<RecruitmentEditor {...props} strengthTargets={['army']} />);
  fillCosts('10');
  fireEvent.click(screen.getByRole('button', { name: '添加征兵' }));
  expect(screen.getByRole('alert')).toHaveTextContent('已有补兵或兵力裁决');
  view.rerender(<RecruitmentEditor {...props} revision={6} hasWorldChanges />);
  await screen.findByRole('option', { name: '北国 · 第一军（100 人，0, 0）' });
  fireEvent.click(screen.getByRole('button', { name: '添加征兵' }));
  expect(screen.getByRole('alert')).toHaveTextContent('地图已变化');
  expect(changed).not.toHaveBeenCalled();
});
