import { createHash, randomUUID } from 'node:crypto';

import type {
  ActionCategory,
  ActionDetails,
  ActionObjectRef,
  ActionSecrecy,
  ActionStatus,
  ActionSummary,
  ActionSubmission,
  ActionVersion,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';

import { ApiFault } from '../../errors.js';
import { ensurePolicyConversation } from '../communications/policy-conversation.js';

interface MemberContext {
  id: string;
  role: 'Host' | 'Player' | 'Observer' | 'Administrator';
  countryId: string | null;
}

interface ActionRow {
  id: string;
  quarter_id: string;
  country_id: string;
  country_name: string;
  created_by_member_id: string;
  title: string;
  category: ActionCategory;
  current_text: string;
  submitted_original_text: string | null;
  secrecy: ActionSecrecy;
  status: ActionStatus;
  version: number;
  submit_idempotency_key: string | null;
  submitted_at: Date | null;
  updated_at: Date;
}

const actionSelect = `
  SELECT a.id, a.quarter_id, a.country_id, c.name AS country_name,
         a.created_by_member_id, a.title, a.category, a.current_text,
         a.submitted_original_text, a.secrecy, a.status, a.version,
         a.submit_idempotency_key, a.submitted_at, a.updated_at
  FROM actions a JOIN countries c ON c.id = a.country_id
`;

function summary(row: ActionRow): ActionSummary {
  return {
    id: row.id,
    quarterId: row.quarter_id,
    countryId: row.country_id,
    countryName: row.country_name,
    createdByMemberId: row.created_by_member_id,
    title: row.title,
    category: row.category,
    secrecy: row.secrecy,
    status: row.status,
    version: row.version,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  };
}

export class ActionService {
  constructor(private readonly database: DatabasePool) {}

  private async member(
    gameId: string,
    userId: string,
    client: DatabasePool | DatabaseClient = this.database,
  ): Promise<MemberContext> {
    const result = await client.query<{
      id: string;
      role: MemberContext['role'];
      controlled_country_id: string | null;
    }>(
      `SELECT id, role, controlled_country_id FROM game_members
       WHERE game_id = $1 AND user_id = $2 AND status = 'Active'`,
      [gameId, userId],
    );
    const row = result.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return { id: row.id, role: row.role, countryId: row.controlled_country_id };
  }

  private requirePlayer(member: MemberContext): string {
    if (member.role !== 'Player' || !member.countryId) {
      throw new ApiFault(
        403,
        'PLAYER_ACTION_REQUIRED',
        '只有已分配国家的玩家可以编辑行动。',
      );
    }
    return member.countryId;
  }

  private requireHost(member: MemberContext): void {
    if (member.role !== 'Host' && member.role !== 'Administrator') {
      throw new ApiFault(
        403,
        'HOST_PERMISSION_REQUIRED',
        '该操作需要主持人权限。',
      );
    }
  }

  private async ensureQuarterEditable(
    client: DatabasePool | DatabaseClient,
    gameId: string,
    quarterId: string,
    submissionMustBeOpen = false,
    requestedActionId?: string,
  ): Promise<string> {
    const result = await client.query<{
      state: string;
      action_deadline: Date | null;
    }>(
      `SELECT state, action_deadline FROM quarters
       WHERE game_id = $1 AND id = $2 AND is_current = TRUE FOR SHARE`,
      [gameId, quarterId],
    );
    const quarter = result.rows[0];
    if (!quarter)
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到当前季度。');
    if (
      requestedActionId &&
      ['ActionSubmission', 'Locked', 'HostReview'].includes(quarter.state)
    ) {
      const pending = await client.query(
        `SELECT r.id FROM action_input_requests r JOIN actions a ON a.id = r.action_id AND a.game_id = r.game_id
         WHERE r.game_id = $1 AND r.action_id = $2 AND r.status = 'Pending'
           AND a.status = 'NeedPlayerInput' AND a.quarter_id = $3 LIMIT 1`,
        [gameId, requestedActionId, quarterId],
      );
      if (pending.rows[0]) return quarter.state;
    }
    if (
      !['Preparing', 'EventResponse', 'ActionSubmission'].includes(
        quarter.state,
      )
    ) {
      throw new ApiFault(409, 'ACTION_SUBMISSION_LOCKED', '行动提交已经锁定。');
    }
    if (submissionMustBeOpen && quarter.state !== 'ActionSubmission') {
      throw new ApiFault(
        409,
        'ACTION_SUBMISSION_NOT_OPEN',
        '主持人尚未开放行动提交。',
      );
    }
    if (
      quarter.action_deadline &&
      quarter.action_deadline.getTime() <= Date.now()
    ) {
      throw new ApiFault(
        409,
        'ACTION_DEADLINE_PASSED',
        '行动提交截止时间已过。',
      );
    }
    return quarter.state;
  }

  private async lockActionQuarter(
    client: DatabaseClient,
    gameId: string,
    actionId: string,
  ) {
    // 回合切换会先锁回合再更新行动，编辑和审核也采用相同顺序。
    const result = await client.query<{ state: string; is_current: boolean }>(
      `SELECT q.state, q.is_current FROM quarters q WHERE q.game_id = $1 AND q.id = (
         SELECT quarter_id FROM actions WHERE game_id = $1 AND id = $2
       ) FOR SHARE`,
      [gameId, actionId],
    );
    if (!result.rows[0])
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该行动。');
    return result.rows[0];
  }

  private requireReviewOpen(quarter: { state: string; is_current: boolean }) {
    if (
      !quarter.is_current ||
      !['ActionSubmission', 'Locked', 'HostReview'].includes(quarter.state)
    ) {
      throw new ApiFault(409, 'ACTION_REVIEW_LOCKED', '本回合审核已经结束。');
    }
  }

  private async validateRefs(
    client: DatabasePool | DatabaseClient,
    gameId: string,
    countryId: string,
    refs: Array<Omit<ActionObjectRef, 'id'>>,
  ): Promise<void> {
    const tableByType: Record<ActionObjectRef['objectType'], string> = {
      Tile: 'hex_tiles',
      City: 'cities',
      Army: 'armies',
      Country: 'countries',
      Character: 'characters',
      Region: 'regions',
      Province: 'provinces',
    };
    for (const ref of refs) {
      const table = tableByType[ref.objectType];
      let condition = 'object.game_id = $1 AND object.id = $2';
      const values: unknown[] = [gameId, ref.objectId];
      if (ref.objectType === 'Army') {
        condition += ` AND (object.country_id = $3 OR EXISTS (
          SELECT 1 FROM country_army_intelligence cai
          WHERE cai.game_id = $1 AND cai.country_id = $3 AND cai.army_id = object.id
        ))`;
        values.push(countryId);
      } else if (ref.objectType === 'City') {
        condition += ` AND EXISTS (
          SELECT 1 FROM country_tile_knowledge ctk
          WHERE ctk.game_id = $1 AND ctk.country_id = $3
            AND ctk.tile_id = object.tile_id
            AND ctk.discovery_state IN ('Mapped', 'Observed', 'Outdated')
        )`;
        values.push(countryId);
      } else if (ref.objectType === 'Character') {
        condition += ' AND object.country_id = $3';
        values.push(countryId);
      } else if (ref.objectType === 'Province') {
        condition += ` AND EXISTS (
          SELECT 1 FROM country_tile_knowledge ctk
          WHERE ctk.game_id = $1 AND ctk.country_id = $3
            AND ctk.discovery_state IN ('Mapped', 'Observed', 'Outdated')
            AND ctk.snapshot->>'provinceName' = object.name
            AND COALESCE((ctk.snapshot->>'administrationKnown')::boolean,ctk.discovery_state IN ('Observed','Outdated'))
        )`;
        values.push(countryId);
      } else if (ref.objectType === 'Region') {
        condition += ` AND EXISTS (
          SELECT 1 FROM hex_tiles t
          JOIN country_tile_knowledge ctk ON ctk.tile_id = t.id AND ctk.game_id = t.game_id
          WHERE t.game_id = $1 AND t.region_id = object.id AND ctk.country_id = $3
            AND ctk.discovery_state IN ('Mapped', 'Observed', 'Outdated')
            AND COALESCE((ctk.snapshot->>'administrationKnown')::boolean,ctk.discovery_state IN ('Observed','Outdated'))
        )`;
        values.push(countryId);
      }
      const found = await client.query(
        `SELECT object.id FROM ${table} object WHERE ${condition}`,
        values,
      );
      if (!found.rows[0]) {
        throw new ApiFault(
          400,
          'INVALID_ACTION_REFERENCE',
          '行动包含无权引用的对象。',
        );
      }
    }
  }

  private async insertVersion(
    client: DatabaseClient,
    gameId: string,
    actionId: string,
    version: number,
    input: {
      title: string;
      originalText: string;
      category: ActionCategory;
      secrecy: ActionSecrecy;
    },
    userId: string,
  ): Promise<void> {
    await client.query(
      `INSERT INTO action_versions (
         id, game_id, action_id, version, title, original_text,
         category, secrecy, edited_by_user_id, is_manual
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)`,
      [
        randomUUID(),
        gameId,
        actionId,
        version,
        input.title,
        input.originalText,
        input.category,
        input.secrecy,
        userId,
      ],
    );
  }

  async create(input: {
    creationId?: string;
    gameId: string;
    userId: string;
    quarterId: string;
    title: string;
    originalText: string;
    category: ActionCategory;
    secrecy: ActionSecrecy;
    refs: Array<Omit<ActionObjectRef, 'id'>>;
  }): Promise<ActionDetails> {
    const client = await this.database.connect();
    let actionId: string = randomUUID();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT id FROM quarters WHERE game_id=$1 AND id=$2 FOR SHARE',
        [input.gameId, input.quarterId],
      );
      const member = await this.member(input.gameId, input.userId, client);
      const countryId = this.requirePlayer(member);
      const fingerprint = createHash('sha256')
        .update(
          JSON.stringify({
            quarterId: input.quarterId,
            countryId,
            title: input.title,
            originalText: input.originalText,
            category: input.category,
            secrecy: input.secrecy,
            refs: input.refs.map((ref) => ({
              refKind: ref.refKind,
              objectType: ref.objectType,
              objectId: ref.objectId,
              label: ref.label,
            })),
          }),
        )
        .digest('hex');
      if (input.creationId) {
        await client.query(
          'SELECT pg_advisory_xact_lock(1936445703,hashtext($1))',
          [`${input.gameId}:${member.id}:${input.creationId}`],
        );
        const replay = await client.query<{
          id: string;
          creation_fingerprint: string;
        }>(
          'SELECT id,creation_fingerprint FROM actions WHERE game_id=$1 AND created_by_member_id=$2 AND creation_id=$3',
          [input.gameId, member.id, input.creationId],
        );
        if (replay.rows[0]) {
          if (replay.rows[0].creation_fingerprint !== fingerprint)
            throw new ApiFault(
              409,
              'ACTION_CREATION_CONFLICT',
              '上次创建已保存，当前内容与当时不同。请先保留本页文字，再从行动列表打开原草稿继续修改。',
            );
          actionId = replay.rows[0].id;
          await client.query('COMMIT');
          return this.get(input.gameId, input.userId, actionId);
        }
      }
      await this.ensureQuarterEditable(client, input.gameId, input.quarterId);
      await this.validateRefs(client, input.gameId, countryId, input.refs);
      await client.query(
        `INSERT INTO actions (
           id, game_id, quarter_id, country_id, created_by_member_id,
           title, category, current_text, secrecy,creation_id,creation_fingerprint
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          actionId,
          input.gameId,
          input.quarterId,
          countryId,
          member.id,
          input.title,
          input.category,
          input.originalText,
          input.secrecy,
          input.creationId ?? null,
          input.creationId ? fingerprint : null,
        ],
      );
      await this.insertVersion(
        client,
        input.gameId,
        actionId,
        1,
        input,
        input.userId,
      );
      for (const ref of input.refs) {
        await client.query(
          `INSERT INTO action_object_refs (
             id, game_id, action_id, ref_kind, object_type, object_id, label
           ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [
            randomUUID(),
            input.gameId,
            actionId,
            ref.refKind,
            ref.objectType,
            ref.objectId,
            ref.label,
          ],
        );
      }
      await client.query(
        `INSERT INTO action_status_history (
           id, game_id, action_id, from_status, to_status, actor_user_id
         ) VALUES ($1,$2,$3,NULL,'Draft',$4)`,
        [randomUUID(), input.gameId, actionId, input.userId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.get(input.gameId, input.userId, actionId);
  }

  async list(
    gameId: string,
    userId: string,
    hostQueue = false,
  ): Promise<ActionSummary[]> {
    const member = await this.member(gameId, userId);
    if (hostQueue) this.requireHost(member);
    const result = await this.database.query<ActionRow>(
      `${actionSelect}
       WHERE a.game_id = $1
         AND ($2::boolean OR a.country_id = $3)
         AND (NOT $4::boolean OR a.status <> 'Draft')
         AND (NOT $4::boolean OR EXISTS (
           SELECT 1 FROM quarters q WHERE q.game_id = a.game_id AND q.id = a.quarter_id AND q.is_current
         ))
       ORDER BY a.updated_at DESC`,
      [
        gameId,
        member.role === 'Host' || member.role === 'Administrator',
        member.role === 'Player' ? member.countryId : null,
        hostQueue,
      ],
    );
    return result.rows.map(summary);
  }

  async get(
    gameId: string,
    userId: string,
    actionId: string,
  ): Promise<ActionDetails> {
    const member = await this.member(gameId, userId);
    const result = await this.database.query<ActionRow>(
      `${actionSelect}
       WHERE a.game_id = $1 AND a.id = $2
         AND ($3::boolean OR a.country_id = $4)`,
      [
        gameId,
        actionId,
        member.role === 'Host' || member.role === 'Administrator',
        member.role === 'Player' ? member.countryId : null,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该行动。');
    const [refs, submissions, interpretation, request, history] =
      await Promise.all([
        this.database.query<{
          id: string;
          ref_kind: ActionObjectRef['refKind'];
          object_type: ActionObjectRef['objectType'];
          object_id: string;
          label: string;
        }>(
          `SELECT id, ref_kind, object_type, object_id, label
         FROM action_object_refs WHERE game_id = $1 AND action_id = $2 ORDER BY id`,
          [gameId, actionId],
        ),
        this.database.query<{
          id: string;
          version: number;
          title: string;
          text: string;
          category: ActionCategory;
          secrecy: ActionSecrecy;
          submitted_at: Date;
          refs: ActionSubmission['refs'];
        }>(
          `SELECT id, version, title, text, category, secrecy, refs, submitted_at
         FROM action_submissions WHERE game_id = $1 AND action_id = $2
         ORDER BY submitted_at DESC, id DESC`,
          [gameId, actionId],
        ),
        this.database.query<{ text: string }>(
          `SELECT text FROM action_interpretations
         WHERE game_id = $1 AND action_id = $2 ORDER BY created_at DESC LIMIT 1`,
          [gameId, actionId],
        ),
        this.database.query<{ message: string }>(
          `SELECT message FROM action_input_requests
         WHERE game_id = $1 AND action_id = $2 AND status = 'Pending'
         ORDER BY created_at DESC LIMIT 1`,
          [gameId, actionId],
        ),
        this.database.query<{
          from_status: ActionStatus | null;
          to_status: ActionStatus;
          reason: string;
          created_at: Date;
        }>(
          `SELECT from_status, to_status, reason, created_at
         FROM action_status_history WHERE game_id = $1 AND action_id = $2
         ORDER BY created_at, id`,
          [gameId, actionId],
        ),
      ]);
    return {
      ...summary(row),
      currentText: row.current_text,
      submittedOriginalText: row.submitted_original_text,
      refs: refs.rows.map((ref) => ({
        id: ref.id,
        refKind: ref.ref_kind,
        objectType: ref.object_type,
        objectId: ref.object_id,
        label: ref.label,
      })),
      latestInterpretation: interpretation.rows[0]?.text ?? null,
      pendingInputRequest: request.rows[0]?.message ?? null,
      submissions: submissions.rows.map((item) => ({
        id: item.id,
        version: item.version,
        title: item.title,
        text: item.text,
        category: item.category,
        secrecy: item.secrecy,
        refs: item.refs,
        submittedAt: item.submitted_at.toISOString(),
      })),
      history: history.rows.map((item) => ({
        fromStatus: item.from_status,
        toStatus: item.to_status,
        reason: item.reason,
        createdAt: item.created_at.toISOString(),
      })),
    };
  }

  async versions(
    gameId: string,
    userId: string,
    actionId: string,
  ): Promise<ActionVersion[]> {
    await this.get(gameId, userId, actionId);
    const result = await this.database.query<{
      version: number;
      title: string;
      original_text: string;
      category: ActionCategory;
      secrecy: ActionSecrecy;
      created_at: Date;
    }>(
      `SELECT version, title, original_text, category, secrecy, created_at
       FROM action_versions
       WHERE game_id = $1 AND action_id = $2 AND is_manual = TRUE
       ORDER BY version DESC`,
      [gameId, actionId],
    );
    return result.rows.map((row) => ({
      version: row.version,
      title: row.title,
      originalText: row.original_text,
      category: row.category,
      secrecy: row.secrecy,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async update(input: {
    gameId: string;
    userId: string;
    actionId: string;
    expectedVersion: number;
    title: string;
    originalText: string;
    category: ActionCategory;
    secrecy: ActionSecrecy;
    refs?: Array<Omit<ActionObjectRef, 'id'>>;
  }): Promise<ActionDetails> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await this.lockActionQuarter(client, input.gameId, input.actionId);
      const member = await this.member(input.gameId, input.userId, client);
      const countryId = this.requirePlayer(member);
      const locked = await client.query<ActionRow>(
        `${actionSelect} WHERE a.game_id = $1 AND a.id = $2 FOR UPDATE`,
        [input.gameId, input.actionId],
      );
      const action = locked.rows[0];
      if (
        !action ||
        action.created_by_member_id !== member.id ||
        action.country_id !== countryId
      ) {
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该行动。');
      }
      if (!['Draft', 'NeedPlayerInput'].includes(action.status)) {
        throw new ApiFault(
          409,
          'ACTION_NOT_EDITABLE',
          '当前行动状态不可修改。',
        );
      }
      await this.ensureQuarterEditable(
        client,
        input.gameId,
        action.quarter_id,
        false,
        input.actionId,
      );
      if (action.version !== input.expectedVersion) {
        throw new ApiFault(
          409,
          'ACTION_VERSION_CONFLICT',
          '草稿已在其他窗口更新。',
          {
            currentVersion: action.version,
          },
        );
      }
      if (input.refs) {
        await this.validateRefs(client, input.gameId, countryId, input.refs);
      }
      const nextVersion = action.version + 1;
      await client.query(
        `UPDATE actions SET title = $1, current_text = $2, category = $3,
                secrecy = $4, version = $5, updated_at = NOW()
         WHERE game_id = $6 AND id = $7`,
        [
          input.title,
          input.originalText,
          input.category,
          input.secrecy,
          nextVersion,
          input.gameId,
          input.actionId,
        ],
      );
      if (input.refs) {
        await client.query(
          'DELETE FROM action_object_refs WHERE game_id = $1 AND action_id = $2',
          [input.gameId, input.actionId],
        );
        for (const ref of input.refs) {
          await client.query(
            `INSERT INTO action_object_refs (
               id, game_id, action_id, ref_kind, object_type, object_id, label
             ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [
              randomUUID(),
              input.gameId,
              input.actionId,
              ref.refKind,
              ref.objectType,
              ref.objectId,
              ref.label,
            ],
          );
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.get(input.gameId, input.userId, input.actionId);
  }

  async saveVersion(input: {
    gameId: string;
    userId: string;
    actionId: string;
    expectedVersion: number;
  }): Promise<ActionVersion[]> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await this.lockActionQuarter(client, input.gameId, input.actionId);
      const member = await this.member(input.gameId, input.userId, client);
      const countryId = this.requirePlayer(member);
      const locked = await client.query<ActionRow>(
        `${actionSelect} WHERE a.game_id = $1 AND a.id = $2 FOR UPDATE`,
        [input.gameId, input.actionId],
      );
      const action = locked.rows[0];
      if (
        !action ||
        action.created_by_member_id !== member.id ||
        action.country_id !== countryId
      ) {
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该行动。');
      }
      if (!['Draft', 'NeedPlayerInput'].includes(action.status)) {
        throw new ApiFault(
          409,
          'ACTION_NOT_EDITABLE',
          '当前行动状态不可保存草稿版本。',
        );
      }
      await this.ensureQuarterEditable(
        client,
        input.gameId,
        action.quarter_id,
        false,
        input.actionId,
      );
      if (action.version !== input.expectedVersion) {
        throw new ApiFault(
          409,
          'ACTION_VERSION_CONFLICT',
          '草稿已在其他窗口更新。',
          { currentVersion: action.version },
        );
      }
      const promoted = await client.query(
        `UPDATE action_versions SET is_manual = TRUE
         WHERE game_id = $1 AND action_id = $2 AND version = $3
         RETURNING id`,
        [input.gameId, input.actionId, action.version],
      );
      if (!promoted.rows[0]) {
        await this.insertVersion(
          client,
          input.gameId,
          input.actionId,
          action.version,
          {
            title: action.title,
            originalText: action.current_text,
            category: action.category,
            secrecy: action.secrecy,
          },
          input.userId,
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.versions(input.gameId, input.userId, input.actionId);
  }

  async submit(input: {
    gameId: string;
    userId: string;
    actionId: string;
    idempotencyKey: string;
  }): Promise<ActionDetails> {
    return this.playerTransition(
      input,
      ['Draft', 'NeedPlayerInput'],
      'Submitted',
      '提交行动',
    );
  }

  async withdraw(input: {
    gameId: string;
    userId: string;
    actionId: string;
    idempotencyKey?: string;
  }): Promise<ActionDetails> {
    return this.playerTransition(
      { ...input, idempotencyKey: input.idempotencyKey ?? randomUUID() },
      ['Submitted', 'HostReview', 'NeedPlayerInput', 'PendingHostApproval'],
      'Withdrawn',
      '玩家撤回',
    );
  }

  private async playerTransition(
    input: {
      gameId: string;
      userId: string;
      actionId: string;
      idempotencyKey: string;
    },
    allowed: ActionStatus[],
    target: ActionStatus,
    reason: string,
  ): Promise<ActionDetails> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      await this.lockActionQuarter(client, input.gameId, input.actionId);
      const member = await this.member(input.gameId, input.userId, client);
      const countryId = this.requirePlayer(member);
      const result = await client.query<ActionRow>(
        `${actionSelect} WHERE a.game_id = $1 AND a.id = $2 FOR UPDATE`,
        [input.gameId, input.actionId],
      );
      const action = result.rows[0];
      if (
        !action ||
        action.created_by_member_id !== member.id ||
        action.country_id !== countryId
      ) {
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该行动。');
      }
      if (
        target === 'Submitted' &&
        action.submit_idempotency_key === input.idempotencyKey
      ) {
        await client.query('COMMIT');
        return this.get(input.gameId, input.userId, input.actionId);
      }
      if (!allowed.includes(action.status)) {
        throw new ApiFault(
          409,
          'INVALID_ACTION_TRANSITION',
          '当前行动状态不允许该操作。',
        );
      }
      const quarterState = await this.ensureQuarterEditable(
        client,
        input.gameId,
        action.quarter_id,
        true,
        target === 'Submitted' ? input.actionId : undefined,
      );
      if (target === 'Submitted' && action.current_text.trim().length === 0) {
        throw new ApiFault(
          400,
          'ACTION_TEXT_REQUIRED',
          '提交前必须填写行动内容。',
        );
      }
      const isSubmission = target === 'Submitted';
      const nextStatus =
        isSubmission && quarterState === 'HostReview' ? 'HostReview' : target;
      await client.query(
        `UPDATE actions SET status = $1,
           submitted_original_text = CASE WHEN $5 THEN COALESCE(submitted_original_text, current_text) ELSE submitted_original_text END,
           submit_idempotency_key = CASE WHEN $5 THEN $2 ELSE submit_idempotency_key END,
           submitted_at = CASE WHEN $5 THEN COALESCE(submitted_at, NOW()) ELSE submitted_at END,
           withdrawn_at = CASE WHEN $1 = 'Withdrawn' THEN NOW() ELSE withdrawn_at END,
           updated_at = NOW()
         WHERE game_id = $3 AND id = $4`,
        [
          nextStatus,
          input.idempotencyKey,
          input.gameId,
          input.actionId,
          isSubmission,
        ],
      );
      if (isSubmission) {
        await client.query(
          `INSERT INTO action_submissions (id, game_id, action_id, version, title, text, category, secrecy, refs)
           SELECT $1, a.game_id, a.id, a.version, a.title, a.current_text, a.category, a.secrecy,
                  COALESCE((SELECT jsonb_agg(jsonb_build_object(
                    'refKind', r.ref_kind, 'objectType', r.object_type, 'objectId', r.object_id, 'label', r.label
                  ) ORDER BY r.id) FROM action_object_refs r WHERE r.game_id = a.game_id AND r.action_id = a.id), '[]'::jsonb)
           FROM actions a WHERE a.game_id = $2 AND a.id = $3`,
          [randomUUID(), input.gameId, input.actionId],
        );
        await client.query(
          `UPDATE action_input_requests SET status = 'Answered', answered_at = NOW()
           WHERE game_id = $1 AND action_id = $2 AND status = 'Pending'`,
          [input.gameId, input.actionId],
        );
      }
      await this.addHistory(client, input, action.status, nextStatus, reason);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.get(input.gameId, input.userId, input.actionId);
  }

  private async addHistory(
    client: DatabaseClient,
    input: { gameId: string; userId: string; actionId: string },
    from: ActionStatus,
    to: ActionStatus,
    reason: string,
  ) {
    await client.query(
      `INSERT INTO action_status_history (
         id, game_id, action_id, from_status, to_status, actor_user_id, reason
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        randomUUID(),
        input.gameId,
        input.actionId,
        from,
        to,
        input.userId,
        reason,
      ],
    );
  }

  async hostInterpret(input: {
    gameId: string;
    userId: string;
    actionId: string;
    text: string;
  }): Promise<ActionDetails> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const member = await this.member(input.gameId, input.userId, client);
      this.requireHost(member);
      this.requireReviewOpen(
        await this.lockActionQuarter(client, input.gameId, input.actionId),
      );
      const action = await client.query<{ status: string }>(
        'SELECT status FROM actions WHERE game_id = $1 AND id = $2 FOR UPDATE',
        [input.gameId, input.actionId],
      );
      if (action.rows[0]?.status === 'Draft')
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到可审核行动。');
      await client.query(
        `INSERT INTO action_interpretations (id, game_id, action_id, text, created_by_user_id)
         VALUES ($1,$2,$3,$4,$5)`,
        [randomUUID(), input.gameId, input.actionId, input.text, input.userId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.get(input.gameId, input.userId, input.actionId);
  }

  async hostTransition(input: {
    gameId: string;
    userId: string;
    actionId: string;
    target: 'NeedPlayerInput' | 'Approved' | 'Rejected';
    reason: string;
  }): Promise<ActionDetails> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const member = await this.member(input.gameId, input.userId, client);
      this.requireHost(member);
      this.requireReviewOpen(
        await this.lockActionQuarter(client, input.gameId, input.actionId),
      );
      const result = await client.query<ActionRow>(
        `${actionSelect} WHERE a.game_id = $1 AND a.id = $2 FOR UPDATE`,
        [input.gameId, input.actionId],
      );
      const action = result.rows[0];
      if (!action || action.status === 'Draft') {
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到可审核行动。');
      }
      const allowedByTarget: Record<typeof input.target, ActionStatus[]> = {
        NeedPlayerInput: ['Submitted', 'HostReview'],
        Approved: ['Submitted', 'HostReview', 'PendingHostApproval'],
        Rejected: ['Submitted', 'HostReview', 'PendingHostApproval'],
      };
      if (!allowedByTarget[input.target].includes(action.status)) {
        throw new ApiFault(
          409,
          'INVALID_ACTION_TRANSITION',
          '当前行动状态不允许该审核操作。',
        );
      }
      if (input.target === 'NeedPlayerInput') {
        const requestId = randomUUID();
        await client.query(
          `INSERT INTO action_input_requests (
             id, game_id, action_id, message, created_by_user_id
           ) VALUES ($1,$2,$3,$4,$5)`,
          [requestId, input.gameId, input.actionId, input.reason, input.userId],
        );
        const conversationId = await ensurePolicyConversation(
          client,
          input.gameId,
          member.id,
          input.actionId,
        );
        await client.query(
          `WITH inserted AS (
             INSERT INTO messages (id, game_id, conversation_id, sender_member_id, content, client_message_id, sent_at)
             VALUES ($1,$2,$3,$4,$5,$1,(SELECT GREATEST(clock_timestamp(), last_message_at + INTERVAL '1 microsecond') FROM conversations WHERE id = $3)) RETURNING sent_at
           ) UPDATE conversations SET last_message_at = GREATEST(last_message_at, (SELECT sent_at FROM inserted))
             WHERE game_id = $2 AND id = $3`,
          [
            requestId,
            input.gameId,
            conversationId,
            member.id,
            `要求补充：${input.reason}\n\n请修改政策后重新提交。`,
          ],
        );
      }
      await client.query(
        `UPDATE actions SET status = $1, updated_at = NOW()
         WHERE game_id = $2 AND id = $3`,
        [input.target, input.gameId, input.actionId],
      );
      await this.addHistory(
        client,
        input,
        action.status,
        input.target,
        input.reason,
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    return this.get(input.gameId, input.userId, input.actionId);
  }
}
