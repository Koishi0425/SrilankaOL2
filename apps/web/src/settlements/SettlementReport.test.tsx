import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import type {
  QuarterSettlement,
  ResourceChange,
  SettlementRecruitment,
} from '@srilanka/contracts';
import {
  resourceTotals,
  SettlementReport,
  SettlementResourceSummary,
} from './SettlementReport.js';

const resource = (
  id: string,
  amount: number,
  before: number,
  kind: ResourceChange['resource'] = 'Treasury',
): ResourceChange => ({
  id,
  actionId: 'canal',
  countryId: 'river',
  countryName: '河谷',
  resource: kind,
  amount,
  before,
  after: before + amount,
  expectedResourceRevision: 1,
  reason: '修渠拨款',
});
const report: QuarterSettlement = {
  quarter: {
    id: 'q',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'Published',
    actionDeadline: null,
    currentWorldVersion: 1,
  },
  isCurrent: false,
  version: 1,
  publishedAt: '2026-10-17T00:00:00Z',
  publicReport: '两国恢复水道通航。',
  actions: [
    {
      actionId: 'canal',
      countryId: 'river',
      countryName: '河谷',
      title: '修复水渠',
      status: 'Completed',
      submittedText: '投入一百二十修渠。',
      feedback: '水渠已修复。',
      reviewReason: '',
    },
    {
      actionId: 'scout',
      countryId: 'coast',
      countryName: '海岸',
      title: '寻找水道',
      status: 'Completed',
      submittedText: '派出向导。',
      feedback: '向导带回水道图。',
      reviewReason: '',
    },
  ],
  resourceChanges: [resource('cost', -120, 1000)],
  stateChanges: [
    {
      id: 'development',
      actionId: 'canal',
      kind: 'Province',
      provinceId: 'p',
      expectedProfileRevision: 1,
      values: { productionBase: 8 },
      beforeValues: { productionBase: 6 },
      provinceName: '河谷省',
      reason: '水渠建成',
      summary: '河谷省：生产基础 6 → 8',
    },
  ],
};
afterEach(cleanup);

it('shows shared feedback without offering the original policy or its discussion', () => {
  render(
    <SettlementReport
      data={{
        ...report,
        actions: [
          {
            ...report.actions[0]!,
            title: '政策结算结果',
            submittedText: '',
            reviewReason: '',
            refs: [],
            canViewPolicy: false,
          },
        ],
      }}
      host={false}
      onError={vi.fn()}
      onDiscussAction={vi.fn()}
    />,
  );
  expect(screen.getByText('水渠已修复。')).toBeInTheDocument();
  expect(screen.getByText('河谷')).toBeInTheDocument();
  expect(screen.queryByText('政策原文')).not.toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: '讨论这份政策' }),
  ).not.toBeInTheDocument();
});

it('totals mixed receipts, costs and manpower without mixing resources or losing decimal precision', () => {
  expect(
    resourceTotals([
      resource('tax', 0.1, 1000),
      resource('trade', 0.2, 1000.1),
      resource('fee', -120, 1000.3),
      resource('growth', 450, 5000, 'Manpower'),
      resource('recruits', -300, 5450, 'Manpower'),
    ])[0],
  ).toEqual({
    id: 'river',
    name: '河谷',
    resources: {
      Treasury: { before: 1000, amount: -119.7, after: 880.3 },
      Manpower: { before: 5000, amount: 150, after: 5150 },
    },
  });
});

it('includes recruitment costs in the total and leaves an unreported resource unknown', () => {
  const recruitment: SettlementRecruitment = {
    id: 'recruit',
    actionId: null,
    kind: 'Create',
    countryId: 'river',
    countryName: '河谷',
    name: '新军',
    armyName: '新军',
    tileId: 'tile',
    q: 0,
    r: 0,
    strength: 300,
    treasuryCost: 20,
    manpowerCost: 300,
    expectedResourceRevision: 1,
    note: '',
    beforeStrength: 0,
    afterStrength: 300,
    summary: '组建新军',
    costs: [resource('recruit-fee', -20, 880)],
  };
  render(
    <SettlementResourceSummary
      data={{ ...report, recruitments: [recruitment] }}
    />,
  );
  const row = screen.getByRole('row', { name: /河谷 -140/ });
  expect(row).toHaveTextContent('1,000 → 860');
  expect(within(row).getByText('—')).toBeInTheDocument();
});

it('keeps policy feedback and its costs and development together, with the public report first', () => {
  render(<SettlementReport data={report} host onError={vi.fn()} />);
  const articles = screen.getAllByRole('article');
  expect(
    within(articles[0]!).getByRole('heading', { name: '回合公报' }),
  ).toBeInTheDocument();
  const canal = screen.getByRole('article', { name: '河谷 · 修复水渠' });
  expect(canal).toHaveTextContent('水渠已修复。');
  expect(canal).toHaveTextContent('国库 -120');
  expect(canal).toHaveTextContent('生产基础 6 → 8');
  fireEvent.change(screen.getByLabelText('筛选结果国家'), {
    target: { value: 'coast' },
  });
  expect(
    screen.queryByRole('article', { name: '河谷 · 修复水渠' }),
  ).not.toBeInTheDocument();
  expect(
    screen.getByRole('article', { name: '海岸 · 寻找水道' }),
  ).toHaveTextContent('向导带回水道图。');
  expect(screen.getByText('两国恢复水道通航。')).toBeInTheDocument();
});

it('does not render host accounting or structured world truth in the player reading view', () => {
  const discuss = vi.fn().mockResolvedValue(undefined);
  render(
    <SettlementReport
      data={{ ...report, actions: [report.actions[0]!] }}
      host={false}
      onError={vi.fn()}
      onDiscussAction={discuss}
    />,
  );
  expect(screen.queryByLabelText('本季收支汇总')).not.toBeInTheDocument();
  expect(screen.queryByText('河谷省：生产基础 6 → 8')).not.toBeInTheDocument();
  expect(screen.queryByText('国库 -120')).not.toBeInTheDocument();
  expect(screen.getByText('水渠已修复。')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '讨论这份政策' }));
  expect(discuss).toHaveBeenCalledWith('canal');
});
