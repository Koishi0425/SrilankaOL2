import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  GameSummary,
  QuarterSettlement,
  DiplomacyChange,
  GovernmentChange,
} from '@srilanka/contracts';
import { toDiplomacyInput, toGovernmentInput } from '@srilanka/contracts';
import type * as ApiModule from '../api.js';

import {
  advanceQuarter,
  fetchSettlement,
  fetchSettlements,
  fetchSettlementStateOptions,
  publishSettlement,
  saveSettlement,
  rollSettlementBattle,
  fetchNationalStatus,
  fetchEconomicPreview,
} from '../api.js';
import { SettlementPanel } from './SettlementPanel.js';
import { DraftAccountProvider } from '../drafts/local-drafts.js';

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof ApiModule>()),
  advanceQuarter: vi.fn(),
  beginSettlement: vi.fn(),
  fetchSettlement: vi.fn(),
  fetchSettlements: vi.fn(),
  fetchSettlementStateOptions: vi.fn(),
  publishSettlement: vi.fn(),
  saveSettlement: vi.fn(),
  rollSettlementBattle: vi.fn(),
  fetchNationalStatus: vi.fn(),
  fetchEconomicPreview: vi.fn(),
}));
const game: GameSummary = {
  id: 'game',
  name: '诸国时代',
  status: 'Running',
  role: 'Host',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'Resolving',
    actionDeadline: null,
    currentWorldVersion: 0,
  },
};
const draft: QuarterSettlement = {
  quarter: game.currentQuarter,
  isCurrent: true,
  version: 1,
  publishedAt: null,
  publicReport: '',
  actions: [
    {
      actionId: 'action',
      countryId: 'country',
      countryName: '康提',
      title: '北方探索',
      submittedText: '派出三十人',
      status: 'Approved',
      reviewReason: '可行',
      feedback: '',
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(fetchSettlement).mockResolvedValue(structuredClone(draft));
  vi.mocked(fetchNationalStatus).mockResolvedValue({
    canSetBalances: false,
    countries: [
      {
        id: 'country',
        name: '康提',
        mapColor: '#000000',
        treasury: 500,
        manpower: 1000,
        resourceRevision: 2,
        controlledTileCount: 1,
        legalTileCount: 1,
        cities: [],
        armies: [],
      },
    ],
  });
  vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
    mapRevision: 7,
    countries: [{ id: 'country', name: '康提' }],
    tiles: [
      { id: 'tile-a', q: 0, r: 0, passable: true },
      { id: 'tile-b', q: 1, r: 0, passable: true },
    ],
    armies: [
      {
        id: 'army',
        name: '北军',
        countryId: 'country',
        countryName: '康提',
        tileId: 'tile-a',
        q: 0,
        r: 0,
        strength: 1000,
      },
    ],
  });
  vi.mocked(fetchSettlements).mockResolvedValue([
    {
      quarterId: 'quarter',
      gameYear: 1,
      season: 'Spring',
      sequenceNumber: 1,
      state: 'Resolving',
      isCurrent: true,
      publishedAt: null,
    },
  ]);
});
afterEach(cleanup);

describe('settlement writing and publication', () => {
  it('replaces a previous round with a placeholder until the selected round arrives', async () => {
    const current = {
      ...draft,
      publicReport: '当前回合公开报告',
      publishedAt: '2026-10-28T00:00:00Z',
    };
    vi.mocked(fetchSettlement).mockResolvedValue(current);
    const rounds = await fetchSettlements('game');
    vi.mocked(fetchSettlements).mockResolvedValue([
      ...rounds,
      { ...rounds[0]!, quarterId: 'older', isCurrent: false },
    ]);
    render(
      <SettlementPanel
        game={{ ...game, role: 'Player' }}
        onQuarterChange={vi.fn()}
      />,
    );
    await screen.findByText('当前回合公开报告');
    let resolve!: (value: QuarterSettlement) => void;
    vi.mocked(fetchSettlement).mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    fireEvent.change(screen.getByRole('combobox', { name: '查看回合' }), {
      target: { value: 'older' },
    });
    expect(
      screen.getByRole('status', { name: '正在读取回合结算…' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('当前回合公开报告')).not.toBeInTheDocument();
    await act(async () =>
      resolve({
        ...current,
        quarter: { ...current.quarter, id: 'older' },
        isCurrent: false,
        publicReport: '旧回合公开报告',
      }),
    );
    await screen.findByText('旧回合公开报告');
    expect(
      screen.queryByRole('status', { name: '正在读取回合结算…' }),
    ).not.toBeInTheDocument();
  });

  it('replaces the initial settlement placeholder with a recoverable error', async () => {
    vi.mocked(fetchSettlement).mockRejectedValue(new Error('结算连接中断'));
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    await screen.findByText('结算连接中断');
    expect(
      screen.queryByRole('status', { name: '正在读取回合结算…' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '刷新' })).toBeEnabled();
  });

  it('recovers and saves selected result recipients with the feedback', async () => {
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      resultCountries: [
        { id: 'country', name: '康提' },
        { id: 'coast', name: '海岸' },
      ],
    });
    vi.mocked(saveSettlement).mockResolvedValue({ ...draft, version: 2 });
    const editor = () => (
      <DraftAccountProvider userId="host">
        <SettlementPanel game={game} onQuarterChange={vi.fn()} />
      </DraftAccountProvider>
    );
    const page = render(editor());
    fireEvent.click(
      await screen.findByRole('button', { name: /北方探索.*康提/ }),
    );
    expect(screen.getByLabelText('可见范围')).toHaveValue('OwnerOnly');
    fireEvent.change(screen.getByLabelText('可见范围'), {
      target: { value: 'Countries' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: '海岸' }));
    fireEvent.click(screen.getByRole('checkbox', { name: '康提' }));
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '海岸方面发现了探险队。' },
    });
    page.unmount();
    render(editor());
    fireEvent.click(await screen.findByText('继续编写本地稿'));
    fireEvent.click(screen.getByRole('button', { name: /北方探索.*康提/ }));
    expect(screen.getByLabelText('可见范围')).toHaveValue('Countries');
    expect(screen.getByRole('checkbox', { name: '海岸' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: '康提' })).not.toBeChecked();
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue(
      '海岸方面发现了探险队。',
    );
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveSettlement).toHaveBeenCalled());
    expect(vi.mocked(saveSettlement).mock.calls[0]![2].results).toEqual([
      {
        actionId: 'action',
        feedback: '海岸方面发现了探险队。',
        resultAudience: { kind: 'Countries', countryIds: ['coast'] },
      },
    ]);
    expect(publishSettlement).not.toHaveBeenCalled();
  });
  it('filters the queue without losing feedback or excluding hidden policies from the saved settlement', async () => {
    const initial = {
      ...draft,
      actions: [
        draft.actions[0]!,
        {
          ...draft.actions[0]!,
          actionId: 'second',
          title: '南方建设',
          countryName: '南国',
          countryId: 'south',
          feedback: '水渠已完工',
        },
      ],
    };
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    vi.mocked(saveSettlement).mockImplementation(async () => ({
      ...initial,
      version: 2,
      actions: initial.actions.map((item) => ({
        ...item,
        feedback:
          item.actionId === 'action' ? '已经确认了新道路' : item.feedback,
      })),
    }));
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /北方探索.*康提/ }),
    );
    fireEvent.click(screen.getByLabelText('只看未填写'));
    expect(
      screen.queryByRole('button', { name: /南方建设.*南国/ }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '已经确认了新道路' },
    });
    expect(screen.getByText('没有匹配的政策。')).toBeVisible();
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue(
      '已经确认了新道路',
    );
    fireEvent.click(screen.getByRole('button', { name: '显示全部政策' }));
    fireEvent.change(screen.getByLabelText('搜索待结算政策'), {
      target: { value: '南国' },
    });
    expect(
      screen.getByRole('button', { name: /南方建设.*南国/ }),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: /北方探索.*康提/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveSettlement).toHaveBeenCalled());
    expect(vi.mocked(saveSettlement).mock.calls[0]![2].results).toEqual(
      expect.arrayContaining([
        { actionId: 'action', feedback: '已经确认了新道路' },
        { actionId: 'second', feedback: '水渠已完工' },
      ]),
    );
  });
  it('recovers only unsaved text on the same server revision, leaving publication explicit', async () => {
    const editor = () => (
      <DraftAccountProvider userId="host">
        <SettlementPanel game={game} onQuarterChange={vi.fn()} />
      </DraftAccountProvider>
    );
    const page = render(editor());
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '写了一半的结算故事' },
    });
    page.unmount();
    render(editor());
    await screen.findByText('继续编写本地稿');
    fireEvent.click(screen.getByText('继续编写本地稿'));
    expect(screen.getByLabelText('回合公报（全员可见）')).toHaveValue(
      '写了一半的结算故事',
    );
    expect(saveSettlement).not.toHaveBeenCalled();
    expect(publishSettlement).not.toHaveBeenCalled();
  });
  it('offers only copying after the server settlement version changes', async () => {
    const editor = () => (
      <DraftAccountProvider userId="host">
        <SettlementPanel game={game} onQuarterChange={vi.fn()} />
      </DraftAccountProvider>
    );
    const page = render(editor());
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '旧稿' },
    });
    page.unmount();
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      version: 2,
      publicReport: '服务器新稿',
    });
    render(editor());
    await screen.findByText('服务器内容或阶段已变化，本地稿仅供复制。');
    expect(screen.queryByText('继续编写本地稿')).not.toBeInTheDocument();
    expect(screen.getByLabelText('回合公报（全员可见）')).toHaveValue(
      '服务器新稿',
    );
    expect(
      (screen.getByLabelText('本地草稿全文') as HTMLTextAreaElement).value,
    ).toContain('旧稿');
  });
  it('moves to the next unfinished policy while retaining the previous unsaved feedback', async () => {
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      actions: [
        draft.actions[0]!,
        { ...draft.actions[0]!, actionId: 'second', title: '南方建设' },
      ],
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.click(
      await screen.findByRole('button', { name: '下一项待填写' }),
    );
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '北境探明了新水道' },
    });
    fireEvent.click(screen.getByRole('button', { name: '下一项待填写' }));
    expect(
      screen.getByRole('heading', { name: '康提 · 南方建设' }),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: /北方探索.*已填写/ }));
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue(
      '北境探明了新水道',
    );
    expect(saveSettlement).not.toHaveBeenCalled();
  });
  it('shows the published result when the player receives a live quarter update', async () => {
    const playerGame: GameSummary = { ...game, role: 'Player' };
    const props = { game: playerGame, onQuarterChange: vi.fn() };
    const view = render(<SettlementPanel {...props} />);
    await screen.findByText('本回合尚未发布结果。');
    const quarter: GameSummary['currentQuarter'] = {
      ...game.currentQuarter,
      state: 'Published',
      currentWorldVersion: 1,
    };
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      quarter,
      publishedAt: '2026-10-17T00:00:00Z',
      publicReport: '夏季结果已送达',
      actions: [{ ...draft.actions[0]!, feedback: '侦察队已经归来' }],
    });
    view.rerender(
      <SettlementPanel
        {...props}
        game={{ ...playerGame, currentQuarter: quarter }}
      />,
    );
    await screen.findByText('侦察队已经归来');
    expect(screen.queryByText('本回合尚未发布结果。')).not.toBeInTheDocument();
  });

  it('keeps host feedback being written when a live world update arrives', async () => {
    const props = { game, onQuarterChange: vi.fn() };
    const view = render(<SettlementPanel {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /北方探索.*康提/ }),
    );
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '尚在编写的反馈' },
    });
    view.rerender(
      <SettlementPanel
        {...props}
        game={{
          ...game,
          currentQuarter: { ...game.currentQuarter, currentWorldVersion: 1 },
        }}
      />,
    );
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('尚在编写的反馈');
    expect(fetchSettlement).toHaveBeenCalledOnce();
  });

  it('focuses the reviewed policy, preselects its province and retains feedback and field inputs across map navigation', async () => {
    const ref = {
      refKind: 'Target' as const,
      objectType: 'Province' as const,
      objectId: 'province',
      label: '省份：北境',
    };
    const initial = structuredClone(draft);
    initial.actions[0]!.refs = [ref];
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
      mapRevision: 7,
      countries: [],
      tiles: [],
      armies: [],
      provinces: [
        {
          id: 'province',
          name: '北境',
          revision: 1,
          values: {
            taxBase: 8,
            productionBase: 6,
            manpowerBase: 5,
            autonomy: 15,
            unrest: 2,
          },
        },
      ],
    });
    const locate = vi.fn().mockResolvedValue(undefined);
    const props = {
      game,
      onQuarterChange: vi.fn(),
      focus: { actionId: 'action', key: 1 },
      onLocateReference: locate,
    };
    const { rerender } = render(<SettlementPanel {...props} active />);
    await screen.findByLabelText('生产基础调整后');
    expect(screen.getByLabelText('省份')).toHaveValue('province');
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '水渠已修复' },
    });
    fireEvent.change(screen.getByLabelText('生产基础调整后'), {
      target: { value: '9' },
    });
    fireEvent.click(screen.getByRole('button', { name: '省份：北境' }));
    expect(locate).toHaveBeenCalledWith(ref);
    rerender(<SettlementPanel {...props} active={false} />);
    rerender(<SettlementPanel {...props} active />);
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('水渠已修复');
    expect(screen.getByLabelText('生产基础调整后')).toHaveValue(9);
  });
  it('lets a player locate the province from published feedback without exposing host editing controls', async () => {
    const ref = {
      refKind: 'Target' as const,
      objectType: 'Province' as const,
      objectId: 'province',
      label: '省份：北境',
    };
    const published = structuredClone(draft);
    published.publishedAt = '2026-10-15T00:00:00Z';
    published.quarter.state = 'Published';
    published.actions[0]!.refs = [ref];
    published.actions[0]!.feedback = '水渠修复完毕';
    vi.mocked(fetchSettlement).mockResolvedValue(published);
    const locate = vi.fn().mockResolvedValue(undefined);
    render(
      <SettlementPanel
        game={{ ...game, role: 'Player' }}
        onQuarterChange={vi.fn()}
        onLocateReference={locate}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: '省份：北境' }));
    expect(locate).toHaveBeenCalledWith(ref);
    expect(screen.getByText('水渠修复完毕')).toBeVisible();
    expect(screen.queryByText('状态变化')).not.toBeInTheDocument();
    expect(fetchSettlementStateOptions).not.toHaveBeenCalled();
  });
  it('preserves administrative plans after save failures, reviews their timing and publishes without a map requirement', async () => {
    const q = { gameYear: 1, season: 'Summer' as const, sequenceNumber: 2 };
    const plan: GovernmentChange = {
      id: 'gov-plan',
      actionId: null,
      expectedRevision: 4,
      expectedQuarterSequence: 1,
      reason: '休养生息',
      kind: 'Policy',
      policyId: 'policy',
      countryId: 'country',
      countryName: '康提',
      title: '两季减税',
      type: 'Policy',
      text: '税收减少 10%',
      durationQuarters: 2,
      effects: { Tax: -10 },
      summary: '康提：施行政策“两季减税”（下季起）',
      before: null,
      after: {
        id: 'policy',
        countryId: 'country',
        countryName: '康提',
        title: '两季减税',
        type: 'Policy',
        text: '税收减少 10%',
        effects: { Tax: -10 },
        startsAt: q,
        expiresAt: { ...q, season: 'Winter', sequenceNumber: 4 },
        endedAt: null,
      },
    };
    const initial = { ...structuredClone(draft), governmentChanges: [plan] };
    initial.actions[0]!.feedback = '通过减税';
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    vi.mocked(saveSettlement)
      .mockRejectedValueOnce(new Error('保存中断'))
      .mockResolvedValueOnce({ ...initial, version: 2 });
    vi.mocked(publishSettlement).mockResolvedValue({
      ...initial,
      version: 2,
      publishedAt: '2026-10-13T00:00:00Z',
      quarter: { ...initial.quarter, state: 'Published' },
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '本季改革完成' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存中断');
    expect(
      vi.mocked(saveSettlement).mock.lastCall![2].governmentChanges,
    ).toEqual([toGovernmentInput(plan)]);
    expect(vi.mocked(saveSettlement).mock.lastCall![2]).not.toHaveProperty(
      'expectedMapRevision',
    );
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布本回合' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText(/长期政策从下季生效/)).toBeInTheDocument();
    fireEvent.click(screen.getByText(plan.summary));
    expect(screen.getByText('税收减少 10%')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    expect(await screen.findByText('已执行行政变化')).toBeInTheDocument();
  });
  it('retains diplomatic plans after save failure, sends only inputs without map requirements and reviews them before publication', async () => {
    const q = { gameYear: 1, season: 'Spring' as const, sequenceNumber: 1 };
    const plan: DiplomacyChange = {
      id: 'diplomacy-plan',
      actionId: null,
      expectedRevision: 4,
      expectedQuarterSequence: 1,
      reason: '边境争端',
      kind: 'WarStatus',
      countryIds: ['north', 'south'],
      state: 'War',
      summary: '北国 ↔ 南国：和平 → 交战',
      before: null,
      after: {
        countryIds: ['north', 'south'],
        countryNames: ['北国', '南国'],
        state: 'War',
        effectiveQuarter: q,
        reason: '边境争端',
      },
    };
    const initial: QuarterSettlement = {
      ...structuredClone(draft),
      diplomacyChanges: [plan],
    };
    initial.actions[0]!.feedback = '已记录外交情况';
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    vi.mocked(saveSettlement)
      .mockRejectedValueOnce(new Error('保存中断'))
      .mockResolvedValueOnce({ ...initial, version: 2 });
    vi.mocked(publishSettlement).mockResolvedValue({
      ...initial,
      version: 2,
      publishedAt: '2026-10-13T00:00:00Z',
      quarter: { ...initial.quarter, state: 'Published' },
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '边境局势变化' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存中断');
    expect(screen.getByText('外交（1）')).toBeInTheDocument();
    expect(
      vi.mocked(saveSettlement).mock.lastCall![2].diplomacyChanges,
    ).toEqual([toDiplomacyInput(plan)]);
    expect(vi.mocked(saveSettlement).mock.lastCall![2]).not.toHaveProperty(
      'expectedMapRevision',
    );
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布本回合' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText('同时执行 1 项外交变化：')).toBeInTheDocument();
    fireEvent.click(screen.getByText(plan.summary));
    expect(screen.getByText('边境争端')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    expect(await screen.findByText('已执行外交变化')).toBeInTheDocument();
    expect(screen.getByText(plan.summary)).toBeInTheDocument();
  });
  it('retains province plans after a failed save, sends only inputs and shows reasons in publication and immutable history', async () => {
    const initial: QuarterSettlement = {
      ...structuredClone(draft),
      mapRevision: 7,
      stateChanges: [
        {
          id: 'province-plan',
          actionId: 'action',
          kind: 'Province',
          provinceId: 'province',
          expectedProfileRevision: 2,
          values: { productionBase: 7 },
          reason: '工坊建成',
          provinceName: '北方省',
          beforeValues: { productionBase: 6 },
          summary: '北方省：生产基础 6 → 7',
        },
      ],
    };
    initial.actions[0]!.feedback = '北方工坊建成。';
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    vi.mocked(saveSettlement)
      .mockRejectedValueOnce(new Error('保存中断'))
      .mockResolvedValueOnce({ ...initial, version: 2 });
    vi.mocked(publishSettlement).mockResolvedValue({
      ...initial,
      version: 2,
      publishedAt: '2026-10-13T00:00:00Z',
      quarter: { ...initial.quarter, state: 'Published' },
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '地方建设完成' },
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /北方探索/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /北方探索/ }));
    fireEvent.click(screen.getByText('状态变化（1）'));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('保存中断');
    expect(screen.getByText(/北方省：生产基础 6 → 7/)).toHaveTextContent(
      '工坊建成',
    );
    expect(vi.mocked(saveSettlement).mock.lastCall![2].stateChanges).toEqual([
      {
        id: 'province-plan',
        actionId: 'action',
        kind: 'Province',
        provinceId: 'province',
        expectedProfileRevision: 2,
        values: { productionBase: 7 },
        reason: '工坊建成',
      },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布本回合' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText('同时执行 1 项状态变化：')).toBeInTheDocument();
    expect(screen.getAllByText(/北方省：生产基础 6 → 7/)).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    expect(await screen.findByText('已执行状态变化')).toBeInTheDocument();
    expect(screen.getByText(/北方省：生产基础 6 → 7/)).toHaveTextContent(
      '工坊建成',
    );
    expect(
      screen.queryByRole('button', { name: '添加变化' }),
    ).not.toBeInTheDocument();
  });
  it('keeps unsaved feedback during bill generation, retries failure and reviews saved economic effects before publishing', async () => {
    const initial = {
      ...structuredClone(draft),
      economyStatus: {
        status: 'Ready' as const,
        capturedAt: '2026-10-13T00:00:00Z',
      },
      economicBill: null,
    };
    initial.actions[0]!.feedback = '原反馈';
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    const economicBill = {
      capturedAt: '2026-10-13T00:00:00Z',
      worldVersion: 1,
      rulesRevision: 1,
      rules: {
        enabled: true,
        taxCoefficient: 10,
        productionCoefficient: 0,
        manpowerCoefficient: 0,
        armyMaintenancePer100: 0,
        administrationCost: 0,
      },
      lines: [
        {
          id: 'tax',
          countryId: 'country',
          countryName: '康提',
          kind: 'Tax' as const,
          resource: 'Treasury' as const,
          calculatedAmount: 68,
          amount: 68,
          expectedResourceRevision: 2,
          adjustmentReason: '',
          sources: [
            { name: '北方省', calculation: '8 × 10 × 0.85', amount: 68 },
          ],
        },
      ],
      effects: [],
    };
    vi.mocked(fetchEconomicPreview)
      .mockRejectedValueOnce(new Error('账单读取失败'))
      .mockResolvedValueOnce(economicBill);
    vi.mocked(saveSettlement).mockImplementation(
      async (_game, _quarter, input) => ({
        ...initial,
        publicReport: input.publicReport,
        actions: initial.actions.map((a) => ({
          ...a,
          feedback: input.results[0]!.feedback,
        })),
        version: 2,
        economicBill: {
          ...economicBill,
          effects: [
            {
              id: 'tax',
              actionId: null,
              countryId: 'country',
              countryName: '康提',
              resource: 'Treasury',
              amount: 68,
              expectedResourceRevision: 2,
              reason: '每季税收',
              before: 500,
              after: 568,
            },
          ],
        },
      }),
    );
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    await screen.findByLabelText('回合公报（全员可见）');
    expect(screen.getByRole('button', { name: '发布本回合' })).toBeDisabled();
    expect(screen.getByText('经济账单尚未生成')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /北方探索/ })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /北方探索/ }));
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '保留最新反馈' },
    });
    fireEvent.click(screen.getByText('每季经济账单'));
    fireEvent.click(
      await screen.findByRole('button', { name: '生成本季账单' }),
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('账单读取失败');
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('保留最新反馈');
    fireEvent.click(screen.getByRole('button', { name: '生成本季账单' }));
    await screen.findByText('每季经济账单（已生成）');
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('保留最新反馈');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布本回合' })).toBeEnabled(),
    );
    expect(vi.mocked(saveSettlement).mock.lastCall![2].economicBill).toEqual({
      lines: [
        {
          id: 'tax',
          countryId: 'country',
          kind: 'Tax',
          amount: 68,
          expectedResourceRevision: 2,
          adjustmentReason: '',
        },
      ],
    });
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText('同时执行每季经济账单：')).toBeInTheDocument();
    expect(
      screen.getByText('康提 · 国库 +68（500 → 568）'),
    ).toBeInTheDocument();
  });
  it('retains recruitment after failed save, sends only inputs and reviews automatic fees before publication', async () => {
    const recruitment = {
      id: 'recruitment',
      actionId: null,
      kind: 'Create' as const,
      countryId: 'country',
      countryName: '康提',
      name: '第二军',
      armyName: '第二军',
      tileId: 'tile-a',
      q: 0,
      r: 0,
      strength: 300,
      treasuryCost: 20,
      manpowerCost: 300,
      expectedResourceRevision: 2,
      note: '征募志愿兵',
      beforeStrength: 0,
      afterStrength: 300,
      summary: '康提：组建第二军，300 人，驻地 (0, 0)',
      costs: [
        {
          id: 'fee',
          actionId: null,
          countryId: 'country',
          countryName: '康提',
          expectedResourceRevision: 2,
          resource: 'Treasury' as const,
          amount: -20,
          reason: '组建第二军',
          before: 500,
          after: 480,
        },
      ],
    };
    const initial = {
      ...structuredClone(draft),
      mapRevision: 7,
      recruitments: [recruitment],
      resourceChanges: [],
    };
    initial.actions[0]!.feedback = '完成';
    vi.mocked(fetchSettlement).mockResolvedValue(initial);
    vi.mocked(saveSettlement)
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce({ ...initial, version: 2 });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    const report = await screen.findByLabelText('回合公报（全员可见）');
    fireEvent.change(report, { target: { value: '本季整顿军备' } });
    fireEvent.click(screen.getByText('征兵（1 项）'));
    await screen.findByText(recruitment.summary);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
    expect(screen.getByText(recruitment.summary)).toBeInTheDocument();
    const input = vi.mocked(saveSettlement).mock.lastCall![2];
    expect(input.expectedMapRevision).toBe(7);
    expect(input.resourceChanges).toEqual([]);
    expect(input.recruitments![0]).toMatchObject({
      kind: 'Create',
      strength: 300,
      treasuryCost: 20,
      manpowerCost: 300,
    });
    expect(input.recruitments![0]).not.toHaveProperty('costs');
    expect(input.recruitments![0]).not.toHaveProperty('summary');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布本回合' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText('同时执行 1 项征兵：')).toBeInTheDocument();
    expect(
      screen.getByText(/国库 -20（500 → 480）· 组建第二军/),
    ).toBeInTheDocument();
  });
  it('preserves resource costs on save failure, strips projections and includes them in publication review', async () => {
    const saved = {
      ...structuredClone(draft),
      version: 2,
      resourceChanges: [
        {
          id: 'resource',
          actionId: null,
          countryId: 'country',
          countryName: '康提',
          expectedResourceRevision: 2,
          resource: 'Treasury' as const,
          amount: -20,
          reason: '建设拨款',
          before: 500,
          after: 480,
        },
      ],
    };
    saved.actions[0]!.feedback = '建设完成';
    vi.mocked(saveSettlement)
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce(saved);
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    await screen.findByLabelText('回合公报（全员可见）');
    fireEvent.click(screen.getByText('资源收支'));
    await screen.findByRole('option', { name: '康提' });
    fireEvent.change(
      screen.getByLabelText('增减数值（收入填正数，支出填负数）'),
      { target: { value: '-20' } },
    );
    fireEvent.change(screen.getByLabelText('原因'), {
      target: { value: '建设拨款' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加收支' }));
    fireEvent.click(screen.getByText('北方探索'));
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '建设完成' },
    });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('连接中断');
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('建设完成');
    expect(
      vi.mocked(saveSettlement).mock.lastCall![2].resourceChanges?.[0],
    ).toMatchObject({
      amount: -20,
      reason: '建设拨款',
      expectedResourceRevision: 2,
    });
    expect(
      vi.mocked(saveSettlement).mock.lastCall![2].resourceChanges?.[0],
    ).not.toHaveProperty('before');
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '发布本回合' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText('同时执行 1 笔资源收支：')).toBeInTheDocument();
    expect(
      screen.getByText(/国库 -20（500 → 480）· 建设拨款/),
    ).toBeInTheDocument();
  });
  it('saves a battle and text before rolling, retries the same dice request and keeps unresolved battles from publication', async () => {
    const options = await vi.mocked(fetchSettlementStateOptions)(
      'game',
      'quarter',
    );
    options.armies.push({
      id: 'enemy',
      name: '南军',
      countryId: 'other',
      countryName: '南国',
      tileId: 'tile-b',
      q: 1,
      r: 0,
      strength: 800,
    });
    vi.mocked(fetchSettlementStateOptions).mockClear();
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      mapRevision: 7,
      stateChanges: [],
      battles: [],
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '军队渡河交战。' },
    });
    fireEvent.click(screen.getByText('战斗'));
    await waitFor(() =>
      expect(screen.getByLabelText('战斗名称')).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('战斗名称'), {
      target: { value: '边城之战' },
    });
    fireEvent.change(screen.getByLabelText('战场列'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('战场行'), {
      target: { value: '0' },
    });
    fireEvent.change(screen.getByLabelText('进攻方军队 1'), {
      target: { value: 'army' },
    });
    fireEvent.change(screen.getByLabelText('防守方军队 1'), {
      target: { value: 'enemy' },
    });
    fireEvent.change(screen.getByLabelText('进攻方参战人数 1'), {
      target: { value: '600' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加战斗' }));
    fireEvent.click(screen.getByText('边城之战 · 待裁决'));
    expect(screen.getByRole('button', { name: '发布本回合' })).toBeDisabled();
    vi.mocked(saveSettlement).mockImplementation(
      async (_game, _quarter, input) => {
        const battle = input.battles![0]!;
        return {
          ...draft,
          version: 2,
          mapRevision: 7,
          stateChanges: [],
          actions: draft.actions.map((item) => ({
            ...item,
            feedback: '军队渡河交战。',
          })),
          battles: [
            {
              ...battle,
              q: 1,
              r: 0,
              participants: [...battle.attackers, ...battle.defenders].map(
                (item) => {
                  const army = options.armies.find(
                    (army) => army.id === item.armyId,
                  )!;
                  return {
                    ...item,
                    name: army.name,
                    countryId: army.countryId,
                    countryName: army.countryName,
                    originalStrength: army.strength,
                    originalTileId: army.tileId,
                    q: army.q,
                    r: army.r,
                  };
                },
              ),
              rolls: [],
              effects: [],
            },
          ],
        };
      },
    );
    vi.mocked(rollSettlementBattle).mockRejectedValueOnce(
      new Error('网络中断'),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存并掷骰' }));
    await screen.findByRole('button', { name: '重试同一次掷骰' });
    expect(saveSettlement).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(saveSettlement).mock.calls[0]![2].battles![0],
    ).not.toHaveProperty('rolls');
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('军队渡河交战。');
    const first = vi.mocked(rollSettlementBattle).mock.calls[0]![3];
    expect(first).toMatchObject({
      expectedVersion: 2,
      expectedMapRevision: 7,
      phase: 'Fire',
      sides: 10,
      zeroBased: true,
      count: 1,
    });
    const saved: QuarterSettlement =
      await vi.mocked(saveSettlement).mock.results[0]!.value;
    vi.mocked(rollSettlementBattle).mockResolvedValueOnce({
      ...saved,
      version: 3,
      battles: saved.battles!.map((battle) => ({
        ...battle,
        rolls: [
          {
            id: first.idempotencyKey,
            sequence: 1,
            createdAt: '2026-10-12T00:00:00Z',
            phase: 'Fire',
            count: 1,
            sides: 10,
            zeroBased: true,
            attackerModifier: 0,
            defenderModifier: 0,
            modifierNote: '',
            note: '',
            attackerDice: [7],
            defenderDice: [3],
            attackerTotal: 7,
            defenderTotal: 3,
          },
        ],
      })),
    });
    fireEvent.click(screen.getByRole('button', { name: '重试同一次掷骰' }));
    await screen.findByText('已记录掷骰');
    expect(screen.getByLabelText('阶段')).toHaveValue('Shock');
    expect(
      vi.mocked(rollSettlementBattle).mock.calls[1]![3].idempotencyKey,
    ).toBe(first.idempotencyKey);
    expect(saveSettlement).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/火力.*进攻 7/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('战斗结果'), {
      target: { value: 'AttackerVictory' },
    });
    fireEvent.change(screen.getByLabelText('康提 · 北军伤亡'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('裁决说明'), {
      target: { value: '北军攻占边城，南军撤退。' },
    });
    vi.mocked(saveSettlement).mockRejectedValueOnce(new Error('兵力已变化'));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByText('兵力已变化');
    expect(screen.getByLabelText('康提 · 北军伤亡')).toHaveValue(100);
    expect(screen.getByLabelText('裁决说明')).toHaveValue(
      '北军攻占边城，南军撤退。',
    );
  });

  it('does not mount battle tools for a player', async () => {
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      publishedAt: '2026-10-12T00:00:00Z',
    });
    render(
      <SettlementPanel
        game={{ ...game, role: 'Player' }}
        onQuarterChange={vi.fn()}
      />,
    );
    await screen.findByText('回合结果');
    expect(screen.queryByText('战斗')).not.toBeInTheDocument();
    expect(fetchSettlementStateOptions).not.toHaveBeenCalled();
  });
  it('keeps state changes and feedback after a failed save, checks them before publication and omits client summaries from the write', async () => {
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      mapRevision: 7,
      stateChanges: [],
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    expect(fetchSettlementStateOptions).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '军队损失二百八十人。' },
    });
    fireEvent.click(screen.getByText('状态变化'));
    fireEvent.change(
      await screen.findByRole('combobox', { name: /变化类型/ }),
      { target: { value: 'ArmyStrength' } },
    );
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /^军队/ })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole('combobox', { name: /^军队/ }), {
      target: { value: 'army' },
    });
    fireEvent.change(screen.getByLabelText('调整后兵力'), {
      target: { value: '720' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
    expect(screen.getByText('北军：兵力 1000 → 720')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '发布本回合' })).toBeDisabled();
    vi.mocked(saveSettlement).mockRejectedValueOnce(
      new Error('状态变化冲突，请重新检查。'),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue(
      '军队损失二百八十人。',
    );
    expect(screen.getByText('北军：兵力 1000 → 720')).toBeInTheDocument();
    const sent = vi.mocked(saveSettlement).mock.calls[0]![2];
    expect(sent.expectedMapRevision).toBe(7);
    expect(sent.stateChanges![0]).toEqual({
      id: expect.any(String),
      actionId: 'action',
      kind: 'ArmyStrength',
      armyId: 'army',
      strength: 720,
    });
    const savedChange = sent.stateChanges![0]!;
    if (savedChange.kind !== 'ArmyStrength')
      throw new Error('Expected strength change');
    const saved: QuarterSettlement = {
      ...draft,
      mapRevision: 7,
      version: 2,
      actions: draft.actions.map((item) => ({
        ...item,
        feedback: '军队损失二百八十人。',
      })),
      stateChanges: [{ ...savedChange, summary: '北军：兵力 1000 → 720' }],
    };
    vi.mocked(saveSettlement).mockResolvedValue(saved);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByText('已保存');
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(screen.getByText('同时执行 1 项状态变化：')).toBeInTheDocument();
    expect(
      screen.getByText('北方探索 · 北军：兵力 1000 → 720'),
    ).toBeInTheDocument();
    vi.mocked(publishSettlement).mockResolvedValue({
      ...saved,
      quarter: { ...saved.quarter, state: 'Published' },
      publishedAt: '2026-10-10T00:00:00Z',
    });
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await screen.findByText('已执行状态变化');
    expect(publishSettlement).toHaveBeenCalledWith('game', 'quarter', 2, 7);
    expect(
      screen.queryByRole('button', { name: '添加变化' }),
    ).not.toBeInTheDocument();
  });

  it('validates rectangular territory selections, keeps ownership unchanged when requested and can remove pending changes', async () => {
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      mapRevision: 7,
      stateChanges: [],
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.click(await screen.findByText('状态变化'));
    fireEvent.change(
      await screen.findByRole('combobox', { name: /变化类型/ }),
      { target: { value: 'Territory' } },
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '添加变化' })).toBeEnabled(),
    );
    for (const [label, value] of [
      ['起始列', '0'],
      ['结束列', '2'],
      ['起始行', '0'],
      ['结束行', '0'],
    ])
      fireEvent.change(screen.getByLabelText(label!), { target: { value } });
    fireEvent.change(screen.getByRole('combobox', { name: /控制国/ }), {
      target: { value: 'country' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('地图范围内');
    fireEvent.change(screen.getByLabelText('结束列'), {
      target: { value: '1' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
    expect(
      screen.getByText('2 个地块（列 0–1，行 0–0）：控制 → 康提'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      '已有领土变化重复',
    );
    vi.mocked(saveSettlement).mockRejectedValue(new Error('暂时无法保存'));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(saveSettlement).toHaveBeenCalled());
    expect(
      vi.mocked(saveSettlement).mock.calls[0]![2].stateChanges![0],
    ).toEqual({
      id: expect.any(String),
      actionId: null,
      kind: 'Territory',
      tileIds: ['tile-a', 'tile-b'],
      controllerCountryId: 'country',
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '移除' })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: '移除' }));
    expect(
      screen.queryByText('2 个地块（列 0–1，行 0–0）：控制 → 康提'),
    ).not.toBeInTheDocument();
  });

  it('does not silently refresh the revision beneath unsaved state changes or discard the story', async () => {
    vi.mocked(fetchSettlement).mockResolvedValue({
      ...draft,
      mapRevision: 7,
      stateChanges: [],
    });
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '尚未写完的公报' },
    });
    fireEvent.click(screen.getByText('状态变化'));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '添加变化' })).toBeEnabled(),
    );
    fireEvent.change(screen.getByRole('combobox', { name: /^军队/ }), {
      target: { value: 'army' },
    });
    fireEvent.change(screen.getByLabelText('目的地列'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByLabelText('目的地行'), {
      target: { value: '0' },
    });
    fireEvent.click(screen.getByRole('button', { name: '添加变化' }));
    vi.mocked(fetchSettlementStateOptions).mockResolvedValue({
      ...(await vi.mocked(fetchSettlementStateOptions).mock.results[0]!.value),
      mapRevision: 8,
    });
    fireEvent.click(screen.getByRole('button', { name: '重读当前状态' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '添加变化' })).toBeEnabled(),
    );
    vi.mocked(saveSettlement).mockRejectedValue(new Error('地图已变化'));
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByRole('alert');
    expect(
      vi.mocked(saveSettlement).mock.calls[0]![2].expectedMapRevision,
    ).toBe(7);
    expect(screen.getByLabelText('回合公报（全员可见）')).toHaveValue(
      '尚未写完的公报',
    );
    expect(screen.getByText('北军：(0, 0) → (1, 0)')).toBeInTheDocument();
  });
  it('shows exploration in publication review and passes the checked map revision', async () => {
    const complete: QuarterSettlement = {
      ...draft,
      mapRevision: 7,
      mapReveals: [
        {
          actionId: 'action',
          countryId: 'country',
          tileIds: ['tile-a', 'tile-b'],
          state: 'Mapped',
          note: '发现海岸',
          publishedAt: null,
        },
      ],
      actions: draft.actions.map((item) => ({ ...item, feedback: '探索结束' })),
    };
    vi.mocked(fetchSettlement).mockResolvedValue(complete);
    vi.mocked(publishSettlement).mockResolvedValue({
      ...complete,
      publishedAt: '2026-10-10T00:00:00Z',
      quarter: { ...complete.quarter, state: 'Published' },
    });
    const open = vi.fn();
    render(
      <SettlementPanel
        game={game}
        onQuarterChange={vi.fn()}
        onMapReveal={open}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    expect(
      screen.getByText('将揭示 2 个地块（已测绘）：发现海岸'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '设置探索结果' }));
    expect(open).toHaveBeenCalledWith({
      actionId: 'action',
      title: '北方探索',
      countryId: 'country',
      tileIds: ['tile-a', 'tile-b'],
    });
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(
      screen.getByText('同时发布 1 项探索结果，共涉及 2 次地块揭示。'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await waitFor(() =>
      expect(publishSettlement).toHaveBeenCalledWith('game', 'quarter', 1, 7),
    );
  });
  it('keeps an unsaved story when leaving and returning to the workspace tab', async () => {
    const changed = vi.fn();
    const view = render(
      <SettlementPanel game={game} active onQuarterChange={changed} />,
    );
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '写到一半的故事' },
    });
    view.rerender(
      <SettlementPanel game={game} active={false} onQuarterChange={changed} />,
    );
    view.rerender(
      <SettlementPanel game={game} active onQuarterChange={changed} />,
    );
    expect(screen.getByLabelText('回合公报（全员可见）')).toHaveValue(
      '写到一半的故事',
    );
    expect(fetchSettlement).toHaveBeenCalledTimes(1);
  });
  it('keeps failed saves editable and publishes only a saved complete draft', async () => {
    const changed = vi.fn();
    render(<SettlementPanel game={game} onQuarterChange={changed} />);
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '诸国整备。' },
    });
    fireEvent.click(screen.getByRole('button', { name: /北方探索/ }));
    fireEvent.change(screen.getByLabelText('政策结算反馈'), {
      target: { value: '发现铜矿。' },
    });
    expect(screen.getByRole('button', { name: '发布本回合' })).toBeDisabled();
    vi.mocked(saveSettlement).mockRejectedValueOnce(
      new Error('保存冲突，请刷新。'),
    );
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByRole('alert');
    expect(screen.getByLabelText('政策结算反馈')).toHaveValue('发现铜矿。');
    expect(screen.getByRole('button', { name: '发布本回合' })).toBeDisabled();
    const saved = {
      ...draft,
      version: 2,
      publicReport: '诸国整备。',
      actions: [{ ...draft.actions[0]!, feedback: '发现铜矿。' }],
    };
    vi.mocked(saveSettlement).mockResolvedValueOnce(saved);
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await screen.findByText('已保存');
    expect(saveSettlement).toHaveBeenLastCalledWith('game', 'quarter', {
      expectedVersion: 1,
      publicReport: '诸国整备。',
      results: [{ actionId: 'action', feedback: '发现铜矿。' }],
    });
    const published: QuarterSettlement = {
      ...saved,
      quarter: { ...saved.quarter, state: 'Published' },
      publishedAt: '2026-10-09T00:00:00Z',
    };
    vi.mocked(publishSettlement).mockResolvedValueOnce(published);
    fireEvent.click(screen.getByRole('button', { name: '发布本回合' }));
    expect(publishSettlement).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认发布' }));
    await screen.findByText('发现铜矿。');
    expect(publishSettlement).toHaveBeenCalledWith(
      'game',
      'quarter',
      2,
      undefined,
    );
    expect(
      screen.queryByRole('button', { name: '保存草稿' }),
    ).not.toBeInTheDocument();
    expect(changed).toHaveBeenCalledWith(published.quarter);
    expect(screen.getByRole('button', { name: '进入下一回合' })).toBeEnabled();
  });

  it('preserves an unsaved story when switching to historical results', async () => {
    vi.mocked(fetchSettlements).mockResolvedValue([
      {
        quarterId: 'quarter',
        gameYear: 1,
        season: 'Spring',
        sequenceNumber: 2,
        state: 'Resolving',
        isCurrent: true,
        publishedAt: null,
      },
      {
        quarterId: 'old',
        gameYear: 0,
        season: 'Winter',
        sequenceNumber: 1,
        state: 'Completed',
        isCurrent: false,
        publishedAt: '2026-10-08T00:00:00Z',
      },
    ]);
    render(<SettlementPanel game={game} onQuarterChange={vi.fn()} />);
    fireEvent.change(await screen.findByLabelText('回合公报（全员可见）'), {
      target: { value: '尚未完成的长故事' },
    });
    fireEvent.change(screen.getByLabelText('查看回合'), {
      target: { value: 'old' },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('请先保存草稿');
    expect(fetchSettlement).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('回合公报（全员可见）')).toHaveValue(
      '尚未完成的长故事',
    );
    expect(screen.getByLabelText('查看回合')).toHaveValue('quarter');
  });

  it('lets players discover a visible historical correction while the current result is unpublished', async () => {
    vi.mocked(fetchSettlement)
      .mockResolvedValueOnce({ ...draft, actions: [] })
      .mockResolvedValueOnce({
        ...draft,
        quarter: { ...draft.quarter, id: 'old' },
        isCurrent: false,
        publishedAt: '2026-10-18T00:00:00Z',
        publicReport: '修正版公报',
        actions: [],
      });
    vi.mocked(fetchSettlements).mockResolvedValue([
      {
        quarterId: 'quarter',
        gameYear: 1,
        season: 'Summer',
        sequenceNumber: 2,
        state: 'ActionSubmission',
        isCurrent: true,
        publishedAt: null,
      },
      {
        quarterId: 'old',
        gameYear: 1,
        season: 'Spring',
        sequenceNumber: 1,
        state: 'Completed',
        isCurrent: false,
        publishedAt: '2026-10-18T00:00:00Z',
        correctedAt: '2026-10-18T01:00:00Z',
      },
    ]);
    render(
      <SettlementPanel
        game={{ ...game, role: 'Player' }}
        onQuarterChange={vi.fn()}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: '查看最近更正' }),
    );
    expect(await screen.findByText('修正版公报')).toBeInTheDocument();
    expect(fetchSettlement).toHaveBeenLastCalledWith('game', 'old');
    expect(
      screen.queryByRole('button', { name: '更正已发布结果' }),
    ).not.toBeInTheDocument();
  });

  it('advances to a fresh round and leaves published stories in history', async () => {
    const published: QuarterSettlement = {
      ...draft,
      quarter: { ...draft.quarter, state: 'Published' },
      publishedAt: '2026-10-09T00:00:00Z',
      publicReport: '春季公报',
      actions: [],
    };
    const next = {
      ...draft.quarter,
      id: 'next',
      season: 'Summer' as const,
      sequenceNumber: 2,
      state: 'Preparing' as const,
    };
    vi.mocked(fetchSettlement)
      .mockResolvedValueOnce(published)
      .mockResolvedValueOnce({
        ...draft,
        quarter: next,
        version: 0,
        publicReport: '',
        actions: [],
      });
    vi.mocked(advanceQuarter).mockResolvedValue(next);
    const changed = vi.fn();
    render(<SettlementPanel game={game} onQuarterChange={changed} />);
    await screen.findByText('春季公报');
    fireEvent.click(screen.getByRole('button', { name: '进入下一回合' }));
    await waitFor(() =>
      expect(fetchSettlement).toHaveBeenLastCalledWith('game', 'next'),
    );
    expect(advanceQuarter).toHaveBeenCalledWith('game', 'quarter');
    expect(changed).toHaveBeenCalledWith(next);
    await screen.findByText('完成政策审核后开始结算。');
    expect(screen.queryByText('春季公报')).not.toBeInTheDocument();
  });
});
