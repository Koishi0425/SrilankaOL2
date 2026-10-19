import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { nationalPolicyStatus, toGovernmentInput } from '@srilanka/contracts';
import type {
  GovernmentChange,
  GovernmentData,
  NationalPolicy,
} from '@srilanka/contracts';
import { fetchGovernment } from '../api.js';
import { GovernmentEditor, GovernmentForm } from './GovernmentEditor.js';
vi.mock('../api.js', () => ({ fetchGovernment: vi.fn() }));
const data: GovernmentData = {
  revision: 7,
  quarter: { gameYear: 2, season: 'Winter', sequenceNumber: 8 },
  canEdit: false,
  countries: [
    { id: 'north', name: '北国' },
    { id: 'south', name: '南国' },
  ],
  profiles: [
    {
      countryId: 'north',
      countryName: '北国',
      regime: '君主制',
      authority: '北王',
      description: '',
    },
    {
      countryId: 'south',
      countryName: '南国',
      regime: '共和制',
      authority: '议会',
      description: '',
    },
  ],
  policies: [],
  lastBill: null,
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchGovernment).mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
it('creates a two-season policy beginning next year, validates effects and serializes only host input', () => {
  const onChange = vi.fn();
  render(
    <GovernmentForm
      data={data}
      actionId="action"
      operation="Settlement"
      changes={[]}
      busy={false}
      onChange={onChange}
    />,
  );
  change('行政操作', 'Policy');
  change('政策名称', '两季减税');
  change('政策条文', '税收减少 10%');
  change('期限（季，留空为长期）', '2');
  change('税收', '-10');
  change('军队维护费', '-20');
  change('行政变化原因', '休养生息');
  fireEvent.click(screen.getByRole('button', { name: '添加行政变化' }));
  const item = onChange.mock.calls[0]![0][0] as GovernmentChange;
  expect(item).toMatchObject({
    kind: 'Policy',
    actionId: 'action',
    expectedRevision: 7,
    effects: { Tax: -10, ArmyMaintenance: -20 },
  });
  const p = item.after as NationalPolicy;
  expect(p.startsAt).toEqual({
    gameYear: 3,
    season: 'Spring',
    sequenceNumber: 9,
  });
  expect(p.expiresAt).toEqual({
    gameYear: 3,
    season: 'Autumn',
    sequenceNumber: 11,
  });
  expect(nationalPolicyStatus(p, 8)).toBe('Upcoming');
  expect(nationalPolicyStatus(p, 9)).toBe('Active');
  expect(nationalPolicyStatus(p, 11)).toBe('Expired');
  expect(toGovernmentInput(item)).not.toHaveProperty('after');
  expect(toGovernmentInput(item)).not.toHaveProperty('summary');
  expect(toGovernmentInput(item)).not.toHaveProperty('countryName');
  change('政策名称', '无效');
  change('政策条文', '测试');
  change('税收', '-101');
  change('行政变化原因', '测试');
  fireEvent.click(screen.getByRole('button', { name: '添加行政变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('-100%');
  expect(onChange).toHaveBeenCalledOnce();
});
it('retains unadded text and revision when rereading fails and workspaces change', async () => {
  const onChange = vi.fn(),
    view = render(
      <GovernmentEditor
        gameId="game"
        actionId={null}
        changes={[]}
        busy={false}
        active
        onChange={onChange}
      />,
    );
  expect(fetchGovernment).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('政府与长期政策', { exact: true }));
  await screen.findByLabelText('政体');
  change('政体', '共和国');
  change('行政变化原因', '建立议会');
  vi.mocked(fetchGovernment).mockRejectedValueOnce(new Error('读取失败'));
  fireEvent.click(screen.getByRole('button', { name: '重读行政资料' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('读取失败');
  expect(screen.getByLabelText('政体')).toHaveValue('共和国');
  view.rerender(
    <GovernmentEditor
      gameId="game"
      actionId={null}
      changes={[]}
      busy={false}
      active={false}
      onChange={onChange}
    />,
  );
  view.rerender(
    <GovernmentEditor
      gameId="game"
      actionId={null}
      changes={[]}
      busy={false}
      active
      onChange={onChange}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '添加行政变化' })).toBeEnabled(),
  );
  // A successful reread is allowed to refresh the unadded form.
  change('政体', '共和国');
  change('行政变化原因', '建立议会');
  fireEvent.click(screen.getByRole('button', { name: '添加行政变化' }));
  expect(onChange.mock.calls[0]![0][0]).toMatchObject({
    expectedRevision: 7,
    kind: 'Government',
  });
});
