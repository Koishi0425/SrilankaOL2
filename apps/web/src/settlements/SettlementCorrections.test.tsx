import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  QuarterSettlement,
  SettlementCorrectionOptions,
} from '@srilanka/contracts';
import { correctSettlement, fetchCorrectionOptions } from '../api.js';
import { SettlementCorrections } from './SettlementCorrections.js';
vi.mock('../api.js', () => ({
  correctSettlement: vi.fn(),
  fetchCorrectionOptions: vi.fn(),
}));
const data: QuarterSettlement = {
  quarter: {
    id: 'spring',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'Completed',
    actionDeadline: null,
    currentWorldVersion: 1,
  },
  isCurrent: false,
  version: 2,
  publishedAt: '2026-10-18T00:00:00Z',
  publicReport: '春季公报',
  correctionVersion: 0,
  corrections: [],
  actions: [
    {
      actionId: 'policy',
      countryId: 'country',
      countryName: '甲国',
      title: '建设',
      submittedText: '建设计划',
      status: 'Completed',
      reviewReason: '可行',
      feedback: '原反馈',
    },
  ],
};
const options: SettlementCorrectionOptions = {
  currentQuarter: { id: 'autumn', gameYear: 1, season: 'Autumn' },
  correctionVersion: 0,
  mapRevision: 10,
  countries: [
    {
      id: 'country',
      name: '甲国',
      treasury: 1000,
      manpower: 2000,
      resourceRevision: 3,
    },
  ],
  armies: [
    {
      id: 'army',
      name: '近卫军',
      countryId: 'country',
      countryName: '甲国',
      strength: 100,
    },
  ],
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(fetchCorrectionOptions).mockResolvedValue(structuredClone(options));
  vi.mocked(correctSettlement).mockResolvedValue({
    ...data,
    correctionVersion: 1,
  });
});
afterEach(cleanup);

it('previews a historical resource correction and retries a lost response with the same id', async () => {
  const done = vi.fn();
  render(
    <SettlementCorrections
      gameId="game"
      data={data}
      canCorrect
      onCorrected={done}
    />,
  );
  fireEvent.click(screen.getByText('更正已发布结果'));
  await screen.findByLabelText('更正内容');
  fireEvent.change(screen.getByLabelText('更正内容'), {
    target: { value: 'Resource' },
  });
  fireEvent.change(screen.getByLabelText('国家'), {
    target: { value: 'country' },
  });
  fireEvent.change(screen.getByLabelText('补正增减值'), {
    target: { value: '-75.25' },
  });
  fireEvent.change(screen.getByLabelText('更正原因'), {
    target: { value: '漏扣建设费用' },
  });
  expect(screen.getByText('当前 1,000 → 修正后 924.75')).toBeInTheDocument();
  expect(screen.getByText(/立即记入第 1 年秋季/)).toBeInTheDocument();
  fireEvent.click(screen.getByText('检查并发布'));
  expect(correctSettlement).not.toHaveBeenCalled();
  vi.mocked(correctSettlement).mockRejectedValueOnce(new Error('连接中断'));
  fireEvent.click(screen.getByText('确认发布更正'));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByText('确认发布更正'));
  await waitFor(() => expect(done).toHaveBeenCalledTimes(1));
  expect(vi.mocked(correctSettlement).mock.calls[0]).toEqual(
    vi.mocked(correctSettlement).mock.calls[1],
  );
  expect(vi.mocked(correctSettlement).mock.calls[0]?.[2]).toMatchObject({
    expectedCurrentQuarterId: 'autumn',
    expectedCorrectionVersion: 0,
    reason: '漏扣建设费用',
    change: {
      kind: 'Resource',
      countryId: 'country',
      resource: 'Treasury',
      amount: -75.25,
      expectedResourceRevision: 3,
    },
  });
});
it('loads effective policy feedback and requires a reason and a changed value', async () => {
  render(
    <SettlementCorrections
      gameId="game"
      data={data}
      canCorrect
      onCorrected={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('更正已发布结果'));
  await screen.findByLabelText('更正内容');
  fireEvent.change(screen.getByLabelText('更正内容'), {
    target: { value: 'ActionFeedback' },
  });
  fireEvent.change(screen.getByLabelText('政策'), {
    target: { value: 'policy' },
  });
  expect(screen.getByLabelText('修正后的全文')).toHaveValue('原反馈');
  fireEvent.change(screen.getByLabelText('更正原因'), {
    target: { value: '笔误' },
  });
  expect(screen.getByText('检查并发布')).toBeDisabled();
  fireEvent.change(screen.getByLabelText('修正后的全文'), {
    target: { value: '修正反馈' },
  });
  fireEvent.click(screen.getByText('检查并发布'));
  fireEvent.click(screen.getByText('确认发布更正'));
  await waitFor(() => expect(correctSettlement).toHaveBeenCalled());
  expect(vi.mocked(correctSettlement).mock.calls[0]?.[2].change).toEqual({
    kind: 'ActionFeedback',
    actionId: 'policy',
    text: '修正反馈',
  });
});
it('shows original text and the reason in history without granting an edit control to players or archives', () => {
  const record: QuarterSettlement = {
    ...data,
    corrections: [
      {
        id: 'fix',
        sequenceNumber: 1,
        createdAt: '2026-10-18T01:00:00Z',
        actorName: '主持人',
        reason: '笔误',
        appliedQuarter: options.currentQuarter,
        change: {
          kind: 'ActionFeedback',
          actionId: 'policy',
          countryId: 'country',
          title: '建设',
          before: '原文',
          after: '新文',
        },
      },
    ],
  };
  render(
    <SettlementCorrections
      gameId="game"
      data={record}
      canCorrect={false}
      onCorrected={vi.fn()}
    />,
  );
  expect(screen.queryByText('更正已发布结果')).not.toBeInTheDocument();
  expect(screen.getByText('原因：笔误')).toBeInTheDocument();
  fireEvent.click(screen.getByText('修改前后'));
  expect(screen.getAllByText('原文')).toHaveLength(2);
  expect(screen.getByText('新文')).toBeInTheDocument();
});
it('refuses to open an outdated correction form', async () => {
  vi.mocked(fetchCorrectionOptions).mockResolvedValue({
    ...options,
    correctionVersion: 2,
  });
  render(
    <SettlementCorrections
      gameId="game"
      data={data}
      canCorrect
      onCorrected={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('更正已发布结果'));
  expect(await screen.findByRole('alert')).toHaveTextContent('结算已更正');
  expect(screen.queryByLabelText('更正内容')).not.toBeInTheDocument();
});
