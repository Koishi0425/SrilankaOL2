import { isGameReadOnly } from '@srilanka/contracts';
import {
  type FormEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import type {
  ConversationMessage,
  ConversationSummary,
  CountrySummary,
  GameMemberSummary,
  GameSummary,
} from '@srilanka/contracts';

import {
  createConversation,
  fetchConversations,
  fetchMessages,
  openHostConversation,
  sendMessage,
} from '../api.js';
import { DraftSession, useDraftKey } from '../drafts/local-drafts.js';

interface MessageLocalDraft {
  content: string;
  attemptId: string | null;
}
function isMessageDraft(value: unknown): value is MessageLocalDraft {
  if (!value || typeof value !== 'object') return false;
  const v = value as MessageLocalDraft;
  return (
    typeof v.content === 'string' &&
    (v.attemptId === null || typeof v.attemptId === 'string')
  );
}

export interface ConversationTarget {
  conversation: ConversationSummary;
  key: number;
}

function appendMessages(
  current: ConversationMessage[],
  incoming: ConversationMessage[],
) {
  const ids = new Set(incoming.map((message) => message.id));
  return [...current.filter((message) => !ids.has(message.id)), ...incoming];
}

export function MessageCenter({
  game,
  countries,
  members = [],
  active = true,
  target,
  onUnreadChange,
  onOpenPolicy,
}: {
  game: GameSummary;
  countries: CountrySummary[];
  members?: GameMemberSummary[];
  active?: boolean;
  target?: ConversationTarget;
  onUnreadChange?: (count: number) => void;
  onOpenPolicy?: (actionId: string) => void;
}) {
  const host = ['Host', 'Administrator'].includes(game.role);
  const readOnly = isGameReadOnly(game.status);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<'BilateralDiplomacy' | 'Multilateral'>(
    'BilateralDiplomacy',
  );
  const [participantCountryIds, setParticipantCountryIds] = useState<string[]>(
    [],
  );
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendingIds, setSendingIds] = useState<string[]>([]);
  const [creating, setCreating] = useState(false);
  useEffect(() => {
    if (readOnly) setCreating(false);
  }, [readOnly]);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [contactMemberId, setContactMemberId] = useState('');
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [draftNotice, setDraftNotice] = useState('');
  const localPrefix = useDraftKey(game.id, 'conversations', 'message', 'draft');
  const localSessions = useRef(
    new Map<string, DraftSession<MessageLocalDraft>>(),
  );
  const selectedId = useRef<string | null>(null);
  const generation = useRef(0);
  const newestId = useRef<string | undefined>(undefined);
  const listBusy = useRef(false);
  const pendingSends = useRef(new Set<string>());
  const retries = useRef(new Map<string, { content: string; id: string }>());
  const handledTarget = useRef<number | undefined>(undefined);
  const stream = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const content = selected ? (drafts[selected.id] ?? '') : '';
  const sending = !!selected && sendingIds.includes(selected.id);

  useEffect(() => {
    if (active && followLatest.current && stream.current)
      stream.current.scrollTop = stream.current.scrollHeight;
  }, [active, messages]);

  const load = useCallback(async () => {
    if (listBusy.current) return;
    listBusy.current = true;
    try {
      const list = await fetchConversations(game.id);
      setConversations(list);
      onUnreadChange?.(
        list.reduce((count, item) => count + item.unreadCount, 0),
      );
      setConnectionError('');
    } catch (cause) {
      setConnectionError(
        cause instanceof Error ? cause.message : '消息连接失败，将自动重试',
      );
    } finally {
      listBusy.current = false;
    }
  }, [game.id, onUnreadChange]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, 4000);
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [load]);

  const open = useCallback(
    async (conversation: ConversationSummary) => {
      const request = ++generation.current;
      selectedId.current = conversation.id;
      newestId.current = undefined;
      followLatest.current = true;
      setSelected(conversation);
      setMessages([]);
      setNextCursor(null);
      setCreating(false);
      setReading(true);
      setError('');
      try {
        const page = await fetchMessages(game.id, conversation.id);
        if (request !== generation.current) return;
        if (!localSessions.current.has(conversation.id)) {
          const session = new DraftSession<MessageLocalDraft>(
            localPrefix ? `${localPrefix}:${conversation.id}` : null,
            isMessageDraft,
          );
          localSessions.current.set(conversation.id, session);
          if (session.saved && !readOnly) {
            const saved = session.saved.value;
            setDrafts((current) => ({
              ...current,
              [conversation.id]: current[conversation.id] ?? saved.content,
            }));
            if (saved.attemptId)
              retries.current.set(conversation.id, {
                content: saved.content,
                id: saved.attemptId,
              });
            setDraftNotice('已恢复此设备上的未发送消息');
          } else setDraftNotice(session.error);
          session.resume();
        } else
          setDraftNotice(localSessions.current.get(conversation.id)!.error);
        setMessages(page.items);
        setNextCursor(page.nextCursor);
        newestId.current = page.items.at(-1)?.id;
        await load();
      } catch (cause) {
        if (request === generation.current)
          setError(cause instanceof Error ? cause.message : '消息读取失败');
      } finally {
        if (request === generation.current) setReading(false);
      }
    },
    [game.id, load, localPrefix, readOnly],
  );

  useEffect(() => {
    if (!active || !target || handledTarget.current === target.key) return;
    handledTarget.current = target.key;
    void open(target.conversation);
  }, [active, open, target]);

  useEffect(() => {
    if (!active || !selected || reading) return;
    let disposed = false;
    let polling = false;
    const conversationId = selected.id;
    const request = generation.current;
    async function refresh() {
      if (polling || document.visibilityState !== 'visible') return;
      polling = true;
      try {
        const after = newestId.current;
        const page = await fetchMessages(
          game.id,
          conversationId,
          undefined,
          after,
        );
        if (disposed || request !== generation.current) return;
        setMessages((current) => appendMessages(current, page.items));
        if (!after) setNextCursor(page.nextCursor);
        newestId.current = page.items.at(-1)?.id ?? after;
        setConnectionError('');
        await load();
      } catch (cause) {
        if (!disposed)
          setConnectionError(
            cause instanceof Error ? cause.message : '消息连接失败，将自动重试',
          );
      } finally {
        polling = false;
      }
    }
    void refresh();
    const timer = window.setInterval(() => void refresh(), 3000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [active, game.id, load, reading, selected]);

  async function loadEarlier() {
    if (!selected || !nextCursor) return;
    const request = generation.current;
    followLatest.current = false;
    try {
      const page = await fetchMessages(game.id, selected.id, nextCursor);
      if (request !== generation.current) return;
      setMessages((current) => appendMessages(page.items, current));
      setNextCursor(page.nextCursor);
    } catch (cause) {
      if (request === generation.current)
        setError(cause instanceof Error ? cause.message : '更早消息加载失败');
    }
  }

  async function contactHost() {
    if (busy) return;
    setBusy(true);
    try {
      const conversation = await openHostConversation(
        game.id,
        host ? contactMemberId : undefined,
      );
      await load();
      await open(conversation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '会话打开失败');
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const conversation = await createConversation(game.id, {
        type,
        title,
        participantCountryIds,
      });
      setTitle('');
      setParticipantCountryIds([]);
      await load();
      await open(conversation);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '会话创建失败');
    } finally {
      setBusy(false);
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !content.trim() || pendingSends.current.has(selected.id))
      return;
    const conversationId = selected.id;
    const draft = content;
    const previous = retries.current.get(conversationId);
    const attempt =
      previous?.content === draft
        ? previous
        : { content: draft, id: crypto.randomUUID() };
    retries.current.set(conversationId, attempt);
    const local = localSessions.current.get(conversationId);
    local?.write({ content: draft, attemptId: attempt.id });
    if (local?.error) setDraftNotice(local.error);
    pendingSends.current.add(conversationId);
    setSendingIds((ids) => [...ids, conversationId]);
    setError('');
    try {
      const message = await sendMessage(
        game.id,
        conversationId,
        draft,
        attempt.id,
      );
      setDrafts((current) =>
        current[conversationId] === draft
          ? { ...current, [conversationId]: '' }
          : current,
      );
      retries.current.delete(conversationId);
      if (
        local?.saved?.value.content === draft &&
        local.saved.value.attemptId === attempt.id
      )
        local.clear();
      if (selectedId.current === conversationId)
        setDraftNotice(local?.error ?? '');
      if (selectedId.current === conversationId)
        setMessages((current) =>
          current.some((item) => item.id === message.id)
            ? current
            : [...current, message],
        );
      await load();
    } catch (cause) {
      if (selectedId.current === conversationId)
        setError(
          cause instanceof Error ? cause.message : '消息发送失败，请重试',
        );
    } finally {
      pendingSends.current.delete(conversationId);
      setSendingIds((ids) => ids.filter((id) => id !== conversationId));
    }
  }

  return (
    <section className="work-center message-center">
      <header className="center-heading">
        <h3>消息中心</h3>
        {!readOnly && (
          <div className="message-tools">
            {host && (
              <select
                aria-label="联系玩家"
                value={contactMemberId}
                onChange={(event) => setContactMemberId(event.target.value)}
              >
                <option value="">选择玩家</option>
                {members
                  .filter(
                    (member) =>
                      ['Player', 'Observer'].includes(member.role) &&
                      member.status === 'Active',
                  )
                  .map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.displayName}
                      {member.controlledCountryName
                        ? ` · ${member.controlledCountryName}`
                        : ''}
                    </option>
                  ))}
              </select>
            )}
            <button
              disabled={busy || (host && !contactMemberId)}
              onClick={() => void contactHost()}
            >
              {host ? '联系玩家' : '联系主持人'}
            </button>
            <button
              onClick={() => {
                ++generation.current;
                selectedId.current = null;
                setSelected(null);
                setReading(false);
                setCreating(true);
                setError('');
              }}
            >
              新建会谈
            </button>
          </div>
        )}
      </header>
      {(error || connectionError) && (
        <p className="form-error" role="alert">
          {error || connectionError}
        </p>
      )}
      <div className="center-layout message-layout">
        <aside className="center-list">
          {conversations.map((conversation) => (
            <button
              className={
                selected?.id === conversation.id ? 'center-list__active' : ''
              }
              key={conversation.id}
              onClick={() => void open(conversation)}
            >
              <strong>{conversation.title}</strong>
              <small>{conversation.participantNames.join('、')}</small>
              {conversation.unreadCount > 0 && (
                <span className="unread-badge">{conversation.unreadCount}</span>
              )}
            </button>
          ))}
          {!conversations.length && <p className="muted">暂无会话。</p>}
        </aside>
        <div className="center-detail">
          {creating && (
            <form
              className="conversation-form"
              onSubmit={(event) => void create(event)}
            >
              <h4>新建会谈</h4>
              <label>
                标题
                <input
                  required
                  maxLength={160}
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                类型
                <select
                  value={type}
                  onChange={(event) =>
                    setType(event.target.value as typeof type)
                  }
                >
                  <option value="BilateralDiplomacy">双边外交</option>
                  <option value="Multilateral">多人会谈</option>
                </select>
              </label>
              <fieldset>
                <legend>邀请国家（主持人会自动加入）</legend>
                {countries.map((country) => (
                  <label className="check-row" key={country.id}>
                    <input
                      type="checkbox"
                      checked={participantCountryIds.includes(country.id)}
                      onChange={() =>
                        setParticipantCountryIds((ids) =>
                          ids.includes(country.id)
                            ? ids.filter((id) => id !== country.id)
                            : [...ids, country.id],
                        )
                      }
                    />
                    {country.name}
                  </label>
                ))}
              </fieldset>
              <button disabled={busy} type="submit">
                创建
              </button>
            </form>
          )}
          {selected && (
            <div className="message-thread">
              <div className="message-thread-heading">
                <h4>{selected.title}</h4>
                {selected.linkedActionId && onOpenPolicy && (
                  <button
                    onClick={() => onOpenPolicy(selected.linkedActionId!)}
                  >
                    查看政策
                  </button>
                )}
              </div>
              {nextCursor && (
                <button type="button" onClick={() => void loadEarlier()}>
                  加载更早消息
                </button>
              )}
              <div
                className="message-stream"
                role="log"
                aria-label="会话消息"
                ref={stream}
                onScroll={(event) => {
                  const element = event.currentTarget;
                  followLatest.current =
                    element.scrollHeight -
                      element.scrollTop -
                      element.clientHeight <
                    40;
                }}
              >
                {messages.map((message) => (
                  <article className="message-bubble" key={message.id}>
                    <strong>{message.senderDisplayName}</strong>
                    <p>{message.content}</p>
                    <small>{new Date(message.sentAt).toLocaleString()}</small>
                  </article>
                ))}
                {!messages.length && (
                  <p className="muted">
                    {reading ? '加载中…' : '还没有消息。'}
                  </p>
                )}
              </div>
              {!readOnly && (
                <>
                  {draftNotice && (
                    <p className="draft-message-notice" role="status">
                      {draftNotice}
                    </p>
                  )}
                  <form
                    className="message-composer"
                    onSubmit={(event) => void send(event)}
                  >
                    <textarea
                      required
                      aria-label="消息内容"
                      rows={3}
                      maxLength={10_000}
                      disabled={
                        sending ||
                        reading ||
                        !localSessions.current.has(selected.id)
                      }
                      value={content}
                      onChange={(event) => {
                        const value = event.target.value;
                        setDrafts((current) => ({
                          ...current,
                          [selected.id]: value,
                        }));
                        retries.current.delete(selected.id);
                        const local = localSessions.current.get(selected.id);
                        if (value)
                          local?.write({ content: value, attemptId: null });
                        else local?.clear();
                        setDraftNotice(local?.error ?? '');
                      }}
                      placeholder="输入消息"
                    />
                    <button
                      disabled={
                        sending ||
                        reading ||
                        !localSessions.current.has(selected.id) ||
                        !content.trim()
                      }
                      type="submit"
                    >
                      {sending ? '发送中…' : '发送'}
                    </button>
                  </form>
                </>
              )}
            </div>
          )}
          {!creating && !selected && (
            <p className="muted">选择一个会话查看消息。</p>
          )}
        </div>
      </div>
    </section>
  );
}
