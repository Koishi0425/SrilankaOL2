import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import type { DiplomacyChange, DiplomacyData } from '@srilanka/contracts';
import { toDiplomacyInput, treatyStatus } from '@srilanka/contracts';
import { fetchDiplomacy } from '../api.js';
import {
  DiplomacyEditor,
  DiplomacyForm,
  DiplomacyRecord,
} from './DiplomacyEditor.js';
vi.mock('../api.js', () => ({ fetchDiplomacy: vi.fn() }));
const data: DiplomacyData = {
  revision: 7,
  quarter: { gameYear: 2, season: 'Winter', sequenceNumber: 8 },
  canEdit: false,
  countries: [
    { id: 'north', name: '北国' },
    { id: 'south', name: '南国' },
    { id: 'third', name: '山国' },
  ],
  relations: [],
  treaties: [],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchDiplomacy).mockResolvedValue(structuredClone(data));
});
afterEach(cleanup);
const change = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
it('adds directional guarantees with a clear expiry and only serializes user input', () => {
  const onChange = vi.fn();
  render(
    <DiplomacyForm
      data={data}
      actionId="action"
      changes={[]}
      busy={false}
      onChange={onChange}
    />,
  );
  change('外交操作', 'Treaty');
  expect(
    screen.queryByRole('option', { name: '军事通行' }),
  ).not.toBeInTheDocument();
  expect(
    screen.queryByRole('option', { name: '港口停泊' }),
  ).not.toBeInTheDocument();
  change('条约名称', '南海保障协议');
  change('条约类别', 'Guarantee');
  fireEvent.click(screen.getByLabelText('北国'));
  fireEvent.click(screen.getByLabelText('南国'));
  change('期限（季，含本回合；留空为长期）', '4');
  change('条约正文', '南国保障北国独立');
  change('外交变化原因', '双方达成约定');
  change('公开范围', 'Participants');
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('选择保障国');
  expect(onChange).not.toHaveBeenCalled();
  change('保障国', 'south');
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  const item = onChange.mock.calls[0]![0][0] as DiplomacyChange;
  expect(item).toMatchObject({
    kind: 'Treaty',
    expectedRevision: 7,
    actionId: 'action',
    type: 'Guarantee',
    grantorCountryId: 'south',
    visibility: 'Participants',
  });
  expect(item.after).toMatchObject({
    expiresAt: { gameYear: 3, season: 'Winter', sequenceNumber: 12 },
  });
  expect(toDiplomacyInput(item)).not.toHaveProperty('before');
  expect(toDiplomacyInput(item)).not.toHaveProperty('after');
  expect(toDiplomacyInput(item)).not.toHaveProperty('summary');
  expect(screen.getByLabelText('条约名称')).toHaveValue('');
  expect(screen.getByLabelText('外交变化原因')).toHaveValue('');
});
it('opens a legacy access agreement as ordinary text without permission or grantor controls', () => {
  const legacy = {
    id: 'legacy',
    title: '旧约定',
    type: 'MilitaryAccess' as const,
    countryIds: ['north', 'south'],
    countryNames: ['北国', '南国'],
    terms: '两国自行商定借道安排',
    visibility: 'Participants' as const,
    grantorCountryId: 'south',
    startQuarter: data.quarter,
    updatedQuarter: data.quarter,
    expiresAt: null,
    endedAt: null,
  };
  const onChange = vi.fn();
  render(
    <DiplomacyForm
      data={{ ...data, treaties: [legacy] }}
      actionId={null}
      changes={[]}
      busy={false}
      onChange={onChange}
    />,
  );
  change('外交操作', 'Treaty');
  change('条约', 'legacy');
  expect(screen.getByLabelText('条约类别')).toHaveValue('Custom');
  expect(screen.getByLabelText('条约正文')).toHaveValue(legacy.terms);
  expect(screen.queryByLabelText('保障国')).not.toBeInTheDocument();
  change('外交变化原因', '改为普通约定');
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  expect(onChange.mock.calls[0]![0][0]).toMatchObject({
    type: 'Custom',
    grantorCountryId: null,
    terms: legacy.terms,
  });
});
it('rejects duplicate pair changes, invalid treaty duration and missing terms', () => {
  const onChange = vi.fn(),
    existing: DiplomacyChange = {
      id: 'old',
      actionId: null,
      expectedRevision: 7,
      expectedQuarterSequence: 8,
      reason: '宣战',
      kind: 'WarStatus',
      countryIds: ['north', 'south'],
      state: 'War',
      summary: '宣战',
      before: null,
      after: {
        countryIds: ['north', 'south'],
        countryNames: ['北国', '南国'],
        state: 'War',
        effectiveQuarter: data.quarter,
        reason: '宣战',
      },
    };
  render(
    <DiplomacyForm
      data={data}
      actionId={null}
      changes={[existing]}
      busy={false}
      onChange={onChange}
    />,
  );
  change('国家一', 'south');
  change('国家二', 'north');
  change('外交变化原因', '再次宣战');
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('已有战争状态变化');
  change('外交操作', 'Treaty');
  change('条约名称', '结盟');
  fireEvent.click(screen.getByLabelText('北国'));
  fireEvent.click(screen.getByLabelText('南国'));
  change('外交变化原因', '双方同意');
  change('条约正文', '防御同盟');
  change('期限（季，含本回合；留空为长期）', '0');
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  expect(screen.getByRole('alert')).toHaveTextContent('有效期限');
  expect(onChange).not.toHaveBeenCalled();
});
it('retains unadded inputs and staged changes when rereading fails or switching workspaces', async () => {
  const onChange = vi.fn(),
    view = render(
      <DiplomacyEditor
        gameId="game"
        actionId={null}
        changes={[]}
        busy={false}
        active
        onChange={onChange}
      />,
    );
  expect(fetchDiplomacy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('外交', { exact: true }));
  await screen.findByLabelText('国家一');
  change('国家一', 'north');
  change('国家二', 'south');
  change('外交变化原因', '边境争端');
  vi.mocked(fetchDiplomacy).mockRejectedValue(new Error('网络失败'));
  fireEvent.click(screen.getByRole('button', { name: '重读外交资料' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('网络失败');
  expect(screen.getByLabelText('外交变化原因')).toHaveValue('边境争端');
  view.rerender(
    <DiplomacyEditor
      gameId="game"
      actionId={null}
      changes={[]}
      busy={false}
      active={false}
      onChange={onChange}
    />,
  );
  view.rerender(
    <DiplomacyEditor
      gameId="game"
      actionId={null}
      changes={[]}
      busy={false}
      active
      onChange={onChange}
    />,
  );
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '添加外交变化' })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole('button', { name: '添加外交变化' }));
  expect(onChange.mock.calls[0]![0][0]).toMatchObject({
    expectedRevision: 7,
    countryIds: ['north', 'south'],
  });
});
it('freezes treaty audience during amendments and displays ended and expired agreements', () => {
  const treaty = {
    id: 'treaty',
    title: '保障协议',
    type: 'Guarantee' as const,
    countryIds: ['north', 'south'],
    countryNames: ['北国', '南国'],
    terms: '保障北国独立',
    visibility: 'Participants' as const,
    grantorCountryId: 'south',
    startQuarter: data.quarter,
    updatedQuarter: data.quarter,
    expiresAt: { gameYear: 3, season: 'Spring' as const, sequenceNumber: 9 },
    endedAt: null,
  };
  render(
    <DiplomacyForm
      data={{ ...data, treaties: [treaty] }}
      actionId={null}
      changes={[]}
      busy={false}
      onChange={vi.fn()}
    />,
  );
  change('外交操作', 'Treaty');
  change('条约', 'treaty');
  expect(screen.getByLabelText('北国')).toBeDisabled();
  expect(screen.getByLabelText('公开范围')).toBeDisabled();
  expect(treatyStatus(treaty, 8)).toBe('Active');
  expect(treatyStatus(treaty, 9)).toBe('Expired');
  expect(treatyStatus({ ...treaty, endedAt: data.quarter }, 8)).toBe('Ended');
  cleanup();
  render(
    <DiplomacyRecord
      change={{
        id: 'end',
        actionId: null,
        expectedRevision: 7,
        expectedQuarterSequence: 8,
        reason: '提前终止',
        kind: 'EndTreaty',
        treatyId: 'treaty',
        before: treaty,
        after: { ...treaty, endedAt: data.quarter },
        summary: '终止条约：保障协议',
      }}
    />,
  );
  fireEvent.click(screen.getByText('终止条约：保障协议'));
  expect(screen.getByText('保障方向：南国 → 北国')).toBeInTheDocument();
  expect(screen.getByText(/终止：第 2 年 冬季/)).toBeInTheDocument();
});
