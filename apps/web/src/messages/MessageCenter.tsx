import { type FormEvent, useCallback, useEffect, useState } from 'react';

import type {
  ConversationMessage,
  ConversationSummary,
  CountrySummary,
  GameSummary,
} from '@srilanka/contracts';

import {
  createConversation,
  fetchConversations,
  fetchMessages,
  sendMessage,
} from '../api.js';

export function MessageCenter({
  game,
  countries,
}: {
  game: GameSummary;
  countries: CountrySummary[];
}) {
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [selected, setSelected] = useState<ConversationSummary | null>(null);
  const [messages, setMessages] = useState<ConversationMessage[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [type, setType] = useState<ConversationSummary['type']>('HostPlayer');
  const [participantCountryIds, setParticipantCountryIds] = useState<string[]>(
    [],
  );
  const [content, setContent] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      setConversations(await fetchConversations(game.id));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '会话列表加载失败');
    }
  }, [game.id]);

  useEffect(() => void load(), [load]);

  async function open(conversation: ConversationSummary) {
    try {
      const page = await fetchMessages(game.id, conversation.id);
      setSelected(conversation);
      setMessages(page.items);
      setNextCursor(page.nextCursor);
      setCreating(false);
      setError('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '消息读取失败');
    }
  }

  async function loadEarlier() {
    if (!selected || !nextCursor) return;
    try {
      const page = await fetchMessages(game.id, selected.id, nextCursor);
      setMessages((current) => [...page.items, ...current]);
      setNextCursor(page.nextCursor);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '更早消息加载失败');
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
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
    }
  }

  async function send(event: FormEvent) {
    event.preventDefault();
    if (!selected || !content.trim()) return;
    const sending = content;
    setContent('');
    try {
      const message = await sendMessage(game.id, selected.id, sending);
      setMessages((current) => [...current, message]);
      await load();
    } catch (cause) {
      setContent(sending);
      setError(cause instanceof Error ? cause.message : '消息发送失败');
    }
  }

  function toggleCountry(countryId: string) {
    setParticipantCountryIds((current) =>
      current.includes(countryId)
        ? current.filter((id) => id !== countryId)
        : [...current, countryId],
    );
  }

  return (
    <section className="work-center">
      <header className="center-heading">
        <div>
          <p className="eyebrow">MESSAGES</p>
          <h3>消息中心</h3>
        </div>
        <button
          className="button"
          onClick={() => {
            setCreating(true);
            setSelected(null);
          }}
        >
          新建会话
        </button>
      </header>
      {error && <p className="form-error">{error}</p>}
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
          {conversations.length === 0 && <p className="muted">暂无会话。</p>}
        </aside>
        <div className="center-detail">
          {creating && (
            <form
              className="conversation-form"
              onSubmit={(event) => void create(event)}
            >
              <h4>创建会话</h4>
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
                    setType(event.target.value as ConversationSummary['type'])
                  }
                >
                  <option value="HostPlayer">与主持人沟通</option>
                  <option value="BilateralDiplomacy">双边外交</option>
                  <option value="Multilateral">多人会谈</option>
                  <option value="ActionReview">行动审核沟通</option>
                </select>
              </label>
              <fieldset>
                <legend>邀请国家（主持人会自动加入）</legend>
                {countries.map((country) => (
                  <label className="check-row" key={country.id}>
                    <input
                      type="checkbox"
                      checked={participantCountryIds.includes(country.id)}
                      onChange={() => toggleCountry(country.id)}
                    />
                    {country.name}
                  </label>
                ))}
              </fieldset>
              <button className="button" type="submit">
                创建
              </button>
            </form>
          )}
          {selected && (
            <div className="message-thread">
              <h4>{selected.title}</h4>
              {nextCursor && (
                <button type="button" onClick={() => void loadEarlier()}>
                  加载更早消息
                </button>
              )}
              <div className="message-stream">
                {messages.map((message) => (
                  <article className="message-bubble" key={message.id}>
                    <strong>{message.senderDisplayName}</strong>
                    <p>{message.content}</p>
                    <small>{new Date(message.sentAt).toLocaleString()}</small>
                  </article>
                ))}
                {messages.length === 0 && <p className="muted">还没有消息。</p>}
              </div>
              <form
                className="message-composer"
                onSubmit={(event) => void send(event)}
              >
                <textarea
                  required
                  rows={4}
                  maxLength={10_000}
                  value={content}
                  onChange={(event) => setContent(event.target.value)}
                  placeholder="输入消息……"
                />
                <button className="button" type="submit">
                  发送
                </button>
              </form>
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
