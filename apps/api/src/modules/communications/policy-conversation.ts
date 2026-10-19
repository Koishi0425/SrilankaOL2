import { randomUUID } from 'node:crypto';

import type { DatabaseClient } from '@srilanka/database';

import { ApiFault } from '../../errors.js';

// Called in the caller's transaction, including formal requests for supplements.
export async function ensurePolicyConversation(
  client: DatabaseClient,
  gameId: string,
  memberId: string,
  actionId: string,
): Promise<string> {
  const action = await client.query<{
    title: string;
    country_id: string;
    country_name: string;
  }>(
    `SELECT a.title, a.country_id, c.name AS country_name FROM actions a
     JOIN countries c ON c.id = a.country_id AND c.game_id = a.game_id
     JOIN game_members gm ON gm.game_id = a.game_id AND gm.id = $2 AND gm.status = 'Active'
     WHERE a.game_id = $1 AND a.id = $3
       AND (gm.role IN ('Host', 'Administrator') OR
         (gm.role = 'Player' AND gm.controlled_country_id = a.country_id))`,
    [gameId, memberId, actionId],
  );
  const row = action.rows[0];
  if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到可讨论的政策。');
  const result = await client.query<{ id: string }>(
    `INSERT INTO conversations (id, game_id, type, title, created_by_member_id,
       action_review_action_id, linked_object_type, linked_object_id)
     VALUES ($1,$2,'ActionReview',$3,$4,$5,'Action',$5)
     ON CONFLICT (game_id, action_review_action_id) DO UPDATE SET title = EXCLUDED.title
     RETURNING id`,
    [
      randomUUID(),
      gameId,
      `${row.country_name} · ${row.title}`.slice(0, 160),
      memberId,
      actionId,
    ],
  );
  const conversationId = result.rows[0]!.id;
  await client.query(
    `INSERT INTO conversation_participants (id, game_id, conversation_id, member_id, is_moderator, last_read_at)
     SELECT gen_random_uuid(), game_id, $2, id, role IN ('Host', 'Administrator'), '1970-01-01'::timestamptz
     FROM game_members WHERE game_id = $1 AND status = 'Active'
       AND (role IN ('Host', 'Administrator') OR (role = 'Player' AND controlled_country_id = $3))
     ON CONFLICT (conversation_id, member_id) DO NOTHING`,
    [gameId, conversationId, row.country_id],
  );
  return conversationId;
}
