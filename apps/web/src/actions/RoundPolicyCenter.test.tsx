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
import { DraftAccountProvider, DraftSession } from '../drafts/local-drafts.js';
import { isLocalPolicy } from './policy-draft-data.js';
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
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const hostGame: GameSummary = { ...game, role: 'Host' };
const hostView = (userId = 'host') => (
  <DraftAccountProvider userId={userId}>
    <RoundPolicyCenter game={hostGame} />
  </DraftAccountProvider>
);
const playerView = (currentGame = game, userId = 'player') => (
  <DraftAccountProvider userId={userId}>
    <RoundPolicyCenter game={currentGame} />
  </DraftAccountProvider>
);
const draftKey = (
  kind = 'round-policy',
  user = 'player',
  quarter = 'quarter',
  object = 'member:country',
) =>
  `srilanka:draft:v1:${JSON.stringify([user, 'game', quarter, kind, object])}`;

it('preserves both host texts across reload and protects leaving until explicitly submitted', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  const page = render(hostView());
  fireEvent.change(await screen.findByLabelText('整份审核意见'), {
    target: { value: '未提交的整份审核长文' },
  });
  fireEvent.change(screen.getByLabelText('整份政策解释'), {
    target: { value: '尚未提交的政策解释' },
  });
  expect(
    screen.getByText('此设备已暂存审核文字，尚未提交。'),
  ).toBeInTheDocument();
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  page.unmount();
  render(hostView());
  const restore = await screen.findByRole('button', { name: '继续编写本地稿' });
  expect(screen.getByLabelText('整份审核意见')).toBeDisabled();
  expect(api.reviewRoundPolicy).not.toHaveBeenCalled();
  fireEvent.click(restore);
  expect(screen.getByLabelText('整份审核意见')).toHaveValue(
    '未提交的整份审核长文',
  );
  expect(screen.getByLabelText('整份政策解释')).toHaveValue(
    '尚未提交的政策解释',
  );
});

it('only clears the submitted host field and carries the other field to the new revision', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  const next = { ...formal, revision: 'b'.repeat(64) };
  vi.mocked(api.reviewRoundPolicy).mockResolvedValue(next);
  const page = render(hostView());
  fireEvent.change(await screen.findByLabelText('整份审核意见'), {
    target: { value: '本次批准意见' },
  });
  fireEvent.change(screen.getByLabelText('整份政策解释'), {
    target: { value: '稍后才提交的解释' },
  });
  fireEvent.click(screen.getByRole('button', { name: '批准整份政策' }));
  await waitFor(() =>
    expect(screen.getByLabelText('整份审核意见')).toHaveValue(''),
  );
  expect(screen.getByLabelText('整份政策解释')).toHaveValue('稍后才提交的解释');
  const persisted = JSON.parse(
    localStorage.getItem(draftKey('round-review', 'host'))!,
  );
  expect(persisted.value).toEqual({
    revision: next.revision,
    reason: '',
    interpretation: '稍后才提交的解释',
  });
  page.unmount();
  vi.mocked(api.fetchRoundPolicy).mockResolvedValue(next);
  render(hostView());
  fireEvent.click(
    await screen.findByRole('button', { name: '继续编写本地稿' }),
  );
  expect(screen.getByLabelText('整份审核意见')).toHaveValue('');
  expect(screen.getByLabelText('整份政策解释')).toHaveValue('稍后才提交的解释');
  fireEvent.click(screen.getByRole('button', { name: '保存整份解释' }));
  await waitFor(() =>
    expect(localStorage.getItem(draftKey('round-review', 'host'))).toBeNull(),
  );
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(false);
});

it('keeps failed host submissions and offers changed-version drafts for copying only', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  vi.mocked(api.reviewRoundPolicy).mockRejectedValue(new Error('审核保存断网'));
  const page = render(hostView());
  fireEvent.change(await screen.findByLabelText('整份审核意见'), {
    target: { value: '不能丢的审核文字' },
  });
  fireEvent.click(screen.getByRole('button', { name: '批准整份政策' }));
  await screen.findByText('审核保存断网');
  expect(screen.getByLabelText('整份审核意见')).toHaveValue('不能丢的审核文字');
  page.unmount();
  vi.mocked(api.fetchRoundPolicy).mockResolvedValue({
    ...formal,
    revision: 'c'.repeat(64),
  });
  render(hostView());
  await screen.findByText(/服务器内容或阶段已变化/);
  expect(
    screen.queryByRole('button', { name: '继续编写本地稿' }),
  ).not.toBeInTheDocument();
  expect(
    (screen.getByLabelText('本地草稿全文') as HTMLTextAreaElement).value,
  ).toContain('不能丢的审核文字');
  expect(screen.getByLabelText('整份审核意见')).toBeDisabled();
  expect(api.reviewRoundPolicy).toHaveBeenCalledTimes(1);
});

it('keeps cached opinions distinct when switching players, including leaving while another policy is selected', async () => {
  const second = {
    ...formal,
    memberId: 'second',
    playerName: '玩家乙',
    countryId: 'south',
    countryName: '南国',
  };
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal, second]);
  vi.mocked(api.fetchRoundPolicy).mockImplementation(async (_id, p) =>
    p.memberId === 'second' ? second : formal,
  );
  render(hostView());
  fireEvent.change(await screen.findByLabelText('整份审核意见'), {
    target: { value: '甲的未提交意见' },
  });
  fireEvent.click(screen.getByRole('button', { name: /南国 · 玩家乙/ }));
  await waitFor(() =>
    expect(screen.getByLabelText('整份审核意见')).toHaveValue(''),
  );
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
  fireEvent.change(screen.getByLabelText('整份审核意见'), {
    target: { value: '乙的未提交意见' },
  });
  fireEvent.click(screen.getByRole('button', { name: /康提 · 玩家甲/ }));
  await waitFor(() =>
    expect(screen.getByLabelText('整份审核意见')).toHaveValue('甲的未提交意见'),
  );
  expect(
    screen.queryByRole('button', { name: '继续编写本地稿' }),
  ).not.toBeInTheDocument();
});

it('does not reveal review drafts to a different account or a player', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  const page = render(hostView());
  fireEvent.change(await screen.findByLabelText('整份审核意见'), {
    target: { value: '主持人私有未提交意见' },
  });
  page.unmount();
  const other = render(hostView('other-host'));
  expect(await screen.findByLabelText('整份审核意见')).toHaveValue('');
  expect(screen.queryByLabelText('本地草稿全文')).not.toBeInTheDocument();
  other.unmount();
  render(playerView(game, 'host'));
  await screen.findByRole('button', { name: '添加政策分项' });
  expect(screen.queryByText(/主持人私有未提交意见/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText('整份审核意见')).not.toBeInTheDocument();
});

it('retains in-page opinions and refuses to overwrite another tab draft', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  render(hostView());
  const input = await screen.findByLabelText('整份审核意见');
  fireEvent.change(input, { target: { value: '第一页面的审核意见' } });
  const key = draftKey('round-review', 'host');
  const external = JSON.parse(localStorage.getItem(key)!);
  localStorage.setItem(
    key,
    JSON.stringify({
      ...external,
      token: 'another-tab',
      value: { ...external.value, reason: '另一页面的新意见' },
    }),
  );
  fireEvent.change(input, { target: { value: '本页继续写但不能覆盖另一页' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('另一页面');
  expect(input).toHaveValue('本页继续写但不能覆盖另一页');
  expect(JSON.parse(localStorage.getItem(key)!).value.reason).toBe(
    '另一页面的新意见',
  );
});

it('reports a failed review backup honestly while retaining the text and leave protection', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  render(hostView());
  const input = await screen.findByLabelText('整份审核意见');
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  fireEvent.change(input, { target: { value: '浏览器存储失败也不能清空' } });
  expect(await screen.findByRole('alert')).toHaveTextContent('本地暂存失败');
  expect(input).toHaveValue('浏览器存储失败也不能清空');
  expect(
    screen.queryByText('此设备已暂存审核文字，尚未提交。'),
  ).not.toBeInTheDocument();
  const leaving = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(leaving);
  expect(leaving.defaultPrevented).toBe(true);
});

it('undoes consecutive removals in order without overwriting newer edits or map references', async () => {
  const one = {
    ...section('one', '首项正文'),
    refs: [
      {
        objectId: 'tile',
        label: '东岸',
        objectType: 'Tile' as const,
        refKind: 'Target' as const,
      },
    ],
  };
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue({
    ...base,
    draftSections: [
      one,
      section('two', '次项正文'),
      section('three', '第三项'),
    ],
  });
  render(playerView());
  await screen.findAllByLabelText('具体政策');
  fireEvent.click(
    within(screen.getAllByRole('article')[1]!).getByRole('button', {
      name: '移除此分项',
    }),
  );
  fireEvent.click(
    within(screen.getAllByRole('article')[0]!).getByRole('button', {
      name: '移除此分项',
    }),
  );
  fireEvent.change(screen.getByLabelText('具体政策'), {
    target: { value: '删除后继续修改的第三项' },
  });
  fireEvent.click(screen.getByRole('button', { name: '撤销移除：标题one' }));
  fireEvent.click(screen.getByRole('button', { name: '撤销移除：标题two' }));
  expect(
    screen
      .getAllByLabelText('具体政策')
      .map((e) => (e as HTMLTextAreaElement).value),
  ).toEqual(['首项正文', '次项正文', '删除后继续修改的第三项']);
  expect(
    screen
      .getAllByLabelText('分项标题（可自拟）')
      .map((e) => (e as HTMLInputElement).value),
  ).toEqual(['标题one', '标题two', '标题three']);
  expect(
    screen.getByRole('button', { name: '移除关联：东岸' }),
  ).toBeInTheDocument();
  expect(api.saveRoundPolicy).not.toHaveBeenCalled();
});

it('keeps a removed new section in the local backup across reload, while empty sections need no undo', async () => {
  const page = render(playerView());
  fireEvent.click(await screen.findByRole('button', { name: '添加政策分项' }));
  fireEvent.click(screen.getByRole('button', { name: '移除此分项' }));
  expect(
    screen.queryByRole('button', { name: /撤销移除/ }),
  ).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '添加政策分项' }));
  fireEvent.change(screen.getByLabelText('具体政策'), {
    target: { value: '还没存到服务器的唯一副本' },
  });
  fireEvent.click(screen.getByRole('button', { name: '移除此分项' }));
  expect(localStorage.getItem(draftKey())).toContain(
    '还没存到服务器的唯一副本',
  );
  page.unmount();
  render(playerView());
  fireEvent.click(
    await screen.findByRole('button', { name: '继续编写本地稿' }),
  );
  fireEvent.click(screen.getByRole('button', { name: '撤销移除：未命名分项' }));
  expect(screen.getByLabelText('具体政策')).toHaveValue(
    '还没存到服务器的唯一副本',
  );
});

it('keeps an obsolete removal backup readable when its server revision changes', async () => {
  const page = render(playerView());
  fireEvent.click(await screen.findByRole('button', { name: '添加政策分项' }));
  fireEvent.change(screen.getByLabelText('具体政策'), {
    target: { value: '已移除但不能丢的文字' },
  });
  fireEvent.click(screen.getByRole('button', { name: '移除此分项' }));
  page.unmount();
  vi.mocked(api.fetchMyRoundPolicy).mockResolvedValue({
    ...base,
    revision: 'b'.repeat(64),
  });
  render(playerView());
  const backup = await screen.findByLabelText('本地草稿全文');
  expect((backup as HTMLTextAreaElement).value).toContain(
    '已移除但不能丢的文字',
  );
  expect(
    screen.queryByRole('button', { name: '继续编写本地稿' }),
  ).not.toBeInTheDocument();
});

it('offers previous-round local text after a live quarter transition without replacing the new draft', async () => {
  const first = { ...base, draftSections: [section('old', '旧回合初稿')] };
  const nextGame = {
    ...game,
    currentQuarter: {
      ...game.currentQuarter,
      id: 'next-quarter',
      sequenceNumber: 2,
    },
  };
  const second = {
    ...base,
    quarterId: 'next-quarter',
    quarter: nextGame.currentQuarter,
    revision: 'b'.repeat(64),
    draftSections: [section('new', '新回合服务器草稿')],
  };
  vi.mocked(api.fetchMyRoundPolicy).mockImplementation(async (_g, quarter) =>
    quarter === 'quarter' ? first : second,
  );
  vi.mocked(api.fetchRoundPolicy).mockResolvedValue({
    ...first,
    canEdit: false,
  });
  const copy = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: copy },
  });
  const page = render(playerView());
  fireEvent.change(await screen.findByLabelText('具体政策'), {
    target: { value: '留在旧回合的未保存文字' },
  });
  page.rerender(playerView(nextGame));
  await waitFor(() =>
    expect(screen.getByLabelText('具体政策')).toHaveValue('新回合服务器草稿'),
  );
  expect(screen.queryByText('留在旧回合的未保存文字')).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('具体政策'), {
    target: { value: '新回合还在写的新文字' },
  });
  fireEvent.click(
    await screen.findByRole('button', { name: /查看旧回合草稿/ }),
  );
  const old = await screen.findByLabelText('第 1 年 · 第 1 回合本地草稿全文');
  expect((old as HTMLTextAreaElement).value).toContain(
    '留在旧回合的未保存文字',
  );
  fireEvent.click(screen.getByRole('button', { name: '复制此回合草稿' }));
  await waitFor(() =>
    expect(copy).toHaveBeenCalledWith(
      expect.stringContaining('留在旧回合的未保存文字'),
    ),
  );
  expect(screen.getByLabelText('具体政策')).toHaveValue('新回合还在写的新文字');
  expect(api.saveRoundPolicy).not.toHaveBeenCalled();
  page.unmount();
  render(playerView(nextGame));
  fireEvent.click(
    await screen.findByRole('button', { name: '继续编写本地稿' }),
  );
  expect(screen.getByLabelText('具体政策')).toHaveValue('新回合还在写的新文字');
  expect(
    screen.getByRole('button', { name: /查看旧回合草稿/ }),
  ).toBeInTheDocument();
});

it('never displays old policy text when permission is revoked and never deletes the original backup', async () => {
  const key = draftKey('round-policy', 'player', 'old-quarter');
  new DraftSession(key, isLocalPolicy).write({
    revision: base.revision,
    countryId: base.countryId,
    sections: [section('secret', '权限已撤销的私人旧稿')],
  });
  vi.mocked(api.fetchRoundPolicy).mockRejectedValue(
    new Error('无政策读取权限'),
  );
  render(playerView());
  fireEvent.click(
    await screen.findByRole('button', { name: /查看旧回合草稿/ }),
  );
  await screen.findByText(/部分旧稿因权限变化/);
  expect(screen.queryByText(/权限已撤销的私人旧稿/)).not.toBeInTheDocument();
  expect(
    screen.queryByRole('textbox', { name: /回合本地草稿全文/ }),
  ).not.toBeInTheDocument();
  expect(localStorage.getItem(key)).toContain('权限已撤销的私人旧稿');
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

it('returns to the phone review queue without losing unsubmitted review text', async () => {
  vi.mocked(api.fetchRoundPolicies).mockResolvedValue([formal]);
  const page = render(hostView());
  const entry = await screen.findByRole('button', { name: /康提 · 玩家甲/ });
  expect(page.container.querySelector('[data-mobile-pane]')).toHaveAttribute(
    'data-mobile-pane',
    'list',
  );
  fireEvent.click(entry);
  await waitFor(() =>
    expect(screen.getByLabelText('整份审核意见')).toBeEnabled(),
  );
  fireEvent.change(screen.getByLabelText('整份审核意见'), {
    target: { value: '返回列表也保留' },
  });
  fireEvent.click(screen.getByRole('button', { name: /玩家政策列表/ }));
  expect(page.container.querySelector('[data-mobile-pane]')).toHaveAttribute(
    'data-mobile-pane',
    'list',
  );
  fireEvent.click(entry);
  await waitFor(() =>
    expect(screen.getByLabelText('整份审核意见')).toHaveValue('返回列表也保留'),
  );
  expect(page.container.querySelector('[data-mobile-pane]')).toHaveAttribute(
    'data-mobile-pane',
    'detail',
  );
});
