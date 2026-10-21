import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ActionDetails, GameSummary } from '@srilanka/contracts';

import {
  fetchAction,
  fetchActions,
  fetchActionVersions,
  submitAction,
  updateAction,
  transitionQuarter,
  createAction,
} from '../api.js';
import { ActionCenter } from './ActionCenter.js';
import { DraftAccountProvider } from '../drafts/local-drafts.js';

vi.mock('../api.js', () => ({
  ApiRequestError: class extends Error {},
  fetchAction: vi.fn(),
  fetchActions: vi.fn(),
  fetchActionVersions: vi.fn(),
  submitAction: vi.fn(),
  updateAction: vi.fn(),
  transitionQuarter: vi.fn(),
  createAction: vi.fn(),
}));

const game: GameSummary = {
  id: 'game',
  name: '诸国时代',
  status: 'Running',
  role: 'Player',
  currentQuarter: {
    id: 'quarter',
    gameYear: 1,
    season: 'Spring',
    sequenceNumber: 1,
    state: 'HostReview',
    actionDeadline: null,
    currentWorldVersion: 0,
  },
};
const action: ActionDetails = {
  id: 'action',
  quarterId: 'quarter',
  countryId: 'country',
  countryName: '康提',
  createdByMemberId: 'member',
  title: '北方探索',
  category: 'Exploration',
  secrecy: 'OwnerOnly',
  status: 'NeedPlayerInput',
  version: 3,
  submittedAt: '2026-10-08T00:00:00Z',
  updatedAt: '2026-10-08T01:00:00Z',
  currentText: '尚未交出的补充草稿',
  submittedOriginalText: '首次探索原文',
  refs: [],
  latestInterpretation: null,
  pendingInputRequest: '请说明投入人数',
  history: [],
  submissions: [
    {
      id: 'submission',
      version: 2,
      title: '北方探索',
      text: '最近正式提交的计划',
      category: 'Exploration',
      secrecy: 'OwnerOnly',
      refs: [],
      submittedAt: '2026-10-08T00:30:00Z',
    },
  ],
};

beforeEach(() => {
  localStorage.clear();
  vi.resetAllMocks();
  vi.mocked(fetchActions).mockResolvedValue([action]);
  vi.mocked(fetchAction).mockResolvedValue(action);
  vi.mocked(fetchActionVersions).mockResolvedValue([]);
  vi.mocked(submitAction).mockResolvedValue({
    ...action,
    status: 'HostReview',
    pendingInputRequest: null,
  });
});

async function openAction() {
  fireEvent.click(
    await screen.findByRole('button', { name: /北方探索.*康提/ }),
  );
  await screen.findByText('主持人要求补充：请说明投入人数');
}

afterEach(cleanup);

describe('policy supplementation and formal submissions', () => {
  it('keeps a new policy intact when its creation shortcut is clicked again', async () => {
    render(
      <ActionCenter
        game={{
          ...game,
          currentQuarter: { ...game.currentQuarter, state: 'ActionSubmission' },
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText('行动标题'), {
      target: { value: '秋季建设' },
    });
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '修复北境水渠，优先处理损坏的闸门。' },
    });
    fireEvent.click(screen.getByRole('button', { name: '新建政策 / 行动' }));
    expect(screen.getByLabelText('行动标题')).toHaveValue('秋季建设');
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '修复北境水渠，优先处理损坏的闸门。',
    );
    expect(screen.getByLabelText('行动标题')).toHaveFocus();
    expect(createAction).not.toHaveBeenCalled();
  });
  it('finds policies by country and status without replacing the open editor', async () => {
    vi.mocked(fetchActions).mockResolvedValue([
      action,
      {
        ...action,
        id: 'second',
        title: '修复水渠',
        countryName: '南国',
        status: 'Approved',
      },
    ]);
    render(<ActionCenter game={game} />);
    await openAction();
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '投入三十人，保留原计划路线。' },
    });
    fireEvent.change(screen.getByLabelText('搜索政策'), {
      target: { value: '南国' },
    });
    expect(
      screen.queryByRole('button', { name: /北方探索.*康提/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /修复水渠.*南国/ }),
    ).toBeVisible();
    fireEvent.change(screen.getByLabelText('筛选政策状态'), {
      target: { value: 'attention' },
    });
    expect(screen.getByText('没有匹配的政策。')).toBeVisible();
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '投入三十人，保留原计划路线。',
    );
    fireEvent.click(screen.getByRole('button', { name: '显示全部政策' }));
    expect(
      screen.getByRole('button', { name: /北方探索.*康提/ }),
    ).toBeVisible();
    expect(
      screen.getByRole('button', { name: /修复水渠.*南国/ }),
    ).toBeVisible();
    expect(fetchAction).toHaveBeenCalledOnce();
  });
  it('retains the creation request across network failures and reload recovery', async () => {
    const current = {
      ...game,
      currentQuarter: {
        ...game.currentQuarter,
        state: 'ActionSubmission' as const,
      },
    };
    const editor = () => (
      <DraftAccountProvider userId="one">
        <ActionCenter game={current} />
      </DraftAccountProvider>
    );
    vi.mocked(createAction).mockRejectedValueOnce(new Error('响应断开'));
    const page = render(editor());
    fireEvent.change(await screen.findByLabelText('行动标题'), {
      target: { value: '北境新政策' },
    });
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '只应创建一份的计划' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }));
    await screen.findByText('响应断开');
    const first = vi.mocked(createAction).mock.calls[0]![1];
    expect(first.creationId).toBeTruthy();
    page.unmount();
    render(editor());
    fireEvent.click(await screen.findByText('继续编写本地稿'));
    vi.mocked(createAction).mockResolvedValue({
      ...action,
      quarterId: current.currentQuarter.id,
      title: first.title,
      currentText: first.originalText,
      status: 'Draft',
    });
    fireEvent.click(screen.getByRole('button', { name: '创建草稿' }));
    await screen.findByText('草稿已创建');
    expect(vi.mocked(createAction).mock.calls[1]![1]).toEqual(first);
    await waitFor(() => expect(localStorage.length).toBe(0));
  });
  it('retains failed autosaves after reload and clears the local copy only after server acknowledgement', async () => {
    vi.mocked(updateAction).mockRejectedValueOnce(new Error('断网暂未保存'));
    const editor = () => (
      <DraftAccountProvider userId="one">
        <ActionCenter game={game} />
      </DraftAccountProvider>
    );
    const page = render(editor());
    await openAction();
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '断网期间的补充' },
    });
    await screen.findByText('断网暂未保存');
    vi.mocked(fetchActions).mockResolvedValue([{ ...action, version: 4 }]);
    vi.mocked(fetchAction).mockResolvedValue({
      ...action,
      version: 4,
      currentText: '远端新稿',
    });
    await act(async () => {
      fireEvent(document, new Event('visibilitychange'));
    });
    expect(fetchAction).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '断网期间的补充',
    );
    vi.mocked(fetchActions).mockResolvedValue([action]);
    vi.mocked(fetchAction).mockResolvedValue(action);
    page.unmount();
    vi.mocked(updateAction).mockResolvedValue({
      ...action,
      version: 4,
      currentText: '断网期间的补充',
    });
    render(editor());
    await openAction();
    fireEvent.click(screen.getByText('继续编写本地稿'));
    await screen.findByText('已自动保存');
    await waitFor(() => expect(localStorage.length).toBe(0));
  });
  it('restores a new policy on this account after remount without creating or submitting it', async () => {
    const editor = (account: string) => (
      <DraftAccountProvider userId={account}>
        <ActionCenter game={game} />
      </DraftAccountProvider>
    );
    const first = render(editor('one'));
    fireEvent.change(screen.getByLabelText('行动标题'), {
      target: { value: '未创建的政策' },
    });
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '写到一半的长文' },
    });
    first.unmount();
    const other = render(editor('two'));
    expect(screen.queryByText('继续编写本地稿')).not.toBeInTheDocument();
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue('');
    other.unmount();
    render(editor('one'));
    fireEvent.click(screen.getByText('继续编写本地稿'));
    expect(screen.getByLabelText('行动标题')).toHaveValue('未创建的政策');
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '写到一半的长文',
    );
    expect(submitAction).not.toHaveBeenCalled();
  });
  it('keeps a policy from an older quarter copyable without restoring it into the new quarter', () => {
    const page = render(
      <DraftAccountProvider userId="one">
        <ActionCenter game={game} />
      </DraftAccountProvider>,
    );
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '上季未交草稿' },
    });
    page.unmount();
    render(
      <DraftAccountProvider userId="one">
        <ActionCenter
          game={{
            ...game,
            currentQuarter: { ...game.currentQuarter, id: 'next' },
          }}
        />
      </DraftAccountProvider>,
    );
    expect(screen.queryByText('继续编写本地稿')).not.toBeInTheDocument();
    expect(
      (screen.getByLabelText('本地草稿全文') as HTMLTextAreaElement).value,
    ).toContain('上季未交草稿');
  });
  it('does not overwrite a newer server policy with an earlier local revision', async () => {
    const page = render(
      <DraftAccountProvider userId="one">
        <ActionCenter game={game} />
      </DraftAccountProvider>,
    );
    await openAction();
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '未保存的补充' },
    });
    page.unmount();
    vi.mocked(fetchAction).mockResolvedValue({
      ...action,
      version: 4,
      currentText: '另一个窗口已保存',
    });
    render(
      <DraftAccountProvider userId="one">
        <ActionCenter game={game} />
      </DraftAccountProvider>,
    );
    await openAction();
    expect(screen.queryByText('继续编写本地稿')).not.toBeInTheDocument();
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '另一个窗口已保存',
    );
    expect(
      (screen.getByLabelText('本地草稿全文') as HTMLTextAreaElement).value,
    ).toContain('未保存的补充');
    expect(updateAction).not.toHaveBeenCalled();
  });
  it('keeps earlier policies readable after ending and hides editing and phase changes', async () => {
    vi.mocked(fetchActions).mockResolvedValue([
      { ...action, quarterId: 'earlier-quarter' },
    ]);
    const view = render(
      <ActionCenter game={{ ...game, status: 'Archived', role: 'Host' }} />,
    );
    await openAction();
    expect(fetchActions).toHaveBeenCalledWith('game', false);
    expect(screen.getAllByText('最近正式提交的计划').length).toBeGreaterThan(0);
    expect(
      screen.queryByRole('button', { name: '重新开放政策提交' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '保存独立整理稿' }),
    ).not.toBeInTheDocument();
    view.rerender(<ActionCenter game={{ ...game, status: 'Archived' }} />);
    expect(
      screen.queryByRole('button', { name: '新建政策 / 行动' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('政策 / 行动内容')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '准备提交' }),
    ).not.toBeInTheDocument();
  });

  it('receives newly submitted policies while the host keeps the review panel open', async () => {
    vi.mocked(fetchActions).mockResolvedValueOnce([]);
    render(<ActionCenter game={{ ...game, role: 'Host' }} />);
    await waitFor(() => expect(fetchActions).toHaveBeenCalledOnce());
    await screen.findByText('暂无行动。');
    vi.mocked(fetchActions).mockResolvedValue([
      { ...action, status: 'Submitted' },
    ]);
    fireEvent(document, new Event('visibilitychange'));
    expect(
      await screen.findByRole('button', { name: /北方探索.*康提.*已提交/ }),
    ).toBeInTheDocument();
  });

  it('unlocks the selected policy when the host requests a supplement remotely', async () => {
    const submitted: ActionDetails = {
      ...action,
      status: 'Submitted',
      pendingInputRequest: null,
    };
    vi.mocked(fetchActions).mockResolvedValue([submitted]);
    vi.mocked(fetchAction).mockResolvedValue(submitted);
    render(<ActionCenter game={game} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /北方探索.*康提/ }),
    );
    await screen.findByRole('heading', { name: '最新正式提交内容' });
    expect(screen.queryByLabelText('政策 / 行动内容')).not.toBeInTheDocument();
    const requested: ActionDetails = { ...action, version: 4 };
    vi.mocked(fetchActions).mockResolvedValue([requested]);
    vi.mocked(fetchAction).mockResolvedValue(requested);
    fireEvent(document, new Event('visibilitychange'));
    await screen.findByText('主持人要求补充：请说明投入人数');
    expect(screen.getByLabelText('政策 / 行动内容')).toBeEnabled();
  });

  it('keeps unsaved player writing when a newer remote policy is detected', async () => {
    render(<ActionCenter game={game} />);
    await openAction();
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '正在补充的本地计划' },
    });
    const remote: ActionDetails = {
      ...action,
      version: 4,
      currentText: '另一窗口保存的内容',
    };
    vi.mocked(fetchActions).mockResolvedValue([remote]);
    vi.mocked(fetchAction).mockResolvedValue(remote);
    fireEvent(document, new Event('visibilitychange'));
    await waitFor(() => expect(fetchActions).toHaveBeenCalledTimes(2));
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '正在补充的本地计划',
    );
    expect(fetchAction).toHaveBeenCalledTimes(1);
  });

  it('does not poll a hidden workspace panel and refreshes when it is reopened', async () => {
    const view = render(<ActionCenter game={game} active={false} />);
    fireEvent(document, new Event('visibilitychange'));
    expect(fetchActions).not.toHaveBeenCalled();
    view.rerender(<ActionCenter game={game} active />);
    await screen.findByRole('button', { name: /北方探索.*康提/ });
    expect(fetchActions).toHaveBeenCalledOnce();
  });

  it('updates the selected completed policy after the game moves to the next quarter', async () => {
    const approved: ActionDetails = {
      ...action,
      status: 'Approved',
      pendingInputRequest: null,
    };
    vi.mocked(fetchActions).mockResolvedValue([approved]);
    vi.mocked(fetchAction).mockResolvedValue(approved);
    const props = { game: { ...game, role: 'Host' as const } };
    const view = render(<ActionCenter {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /北方探索.*康提/ }),
    );
    await screen.findByRole('heading', { name: '最新正式提交内容' });
    vi.mocked(fetchActions).mockResolvedValue([]);
    vi.mocked(fetchAction).mockResolvedValue({
      ...approved,
      status: 'Completed',
    });
    view.rerender(
      <ActionCenter
        game={{
          ...props.game,
          currentQuarter: { ...game.currentQuarter, id: 'next-quarter' },
        }}
      />,
    );
    await screen.findByText('历史回合政策');
    await screen.findByText('已完成');
    expect(screen.queryByText('已批准')).not.toBeInTheDocument();
  });

  it('locates a formally submitted province and opens settlement for that specific approved policy', async () => {
    const ref = {
      refKind: 'Target' as const,
      objectType: 'Province' as const,
      objectId: 'province',
      label: '省份：北境',
    };
    const approved: ActionDetails = {
      ...action,
      status: 'Approved',
      pendingInputRequest: null,
      refs: [],
      submissions: [{ ...action.submissions[0]!, refs: [ref] }],
    };
    vi.mocked(fetchActions).mockResolvedValue([approved]);
    vi.mocked(fetchAction).mockResolvedValue(approved);
    const onLocateReference = vi.fn().mockResolvedValue(undefined),
      onOpenSettlement = vi.fn();
    render(
      <ActionCenter
        game={{ ...game, role: 'Host' }}
        onLocateReference={onLocateReference}
        onOpenSettlement={onOpenSettlement}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: /北方探索.*康提/ }),
    );
    fireEvent.click(await screen.findByRole('button', { name: '省份：北境' }));
    expect(onLocateReference).toHaveBeenCalledWith(ref);
    fireEvent.click(screen.getByRole('button', { name: '结算这份政策' }));
    expect(onOpenSettlement).toHaveBeenCalledWith(action.id);
  });
  it('routes the first opening through preparation when provided by the workspace', async () => {
    const onPrepareOpening = vi.fn();
    render(
      <ActionCenter
        game={{
          ...game,
          role: 'Host',
          currentQuarter: { ...game.currentQuarter, state: 'Preparing' },
        }}
        onPrepareOpening={onPrepareOpening}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: '开放政策提交' }),
    );
    expect(onPrepareOpening).toHaveBeenCalledOnce();
    expect(transitionQuarter).not.toHaveBeenCalled();
  });
  it('shows the new policy statuses after entering host review', async () => {
    vi.mocked(fetchActions)
      .mockResolvedValueOnce([{ ...action, status: 'Submitted' }])
      .mockResolvedValue([{ ...action, status: 'HostReview' }]);
    vi.mocked(transitionQuarter).mockResolvedValue({
      ...game.currentQuarter,
      state: 'HostReview',
    });
    render(
      <ActionCenter
        game={{
          ...game,
          role: 'Host',
          currentQuarter: { ...game.currentQuarter, state: 'Locked' },
        }}
      />,
    );
    await screen.findByRole('button', { name: /北方探索.*康提.*已提交/ });
    fireEvent.click(screen.getByRole('button', { name: '进入主持人审核' }));
    expect(
      await screen.findByRole('button', {
        name: /北方探索.*康提.*主持人审核中/,
      }),
    ).toBeInTheDocument();
  });
  it('opens historical policies from discussion without showing current-round review controls', async () => {
    vi.mocked(fetchAction).mockResolvedValue({
      ...action,
      quarterId: 'old-quarter',
      status: 'Completed',
      pendingInputRequest: null,
    });
    const discuss = vi.fn().mockResolvedValue(undefined);
    render(
      <ActionCenter
        game={{ ...game, role: 'Host' }}
        focus={{ actionId: action.id, key: 1 }}
        onDiscussAction={discuss}
      />,
    );
    await screen.findByText('历史回合政策');
    expect(screen.queryByLabelText('审核说明')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '批准' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '讨论这份政策' }));
    expect(discuss).toHaveBeenCalledWith(action.id);
  });
  it('allows a requested supplement in a locked review round even above a suggested allowance', async () => {
    render(
      <ActionCenter
        game={game}
        rules={{
          quarterId: 'quarter',
          version: 1,
          scenario: {
            title: '',
            playerPerspective: 'CountryWill',
            premise: '',
            commonRules: '',
          },
          quarter: {
            briefing: '',
            actionGuidelines: '',
            suggestedLimits: [{ category: 'Exploration', limit: 0 }],
          },
        }}
      />,
    );
    await openAction();
    expect(screen.getByText(/此行动将超出探索的建议额度/)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '撤回行动' }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '准备提交' }));
    fireEvent.click(screen.getByRole('button', { name: '确认正式提交' }));
    await waitFor(() =>
      expect(submitAction).toHaveBeenCalledWith('game', 'action'),
    );
  });

  it('shows the host the latest formal submission while a supplement remains a draft', async () => {
    render(<ActionCenter game={{ ...game, role: 'Host' }} />);
    await openAction();
    const formal = screen.getByRole('heading', {
      name: '最新正式提交内容',
    }).parentElement!;
    expect(within(formal).getByText('最近正式提交的计划')).toBeInTheDocument();
    expect(
      within(formal).queryByText('尚未交出的补充草稿'),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '批准' })).toBeDisabled();
  });

  it('blocks submission if the latest draft could not be saved', async () => {
    vi.mocked(updateAction).mockRejectedValue(new Error('连接中断'));
    render(<ActionCenter game={game} />);
    await openAction();
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '新投入方案' },
    });
    expect(
      await screen.findByRole(
        'button',
        { name: '请先解决草稿保存失败' },
        { timeout: 3000 },
      ),
    ).toBeDisabled();
    expect(submitAction).not.toHaveBeenCalled();
    expect(
      screen.getByRole('button', { name: '重试保存草稿' }),
    ).toBeInTheDocument();
  });

  it('saves new writing entered while a previous autosave is still in flight', async () => {
    let finishFirstSave!: (saved: ActionDetails) => void;
    vi.mocked(updateAction)
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirstSave = resolve;
          }),
      )
      .mockResolvedValueOnce({
        ...action,
        version: 5,
        currentText: '后来补充的新计划',
      });
    render(<ActionCenter game={game} />);
    await openAction();
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '正在保存的计划' },
    });
    await waitFor(() => expect(updateAction).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    });
    fireEvent.change(screen.getByLabelText('政策 / 行动内容'), {
      target: { value: '后来补充的新计划' },
    });
    finishFirstSave({ ...action, version: 4, currentText: '正在保存的计划' });
    await waitFor(() => expect(updateAction).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    });
    expect(updateAction).toHaveBeenLastCalledWith(
      'game',
      'action',
      expect.objectContaining({
        expectedVersion: 4,
        originalText: '后来补充的新计划',
      }),
    );
    expect(screen.getByLabelText('政策 / 行动内容')).toHaveValue(
      '后来补充的新计划',
    );
  });
});
