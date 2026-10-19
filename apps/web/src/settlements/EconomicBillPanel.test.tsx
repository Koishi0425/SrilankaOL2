import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useState } from 'react';
import type { EconomicBill } from '@srilanka/contracts';
import {
  EconomicBillPanel,
  EconomicBillTable,
  toEconomicBillInput,
} from './EconomicBillPanel.js';
const bill: EconomicBill = {
  capturedAt: '2026-10-13T00:00:00Z',
  worldVersion: 3,
  rulesRevision: 1,
  rules: {
    enabled: true,
    taxCoefficient: 10,
    productionCoefficient: 0,
    manpowerCoefficient: 0,
    armyMaintenancePer100: 0,
    administrationCost: 0,
  },
  effects: [],
  lines: [
    {
      id: 'tax',
      countryId: 'north',
      countryName: '北国',
      kind: 'Tax',
      resource: 'Treasury',
      calculatedAmount: 68,
      amount: 68,
      expectedResourceRevision: 2,
      adjustmentReason: '',
      sources: [{ name: '北方省', calculation: '8 × 10 × 0.85', amount: 68 }],
    },
  ],
};
afterEach(cleanup);
it('summarizes actual income and expenses separately from manpower and marks only corrected amounts', () => {
  render(
    <EconomicBillTable
      bill={{
        ...bill,
        lines: [
          { ...bill.lines[0]!, amount: 60, adjustmentReason: '减税' },
          {
            ...bill.lines[0]!,
            id: 'upkeep',
            kind: 'ArmyMaintenance',
            calculatedAmount: -12,
            amount: -12,
          },
          {
            ...bill.lines[0]!,
            id: 'manpower',
            kind: 'ManpowerGrowth',
            resource: 'Manpower',
            calculatedAmount: 450,
            amount: 450,
          },
        ],
      }}
    />,
  );
  const country = screen.getByRole('region', { name: '北国经济账单' });
  expect(within(country).getByText('+48')).toBeInTheDocument();
  expect(
    within(country).getByText('+450', { selector: 'dd' }),
  ).toBeInTheDocument();
  expect(within(country).getByText('计算 +68')).toBeInTheDocument();
  expect(within(country).queryByText('计算 -12')).not.toBeInTheDocument();
});
it('shows the captured policy text and percentage behind a corrected line, excluding policy metadata from requests', async () => {
  const q = { gameYear: 1, season: 'Spring' as const, sequenceNumber: 1 };
  const policyBill: EconomicBill = {
    ...bill,
    policies: [
      {
        id: 'p',
        countryId: 'north',
        countryName: '北国',
        title: '两季减税',
        type: 'Policy',
        text: '未来两季减税以休养生息',
        effects: { Tax: -10 },
        startsAt: q,
        expiresAt: { ...q, season: 'Autumn', sequenceNumber: 3 },
        endedAt: null,
      },
    ],
    lines: [
      {
        ...bill.lines[0]!,
        baseAmount: 68,
        calculatedAmount: 61.2,
        amount: 60,
        adjustmentReason: '本季灾害',
        policyEffects: [{ policyId: 'p', title: '两季减税', percent: -10 }],
      },
    ],
  };
  render(
    <EconomicBillPanel
      status={{ status: 'Ready', capturedAt: bill.capturedAt }}
      bill={policyBill}
      busy={false}
      onGenerate={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('每季经济账单（已生成）'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看或修正：北国 税收' }),
  );
  fireEvent.click(screen.getByText('期初长期政策依据'));
  fireEvent.click(screen.getByText('两季减税：-10%'));
  expect(screen.getByText('未来两季减税以休养生息')).toBeInTheDocument();
  expect(screen.getByText('政策前金额：+68')).toBeInTheDocument();
  expect(toEconomicBillInput(policyBill)).not.toHaveProperty('policies');
  expect(toEconomicBillInput(policyBill).lines[0]).not.toHaveProperty(
    'policyEffects',
  );
});
it('shows captured trade provinces and powers, and excludes the full snapshot from editable requests', async () => {
  const tradeBill: EconomicBill = {
    ...bill,
    rules: { ...bill.rules, tradeCoefficient: 10 },
    trade: [
      {
        id: 'zone',
        name: '海湾',
        revision: 1,
        provinces: [
          { id: 'p1', name: '北境', productionBase: 6, tileCount: 2 },
          { id: 'p2', name: '南境', productionBase: 4, tileCount: 2 },
        ],
        influences: [
          { countryId: 'north', power: 60 },
          { countryId: 'south', power: 40 },
        ],
      },
    ],
    lines: [
      {
        ...bill.lines[0]!,
        id: 'trade',
        kind: 'Trade',
        calculatedAmount: 60,
        amount: 60,
        sources: [
          { name: '海湾', calculation: '100 × 60/100（按分分配）', amount: 60 },
        ],
      },
    ],
  };
  render(
    <EconomicBillPanel
      status={{ status: 'Ready', capturedAt: bill.capturedAt }}
      bill={tradeBill}
      busy={false}
      onGenerate={vi.fn()}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('每季经济账单（已生成）'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看或修正：北国 贸易收入' }),
  );
  fireEvent.click(screen.getByText('海湾期初资料'));
  expect(screen.getByText('北境：生产基础 6')).toBeInTheDocument();
  expect(screen.getByText('南境：生产基础 4')).toBeInTheDocument();
  expect(toEconomicBillInput(tradeBill)).not.toHaveProperty('trade');
  expect(toEconomicBillInput(tradeBill).lines[0]).not.toHaveProperty('sources');
});
it('requires a reason for corrections, retains calculation sources and can restore the original amount', async () => {
  const changed = vi.fn();
  function Harness() {
    const [value, setValue] = useState<EconomicBill | null>(bill);
    return (
      <EconomicBillPanel
        status={{ status: 'Ready', capturedAt: bill.capturedAt }}
        bill={value}
        busy={false}
        onGenerate={vi.fn()}
        onChange={(next) => {
          changed(next);
          setValue(next);
        }}
      />
    );
  }
  render(<Harness />);
  fireEvent.click(screen.getByText('每季经济账单（已生成）'));
  fireEvent.click(
    await screen.findByRole('button', { name: '查看或修正：北国 税收' }),
  );
  expect(screen.getByText('北方省：8 × 10 × 0.85 = +68')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('本季实际额'), {
    target: { value: '60' },
  });
  fireEvent.click(screen.getByRole('button', { name: '应用修正' }));
  expect(screen.getByRole('alert')).toHaveTextContent('修正时须说明原因');
  expect(changed).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText('修正原因'), {
    target: { value: '减免灾区税收' },
  });
  fireEvent.click(screen.getByRole('button', { name: '应用修正' }));
  expect(changed.mock.lastCall![0].lines[0]).toMatchObject({
    amount: 60,
    calculatedAmount: 68,
    adjustmentReason: '减免灾区税收',
    sources: bill.lines[0]!.sources,
  });
  fireEvent.click(
    screen.getByRole('button', { name: '查看或修正：北国 税收' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '恢复计算值' }));
  expect(changed.mock.lastCall![0].lines[0]).toMatchObject({
    amount: 68,
    adjustmentReason: '',
  });
  fireEvent.click(screen.getByRole('button', { name: '移除账单' }));
  expect(changed).toHaveBeenLastCalledWith(null);
});
it('generates only after explicit action and sends only editable inputs', async () => {
  const generate = vi.fn();
  render(
    <EconomicBillPanel
      status={{ status: 'Ready', capturedAt: bill.capturedAt }}
      bill={null}
      busy={false}
      onGenerate={generate}
      onChange={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByText('每季经济账单'));
  fireEvent.click(await screen.findByRole('button', { name: '生成本季账单' }));
  expect(generate).toHaveBeenCalledOnce();
  expect(toEconomicBillInput(bill)).toEqual({
    lines: [
      {
        id: 'tax',
        countryId: 'north',
        kind: 'Tax',
        amount: 68,
        expectedResourceRevision: 2,
        adjustmentReason: '',
      },
    ],
  });
});
