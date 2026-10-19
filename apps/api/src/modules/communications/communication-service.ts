import { randomUUID } from 'node:crypto';

import type {
  ConversationMessage,
  ConversationSummary,
  MessagePage,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { ensurePolicyConversation } from './policy-conversation.js';

interface Member {
  id: string;
  role: string;
}

const policyAccess = `(c.action_review_action_id IS NULL OR gm.role IN ('Host', 'Administrator') OR
  (gm.role = 'Player' AND gm.controlled_country_id = (
    SELECT country_id FROM actions WHERE game_id = c.game_id AND id = c.action_review_action_id
  )))`;

export class CommunicationService {
  constructor(private readonly database: DatabasePool) {}

  private async member(gameId: string, userId: string): Promise<Member> {
    const result = await this.database.query<Member>(
      `SELECT id, role FROM game_members
       WHERE game_id = $1 AND user_id = $2 AND status = 'Active'`,
      [gameId, userId],
    );
    const member = result.rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return member;
  }

  private async requireParticipant(
    gameId: string,
    userId: string,
    conversationId: string,
  ) {
    const result = await this.database.query<{ member_id: string }>(
      `SELECT cp.member_id FROM conversation_participants cp
       JOIN game_members gm ON gm.id = cp.member_id AND gm.game_id = cp.game_id
       JOIN conversations c ON c.id = cp.conversation_id AND c.game_id = cp.game_id
       WHERE cp.game_id = $1 AND cp.conversation_id = $2
         AND gm.user_id = $3 AND gm.status = 'Active' AND c.status = 'Active' AND ${policyAccess}`,
      [gameId, conversationId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该会话。');
    return row.member_id;
  }

  async openHost(
    gameId: string,
    userId: string,
    targetMemberId?: string,
  ): Promise<ConversationSummary> {
    const member = await this.member(gameId, userId);
    const host = ['Host', 'Administrator'].includes(member.role);
    if (
      (!host && targetMemberId && targetMemberId !== member.id) ||
      (host && !targetMemberId)
    ) {
      throw new ApiFault(
        400,
        'INVALID_CONVERSATION_PARTICIPANT',
        '请选择要联系的玩家。',
      );
    }
    const targetId = host ? targetMemberId! : member.id;
    const target = await this.database.query<{ display_name: string }>(
      `SELECT u.display_name FROM game_members gm JOIN users u ON u.id = gm.user_id
       WHERE gm.game_id = $1 AND gm.id = $2 AND gm.status = 'Active' AND gm.role IN ('Player', 'Observer')`,
      [gameId, targetId],
    );
    if (!target.rows[0])
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该玩家。');
    const client = await this.database.connect();
    let conversationId: string;
    try {
      await client.query('BEGIN');
      const result = await client.query<{ id: string }>(
        `INSERT INTO conversations (id, game_id, type, title, created_by_member_id, host_player_member_id)
         VALUES ($1,$2,'HostPlayer',$3,$4,$5)
         ON CONFLICT (game_id, host_player_member_id) DO UPDATE SET title = EXCLUDED.title RETURNING id`,
        [
          randomUUID(),
          gameId,
          `${target.rows[0].display_name} · 主持人`.slice(0, 160),
          member.id,
          targetId,
        ],
      );
      conversationId = result.rows[0]!.id;
      await client.query(
        `INSERT INTO conversation_participants (id, game_id, conversation_id, member_id, is_moderator, last_read_at)
         SELECT gen_random_uuid(), game_id, $2, id, role IN ('Host', 'Administrator'), '1970-01-01'::timestamptz
         FROM game_members WHERE game_id = $1 AND status = 'Active' AND (id = $3 OR role IN ('Host', 'Administrator'))
         ON CONFLICT (conversation_id, member_id) DO NOTHING`,
        [gameId, conversationId, targetId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return (await this.list(gameId, userId)).find(
      (item) => item.id === conversationId,
    )!;
  }

  async openPolicy(
    gameId: string,
    userId: string,
    actionId: string,
  ): Promise<ConversationSummary> {
    const member = await this.member(gameId, userId);
    const client = await this.database.connect();
    let conversationId: string;
    try {
      await client.query('BEGIN');
      conversationId = await ensurePolicyConversation(
        client,
        gameId,
        member.id,
        actionId,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return (await this.list(gameId, userId)).find(
      (item) => item.id === conversationId,
    )!;
  }

  async create(input: {
    gameId: string;
    userId: string;
    type: ConversationSummary['type'];
    title: string;
    participantCountryIds: string[];
    linkedObjectType?: string;
    linkedObjectId?: string;
  }): Promise<ConversationSummary> {
    if (
      input.type === 'ActionReview' ||
      input.linkedObjectType ||
      input.linkedObjectId
    ) {
      throw new ApiFault(
        400,
        'INVALID_POLICY_CONVERSATION',
        '请从政策打开对应讨论。',
      );
    }
    if (input.type === 'HostPlayer') {
      if (input.participantCountryIds.length) {
        throw new ApiFault(
          400,
          'INVALID_CONVERSATION_PARTICIPANT',
          '主持人私聊不能邀请其他国家。',
        );
      }
      return this.openHost(input.gameId, input.userId);
    }
    const member = await this.member(input.gameId, input.userId);
    const targetMembers = await this.database.query<{ id: string }>(
      `SELECT id FROM game_members
       WHERE game_id = $1 AND status = 'Active'
         AND ((role='Player' AND controlled_country_id = ANY($2::uuid[])) OR role IN ('Host', 'Administrator'))`,
      [input.gameId, input.participantCountryIds],
    );
    if (input.participantCountryIds.length > 0) {
      const countries = await this.database.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM countries
         WHERE game_id = $1 AND id = ANY($2::uuid[]) AND status = 'Active'`,
        [input.gameId, input.participantCountryIds],
      );
      if (
        Number(countries.rows[0]?.count) !==
        new Set(input.participantCountryIds).size
      ) {
        throw new ApiFault(
          400,
          'INVALID_CONVERSATION_PARTICIPANT',
          '会话参与国家无效。',
        );
      }
      const controlled = await this.database.query<{ count: string }>(
        `SELECT COUNT(DISTINCT controlled_country_id)::text AS count
         FROM game_members WHERE game_id = $1 AND status = 'Active'
           AND role = 'Player' AND controlled_country_id = ANY($2::uuid[])`,
        [input.gameId, input.participantCountryIds],
      );
      if (
        Number(controlled.rows[0]?.count) !==
        new Set(input.participantCountryIds).size
      ) {
        throw new ApiFault(
          409,
          'CONVERSATION_PARTICIPANT_UNAVAILABLE',
          '至少一个受邀国家当前没有可加入会话的玩家。',
        );
      }
    }
    const participantIds = new Set([
      member.id,
      ...targetMembers.rows.map((row) => row.id),
    ]);
    const conversationId = randomUUID();
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO conversations (
           id, game_id, type, title, created_by_member_id,
           linked_object_type, linked_object_id
         ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [
          conversationId,
          input.gameId,
          input.type,
          input.title,
          member.id,
          input.linkedObjectType ?? null,
          input.linkedObjectId ?? null,
        ],
      );
      for (const participantId of participantIds) {
        await client.query(
          `INSERT INTO conversation_participants (
             id, game_id, conversation_id, member_id, is_moderator
           )
           SELECT $1,$2,$3,$4, role IN ('Host', 'Administrator')
           FROM game_members WHERE game_id = $2 AND id = $4`,
          [randomUUID(), input.gameId, conversationId, participantId],
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const conversations = await this.list(input.gameId, input.userId);
    return conversations.find((item) => item.id === conversationId)!;
  }

  async list(gameId: string, userId: string): Promise<ConversationSummary[]> {
    const member = await this.member(gameId, userId);
    const result = await this.database.query<{
      id: string;
      type: ConversationSummary['type'];
      title: string;
      participant_names: string[];
      unread_count: string;
      latest_message: string | null;
      last_message_at: Date | null;
      action_review_action_id: string | null;
    }>(
      `SELECT c.id, c.type, c.title,
              ARRAY_AGG(DISTINCT u.display_name ORDER BY u.display_name) AS participant_names,
              COUNT(DISTINCT unread.id)::text AS unread_count,
              latest.content AS latest_message, c.last_message_at, c.action_review_action_id
       FROM conversations c
       JOIN conversation_participants mine
         ON mine.conversation_id = c.id AND mine.member_id = $2
       JOIN game_members access_member ON access_member.id = mine.member_id AND access_member.status = 'Active'
       JOIN conversation_participants allp ON allp.conversation_id = c.id
       JOIN game_members gm ON gm.id = allp.member_id
       JOIN users u ON u.id = gm.user_id
       LEFT JOIN messages unread ON unread.conversation_id = c.id
         AND (unread.sent_at, unread.id) > (mine.last_read_at, COALESCE(mine.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid))
         AND unread.sender_member_id <> mine.member_id
       LEFT JOIN LATERAL (
         SELECT content FROM messages m WHERE m.conversation_id = c.id
         ORDER BY m.sent_at DESC, m.id DESC LIMIT 1
       ) latest ON TRUE
       WHERE c.game_id = $1 AND c.status = 'Active' AND ${policyAccess.replaceAll('gm.', 'access_member.')}
       GROUP BY c.id, mine.last_read_at, mine.last_read_message_id, latest.content
       ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC`,
      [gameId, member.id],
    );
    return result.rows.map((row) => ({
      id: row.id,
      type: row.type,
      title: row.title,
      participantNames: row.participant_names,
      unreadCount: Number(row.unread_count),
      latestMessage: row.latest_message,
      lastMessageAt: row.last_message_at?.toISOString() ?? null,
      linkedActionId: row.action_review_action_id,
    }));
  }

  async messages(input: {
    gameId: string;
    userId: string;
    conversationId: string;
    cursor?: string;
    after?: string;
    limit: number;
  }): Promise<MessagePage> {
    const memberId = await this.requireParticipant(
      input.gameId,
      input.userId,
      input.conversationId,
    );
    const result = await this.database.query<{
      id: string;
      conversation_id: string;
      sender_display_name: string;
      content: string;
      sent_at: Date;
      is_invalidated: boolean;
    }>(
      `SELECT m.id, m.conversation_id, u.display_name AS sender_display_name,
              m.content, m.sent_at, m.is_invalidated
       FROM messages m
       JOIN game_members gm ON gm.id = m.sender_member_id
       JOIN users u ON u.id = gm.user_id
       WHERE m.game_id = $1 AND m.conversation_id = $2
         AND ($3::uuid IS NULL OR (m.sent_at, m.id) ${input.after ? '>' : '<'} (
           SELECT sent_at, id FROM messages WHERE id = $3 AND conversation_id = $2
         ))
       ORDER BY m.sent_at ${input.after ? 'ASC' : 'DESC'}, m.id ${input.after ? 'ASC' : 'DESC'} LIMIT $4`,
      [
        input.gameId,
        input.conversationId,
        input.after ?? input.cursor ?? null,
        input.limit,
      ],
    );
    // Mark only messages actually returned, using PostgreSQL's full timestamp precision.
    const newest = input.after ? result.rows.at(-1) : result.rows[0];
    if (!input.cursor && newest)
      await this.database.query(
        `UPDATE conversation_participants cp SET last_read_at = m.sent_at, last_read_message_id = m.id
       FROM messages m WHERE cp.game_id = $1 AND cp.conversation_id = $2 AND cp.member_id = $3
         AND m.id = $4 AND m.conversation_id = cp.conversation_id
         AND (m.sent_at, m.id) > (cp.last_read_at, COALESCE(cp.last_read_message_id, '00000000-0000-0000-0000-000000000000'::uuid))`,
        [input.gameId, input.conversationId, memberId, newest.id],
      );
    const rows = input.after ? result.rows : result.rows.reverse();
    const items: ConversationMessage[] = rows.map((row) => ({
      id: row.id,
      conversationId: row.conversation_id,
      senderDisplayName: row.sender_display_name,
      content: row.content,
      sentAt: row.sent_at.toISOString(),
      invalidated: row.is_invalidated,
    }));
    return {
      items,
      nextCursor:
        result.rows.length === input.limit
          ? input.after
            ? (rows.at(-1)?.id ?? null)
            : (rows[0]?.id ?? null)
          : null,
    };
  }

  async send(input: {
    gameId: string;
    userId: string;
    conversationId: string;
    content: string;
    clientMessageId: string;
  }): Promise<ConversationMessage> {
    const memberId = await this.requireParticipant(
      input.gameId,
      input.userId,
      input.conversationId,
    );
    const id = randomUUID();
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const locked = await client.query(
        `SELECT id FROM conversations WHERE game_id = $1 AND id = $2 AND status = 'Active' FOR UPDATE`,
        [input.gameId, input.conversationId],
      );
      if (!locked.rowCount)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该会话。');
      await client.query(
        `WITH inserted AS (
         INSERT INTO messages (
           id, game_id, conversation_id, sender_member_id, content, client_message_id, sent_at
         ) VALUES ($1,$2,$3,$4,$5,$6,(SELECT GREATEST(clock_timestamp(), last_message_at + INTERVAL '1 microsecond') FROM conversations WHERE id = $3))
         ON CONFLICT (conversation_id, client_message_id) DO NOTHING
         RETURNING sent_at
       )
       UPDATE conversations SET last_message_at = GREATEST(
         (SELECT sent_at FROM inserted), last_message_at
       ) WHERE game_id = $2 AND id = $3`,
        [
          id,
          input.gameId,
          input.conversationId,
          memberId,
          input.content,
          input.clientMessageId,
        ],
      );
      const result = await client.query<{
        id: string;
        conversation_id: string;
        sender_display_name: string;
        content: string;
        sent_at: Date;
        is_invalidated: boolean;
        sender_member_id: string;
      }>(
        `SELECT m.id, m.conversation_id, u.display_name AS sender_display_name,
              m.content, m.sent_at, m.is_invalidated, m.sender_member_id
       FROM messages m JOIN game_members gm ON gm.id = m.sender_member_id
       JOIN users u ON u.id = gm.user_id
       WHERE m.conversation_id = $1 AND m.client_message_id = $2`,
        [input.conversationId, input.clientMessageId],
      );
      const row = result.rows[0]!;
      if (row.sender_member_id !== memberId || row.content !== input.content) {
        throw new ApiFault(
          409,
          'MESSAGE_ID_CONFLICT',
          '消息标识已用于另一条消息。',
        );
      }
      await client.query('COMMIT');
      return {
        id: row.id,
        conversationId: row.conversation_id,
        senderDisplayName: row.sender_display_name,
        content: row.content,
        sentAt: row.sent_at.toISOString(),
        invalidated: row.is_invalidated,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}
