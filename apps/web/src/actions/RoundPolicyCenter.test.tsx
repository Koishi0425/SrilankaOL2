import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  GameSummary,
  RoundPolicy,
  RoundPolicySectionInput,
} from '@srilanka/contracts';
import * as api from '../api.js';
import { RoundPolicyCenter } from './RoundPolicyCenter.js';
import { DraftAccountProvider } from '../drafts/local-drafts.js';
vi.mock('../api.js', async (original) => ({
  ...(await original<typeof api>()),
  fetchRoundPolicies: vi.fn(),
  fetchMyRoundPolicy: vi.fn(),
  fetchRoundPolicy: vi.fn(),
  fetchRoundPolicyForAction: vi.fn(),
  saveRoundPolicy: vi.fn(),
  reviewRoundPolicy: vi.fn(),
}));
const game: GameSummary = {
  id: 'game',
  name: '测试',
  status: 'Running',
  role: 'Player',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'ActionSubmission',
    actionDeadline: null,
    currentWorldVersion: 0,
  },
};
const section = (
  id: string,
  text = '跨领域的具体政策',
): RoundPolicySectionInput => ({
  id,
  title: `标题${id}`,
  text,
  category: 'Research',
  secrecy: 'OwnerOnly',
  refs: [],
});
const base: RoundPolicy = {
  quarterId: 'quarter',
  memberId: 'member',
  countryId: 'country',
  countryName: '康提',
  playerName: '玩家甲',
  status: 'Draft',
  sectionCount: 0,
  submittedAt: null,
  revision: 'a'.repeat(64),
  quarter: game.currentQuarter,
  canEdit: true,
  canSubmit: true,
  sections: [],
  draftSections: [],
  history: [],
  pendingInputRequest: null,
  interpretation: '',
};
const formal: RoundPolicy = {
  ...base,
  status: 'Submitted',
  sectionCount: 2,
  submittedAt: '2026-10-22T00:00:00Z',
  sections: [section('one', '研究与内政'), section('two', '外交与技术')].map(
    (s) => ({ ...s, status: 'Submitted', reviewReason: '' }),
  ),
  draftSections: [section('one', '未交出的草稿'), section('two', '外交与技术')],
};
beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([]);
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue(structuredClone(base));
  vi.mocked(api.fetchRoundPolicy).mockResolvedValue(structuredClone(formal));
  vi.mocked(api.fetchRoundPolicyForAction).mockResolvedValue(
    structuredClone(formal),
  );
  vi.mocked(api.saveRoundPolicy).mockResolvedValue(structuredClone(formal));
  vi.mocked(api.reviewRoundPolicy).mockResolvedValue({
    ...formal,
    status: 'Approved',
    sections: formal.sections.map((s) => ({ ...s, status: 'Approved' })),
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows policy placeholders until the initial document arrives, then removes them on success or failure', async () => {
  let resolve!: (policy: RoundPolicy) => void;
  vi.mocked(api.fetchMyRoundPolicy).mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  render(<RoundPolicyCenter game={game} />);
  expect(
    screen.getByRole('status', { name: '正在读取本回合政策…' }),
  ).toBeInTheDocument();
  await waitFor(() => expect(api.fetchMyRoundPolicy).toHaveBeenCalled());
  await act(async () => resolve(structuredClone(base)));
  expect(
    await screen.findByRole('button', { name: '添加政策分项' }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole('status', { name: '正在读取本回合政策…' }),
  ).not.toBeInTheDocument();
  cleanup();
  vi.mocked(api.fetchMyRoundPolicy).mockRejectedValue(
    new Error('政策连接中断'),
  );
  render(<RoundPolicyCenter game={game} />);
  await screen.findByText('政策连接中断');
  expect(
    screen.queryByRole('status', { name: '正在读取本回合政策…' }),
  ).not.toBeInTheDocument();
});

it('hides the previous player policy while opening another document and ignores a late response', async () => {
  const second = {
    ...formal,
    memberId: 'second',
    countryId: 'south',
    countryName: '南国',
    playerName: '玩家乙',
    sections: formal.sections.map((s) => ({ ...s, text: '南国政策正文' })),
  };
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal, second]);
  render(<RoundPolicyCenter game={{ ...game, role: 'Host' }} />);
  await screen.findByText('研究与内政');
  let resolveOlder!: (policy: RoundPolicy) => void;
  vi.mocked(api.fetchRoundPolicy).mockReturnValueOnce(
    new Promise((done) => {
      resolveOlder = done;
    }),
  );
  fireEvent.click(screen.getByRole('button', { name: /南国 · 玩家乙/ }));
  expect(
    screen.getByRole('status', { name: '正在读取本回合政策…' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('研究与内政')).not.toBeInTheDocument();
  vi.mocked(api.fetchRoundPolicy).mockResolvedValueOnce(formal);
  fireEvent.click(screen.getByRole('button', { name: /康提 · 玩家甲/ }));
  await screen.findByText('研究与内政');
  await act(async () => resolveOlder(second));
  expect(screen.queryByText('南国政策正文')).not.toBeInTheDocument();
});

it('adds independent repeated-category sections and submits them all with one request', async () => {
  render(<RoundPolicyCenter game={game} />);
  await screen.findByText(/分类只是写作提示/);
  expect(screen.queryByLabelText('公开意向')).not.toBeInTheDocument();
  expect(screen.getByText(/政策结果向谁可见，由主持人/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '添加政策分项' }));
  fireEvent.click(screen.getByRole('button', { name: '添加政策分项' }));
  screen
    .getAllByLabelText('参考分类')
    .forEach((input) =>
      fireEvent.change(input, { target: { value: 'Research' } }),
    );
  const texts = screen.getAllByLabelText('具体政策');
  fireEvent.change(texts[0]!, { target: { value: '研究也可包含外交' } });
  fireEvent.change(texts[1]!, { target: { value: '研究也可包含内政' } });
  fireEvent.click(screen.getByRole('button', { name: '提交整份政策' }));
  expect(api.saveRoundPolicy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '确认整份提交' }));
  await waitFor(() => expect(api.saveRoundPolicy).toHaveBeenCalledTimes(1));
  expect(api.saveRoundPolicy).toHaveBeenCalledWith(
    'game',
    'quarter',
    expect.objectContaining({
      submit: true,
      expectedRevision: base.revision,
      sections: [
        expect.objectContaining({
          category: 'Research',
          text: '研究也可包含外交',
        }),
        expect.objectContaining({
          category: 'Research',
          text: '研究也可包含内政',
        }),
      ],
    }),
  );
});

it('keeps all text and reuses the request ID after an uncertain submit failure', async () => {
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue({
    ...base,
    draftSections: [section('one')],
  });
  vi.mocked(api.saveRoundPolicy)
    .mockRejectedValueOnce(new Error('连接中断'))
    .mockResolvedValue(formal);
  render(<RoundPolicyCenter game={game} />);
  await screen.findByLabelText('具体政策');
  fireEvent.change(screen.getByLabelText('具体政策'), {
    target: { value: '保留全部政策' },
  });
  fireEvent.click(screen.getByRole('button', { name: '提交整份政策' }));
  fireEvent.click(screen.getByRole('button', { name: '确认整份提交' }));
  await screen.findByText('连接中断');
  expect(screen.getByLabelText('具体政策')).toHaveValue('保留全部政策');
  fireEvent.click(screen.getByRole('button', { name: '确认整份提交' }));
  await waitFor(() => expect(api.saveRoundPolicy).toHaveBeenCalledTimes(2));
  expect(vi.mocked(api.saveRoundPolicy).mock.calls[0]?.[2]).toEqual(
    vi.mocked(api.saveRoundPolicy).mock.calls[1]?.[2],
  );
});

it('saves the whole draft separately and prevents empty formal submissions', async () => {
  render(<RoundPolicyCenter game={game} />);
  fireEvent.click(await screen.findByRole('button', { name: '添加政策分项' }));
  fireEvent.click(screen.getByRole('button', { name: '提交整份政策' }));
  fireEvent.click(screen.getByRole('button', { name: '确认整份提交' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('请填写各分项');
  expect(api.saveRoundPolicy).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: '保存整份草稿' }));
  await waitFor(() =>
    expect(api.saveRoundPolicy).toHaveBeenCalledWith(
      'game',
      'quarter',
      expect.objectContaining({ submit: false }),
    ),
  );
});

it('shows one host row and reviews all formal sections together without draft leakage', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  render(<RoundPolicyCenter game={{ ...game, role: 'Host' }} />);
  expect(await screen.findByText('研究与内政')).toBeVisible();
  expect(screen.getByText('外交与技术')).toBeVisible();
  expect(screen.queryByText('未交出的草稿')).not.toBeInTheDocument();
  const list = screen.getByRole('complementary', { name: '玩家回合政策' });
  expect(within(list).getAllByRole('button')).toHaveLength(1);
  fireEvent.change(screen.getByLabelText('整份审核意见'), {
    target: { value: '两项结合评阅后批准' },
  });
  fireEvent.click(screen.getByRole('button', { name: '批准整份政策' }));
  await waitFor(() => expect(api.reviewRoundPolicy).toHaveBeenCalledTimes(1));
  expect(api.reviewRoundPolicy).toHaveBeenCalledWith(
    'game',
    expect.objectContaining({ memberId: 'member' }),
    expect.objectContaining({
      target: 'Approved',
      reason: '两项结合评阅后批准',
      expectedRevision: formal.revision,
    }),
  );
});

it('restores the whole local draft only against its matching server revision', async () => {
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue({
    ...base,
    draftSections: [section('one')],
  });
  const view = render(
    <DraftAccountProvider userId="player">
      <RoundPolicyCenter game={game} />
    </DraftAccountProvider>,
  );
  fireEvent.change(await screen.findByLabelText('具体政策'), {
    target: { value: '本机尚未保存的长篇政策' },
  });
  view.unmount();
  render(
    <DraftAccountProvider userId="player">
      <RoundPolicyCenter game={game} />
    </DraftAccountProvider>,
  );
  fireEvent.click(
    await screen.findByRole('button', { name: '继续编写本地稿' }),
  );
  expect(screen.getByLabelText('具体政策')).toHaveValue(
    '本机尚未保存的长篇政策',
  );
});

it('keeps dirty text through polling and map targets append without replacing policy text', async () => {
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue({
    ...base,
    draftSections: [section('one', '原正文')],
  });
  const view = render(<RoundPolicyCenter game={game} />);
  fireEvent.change(await screen.findByLabelText('具体政策'), {
    target: { value: '不能被轮询覆盖' },
  });
  const count = vi.mocked(api.fetchMyRoundPolicy).mock.calls.length;
  vi.useFakeTimers();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
  expect(api.fetchMyRoundPolicy).toHaveBeenCalledTimes(count);
  vi.useRealTimers();
  view.rerender(
    <RoundPolicyCenter
      game={game}
      seed={{
        key: 1,
        title: '新地图目标',
        category: 'Research',
        ref: {
          refKind: 'Target',
          objectType: 'Tile',
          objectId: 'tile',
          label: '东岸',
        },
      }}
    />,
  );
  expect(screen.getByLabelText('具体政策')).toHaveValue('不能被轮询覆盖');
  expect(screen.getByRole('button', { name: '移除关联：东岸' })).toBeVisible();
});

it('keeps supplement feedback and locked formal documents visible without editable controls', async () => {
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue({
    ...formal,
    canEdit: false,
    canSubmit: false,
    draftSections: undefined,
    pendingInputRequest: '请统一说明投入',
  });
  render(
    <RoundPolicyCenter
      game={{
        ...game,
        currentQuarter: { ...game.currentQuarter, state: 'HostReview' },
      }}
    />,
  );
  expect(await screen.findByText('请统一说明投入')).toBeVisible();
  expect(screen.getByText('研究与内政')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '添加政策分项' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText('具体政策')).not.toBeInTheDocument();
});
