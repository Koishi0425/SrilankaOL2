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
import type {
  ConversationMessage,
  ConversationSummary,
  GameSummary,
} from '@srilanka/contracts';
import {
  fetchConversations,
  fetchMessages,
  openHostConversation,
  sendMessage,
} from '../api.js';
import { MessageCenter } from './MessageCenter.js';
import { DraftAccountProvider } from '../drafts/local-drafts.js';

vi.mock('../api.js', () => ({
  createConversation: vi.fn(),
  fetchConversations: vi.fn(),
  fetchMessages: vi.fn(),
  openHostConversation: vi.fn(),
  sendMessage: vi.fn(),
}));

const game = { id: 'game', role: 'Player' } as GameSummary;
const a: ConversationSummary = {
  id: 'a',
  type: 'ActionReview',
  title: '北方探索',
  participantNames: ['主持人', '玩家'],
  unreadCount: 0,
  latestMessage: null,
  lastMessageAt: null,
  linkedActionId: 'policy',
};
const b: ConversationSummary = {
  ...a,
  id: 'b',
  title: '主持人私聊',
  type: 'HostPlayer',
  linkedActionId: null,
};
function message(
  id: string,
  conversationId = 'a',
  content = id,
): ConversationMessage {
  return {
    id,
    conversationId,
    content,
    senderDisplayName: '主持人',
    sentAt: '2026-10-09T00:00:00Z',
    invalidated: false,
  };
}
beforeEach(() => {
  localStorage.clear();
  vi.mocked(fetchConversations).mockResolvedValue([a, b]);
  vi.mocked(fetchMessages).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(openHostConversation).mockResolvedValue(b);
});
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe('MessageCenter', () => {
  it('does not restore a private message when the conversation no longer authorizes reading', async () => {
    const editor = () => (
      <DraftAccountProvider userId="one">
        <MessageCenter game={game} countries={[]} />
      </DraftAccountProvider>
    );
    const page = render(editor());
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '不能展示的旧私稿' },
    });
    page.unmount();
    vi.mocked(fetchMessages).mockRejectedValue(new Error('无会话权限'));
    render(editor());
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await screen.findByText('无会话权限');
    expect(screen.getByLabelText('消息内容')).toHaveValue('');
    expect(screen.getByLabelText('消息内容')).toBeDisabled();
  });
  it('restores unsent messages after reload and keeps the send id across a lost response', async () => {
    vi.mocked(sendMessage)
      .mockRejectedValueOnce(new Error('断网'))
      .mockResolvedValueOnce(message('sent', 'a', '未发私聊'));
    const editor = () => (
      <DraftAccountProvider userId="one">
        <MessageCenter game={game} countries={[]} />
      </DraftAccountProvider>
    );
    const first = render(editor());
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).toBeEnabled(),
    );
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '未发私聊' },
    });
    fireEvent.click(screen.getByText('发送'));
    await screen.findByText('断网');
    const id = vi.mocked(sendMessage).mock.calls[0]?.[3];
    first.unmount();
    render(editor());
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).toHaveValue('未发私聊'),
    );
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).toHaveValue(''),
    );
    expect(vi.mocked(sendMessage).mock.calls[1]?.[3]).toBe(id);
    expect(localStorage.length).toBe(0);
  });
  it('reads existing private conversations after ending without contact, creation or sending controls', async () => {
    vi.mocked(fetchMessages).mockResolvedValue({
      items: [message('old', 'a', '保留的讨论记录')],
      nextCursor: null,
    });
    render(
      <MessageCenter game={{ ...game, status: 'Archived' }} countries={[]} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    expect(await screen.findByText('保留的讨论记录')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '联系主持人' }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: '新建会谈' }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText('消息内容')).not.toBeInTheDocument();
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it('opens the host directly and retains per-conversation drafts across tabs', async () => {
    const props = { game, countries: [], active: true };
    const page = render(<MessageCenter {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: '联系主持人' }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).not.toBeDisabled(),
    );
    expect(openHostConversation).toHaveBeenCalledWith('game', undefined);
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '还没发送的私聊' },
    });
    fireEvent.click(screen.getByRole('button', { name: /北方探索/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '政策问题' },
    });
    page.rerender(<MessageCenter {...props} active={false} />);
    page.rerender(<MessageCenter {...props} />);
    expect(screen.getByLabelText('消息内容')).toHaveValue('政策问题');
    fireEvent.click(screen.getByRole('button', { name: /主持人私聊/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).toHaveValue('还没发送的私聊'),
    );
  });

  it('keeps failed text and reuses the message key for a safe retry', async () => {
    vi.mocked(sendMessage)
      .mockRejectedValueOnce(new Error('连接中断'))
      .mockResolvedValueOnce(message('sent', 'a', '请确认投入'));
    render(<MessageCenter game={game} countries={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '请确认投入' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await screen.findByText('连接中断');
    expect(screen.getByLabelText('消息内容')).toHaveValue('请确认投入');
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).toHaveValue(''),
    );
    expect(vi.mocked(sendMessage).mock.calls[0]?.[3]).toBe(
      vi.mocked(sendMessage).mock.calls[1]?.[3],
    );
    expect(
      within(screen.getByRole('log')).getAllByText('请确认投入'),
    ).toHaveLength(1);
  });

  it('blocks repeated sends and ignores late replies after switching conversations', async () => {
    let finish!: (value: ConversationMessage) => void;
    vi.mocked(sendMessage).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    render(<MessageCenter game={game} countries={[]} />);
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '探索讨论' },
    });
    fireEvent.click(screen.getByRole('button', { name: '发送' }));
    expect(screen.getByRole('button', { name: '发送中…' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '发送中…' }));
    fireEvent.click(screen.getByRole('button', { name: /主持人私聊/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('消息内容')).not.toBeDisabled(),
    );
    fireEvent.change(screen.getByLabelText('消息内容'), {
      target: { value: '另一份草稿' },
    });
    await act(async () => finish(message('late', 'a', '探索讨论')));
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText('消息内容')).toHaveValue('另一份草稿');
    expect(
      within(screen.getByRole('log')).queryByText('探索讨论'),
    ).not.toBeInTheDocument();
  });

  it('polls new messages, preserves history, and updates unread counts outside the tab', async () => {
    const unread = vi.fn();
    const policy = vi.fn();
    vi.mocked(fetchMessages).mockImplementation(
      async (_game, _conversation, cursor, after) => ({
        items: cursor
          ? [message('older')]
          : after
            ? [message('reply')]
            : [message('first')],
        nextCursor: !cursor && !after ? 'first' : null,
      }),
    );
    const props = {
      game,
      countries: [],
      onUnreadChange: unread,
      onOpenPolicy: policy,
    };
    const page = render(<MessageCenter {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: /北方探索/ }));
    await screen.findByText('reply');
    fireEvent.click(screen.getByRole('button', { name: '加载更早消息' }));
    await screen.findByText('older');
    expect(
      within(screen.getByRole('log')).getByText('first'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '查看政策' }));
    expect(policy).toHaveBeenCalledWith('policy');
    page.rerender(<MessageCenter {...props} active={false} />);
    vi.mocked(fetchConversations).mockResolvedValue([{ ...a, unreadCount: 2 }]);
    vi.useFakeTimers();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    // The existing real interval is replaced by rerendering with a new callback.
    page.rerender(
      <MessageCenter
        {...props}
        active={false}
        onUnreadChange={(count) => unread(count)}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(unread).toHaveBeenLastCalledWith(2);
    expect(
      within(screen.getByRole('log')).getByText('older'),
    ).toBeInTheDocument();
  });
});
