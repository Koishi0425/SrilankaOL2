import { createHash, randomUUID } from 'node:crypto';
import { isGameReadOnly } from '@srilanka/contracts';
import type {
  ActionDetails,
  ActionStatus,
  QuarterSummary,
  RoundPolicy,
  RoundPolicySectionInput,
  RoundPolicySummary,
  SaveRoundPolicyInput,
  ReviewRoundPolicyInput,
} from '@srilanka/contracts';
import type { DatabaseClient, DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import { ensurePolicyConversation } from '../communications/policy-conversation.js';

type Key = {
  gameId: string;
  quarterId: string;
  memberId: string;
  countryId: string;
};
interface Row {
  id: string;
  version: number;
  status: ActionStatus;
  draft_removed: boolean;
  draft_order: number;
  precise_updated_at: string;
}
const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const host = (role: string) => ['Host', 'Administrator'].includes(role);
const inactive = (status: string) =>
  ['Draft', 'Withdrawn', 'Invalidated'].includes(status);
const reviewable = [
  'Submitted',
  'HostReview',
  'PendingHostApproval',
  'Approved',
  'Rejected',
];
function statusOf(values: ActionStatus[]): RoundPolicySummary['status'] {
  if (!values.length) return 'Draft';
  if (values.includes('NeedPlayerInput')) return 'NeedPlayerInput';
  if (
    values.some((v) =>
      ['Submitted', 'HostReview', 'PendingHostApproval'].includes(v),
    )
  )
    return values.includes('HostReview') ? 'HostReview' : 'Submitted';
  return values.every((v) => v === values[0]) ? values[0]! : 'Mixed';
}

export class RoundPolicyService {
  constructor(
    private readonly database: DatabasePool,
    private readonly validateRefs: (
      db: DatabaseClient,
      gameId: string,
      countryId: string,
      refs: RoundPolicySectionInput['refs'],
    ) => Promise<void>,
    private readonly readAction: (
      gameId: string,
      userId: string,
      actionId: string,
      db: DatabaseClient,
    ) => Promise<ActionDetails>,
  ) {}

  private async transaction<T>(
    read: boolean,
    operation: (db: DatabaseClient) => Promise<T>,
  ) {
    const db = await this.database.connect();
    try {
      await db.query(
        read ? 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY' : 'BEGIN',
      );
      const result = await operation(db);
      await db.query('COMMIT');
      return result;
    } catch (error) {
      await db.query('ROLLBACK');
      throw error;
    } finally {
      db.release();
    }
  }

  private async member(db: DatabaseClient, gameId: string, userId: string) {
    const member = (
      await db.query<{
        id: string;
        role: string;
        controlled_country_id: string | null;
      }>(
        "SELECT id,role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
        [gameId, userId],
      )
    ).rows[0];
    if (!member) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该游戏。');
    return member;
  }

  private async context(
    db: DatabaseClient,
    key: Key,
    userId: string,
    lock = false,
  ) {
    // The same quarter-first order serializes saving the whole document, old clients,
    // membership changes, review and settlement. No partial batch can escape.
    const quarter = (
      await db.query<{
        id: string;
        game_year: number;
        season: QuarterSummary['season'];
        sequence_number: number;
        state: QuarterSummary['state'];
        is_current: boolean;
        action_deadline: Date | null;
        current_world_version: string;
        game_status: Parameters<typeof isGameReadOnly>[0];
      }>(
        `SELECT q.*,g.current_world_version,g.status AS game_status FROM quarters q JOIN games g ON g.id=q.game_id
       WHERE q.game_id=$1 AND q.id=$2 ${lock ? 'FOR UPDATE OF q' : ''}`,
        [key.gameId, key.quarterId],
      )
    ).rows[0];
    if (!quarter) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该回合。');
    const actor = await this.member(db, key.gameId, userId);
    if (
      !host(actor.role) &&
      (actor.role !== 'Player' || actor.controlled_country_id !== key.countryId)
    )
      throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到这份回合政策。');
    const author = (
      await db.query<{ display_name: string; country_name: string }>(
        `SELECT u.display_name,c.name AS country_name FROM game_members m JOIN users u ON u.id=m.user_id
       JOIN countries c ON c.game_id=m.game_id AND c.id=$3 WHERE m.game_id=$1 AND m.id=$2`,
        [key.gameId, key.memberId, key.countryId],
      )
    ).rows[0];
    if (!author) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到提交者。');
    const rows = (
      await db.query<Row>(
        `SELECT id,version,status,draft_removed,draft_order,updated_at::text AS precise_updated_at
       FROM actions WHERE game_id=$1 AND quarter_id=$2 AND created_by_member_id=$3 AND country_id=$4
       ORDER BY draft_order,created_at,id ${lock ? 'FOR UPDATE' : ''}`,
        [key.gameId, key.quarterId, key.memberId, key.countryId],
      )
    ).rows;
    return { actor, author, quarter, rows, revision: hash([key, rows]) };
  }

  private async read(
    db: DatabaseClient,
    key: Key,
    userId: string,
  ): Promise<RoundPolicy> {
    const { actor, author, quarter, rows, revision } = await this.context(
      db,
      key,
      userId,
    );
    const own =
      actor.id === key.memberId &&
      actor.role === 'Player' &&
      actor.controlled_country_id === key.countryId;
    // The old records remain the authoritative section IDs for map/settlement tools.
    const details = await Promise.all(
      rows.map((row) => this.readAction(key.gameId, userId, row.id, db)),
    );
    const sections = details
      .filter((a) => !inactive(a.status))
      .map((a) => {
        const formal = a.submissions[0];
        return {
          id: a.id,
          title: formal?.title ?? a.title,
          text: formal?.text ?? a.submittedOriginalText ?? '',
          category: formal?.category ?? a.category,
          secrecy: formal?.secrecy ?? a.secrecy,
          refs: formal?.refs ?? [],
          status: a.status,
          reviewReason:
            [...a.history]
              .reverse()
              .find((h) =>
                ['Approved', 'Rejected', 'NeedPlayerInput'].includes(
                  h.toStatus,
                ),
              )?.reason ?? '',
        };
      });
    const pendingInputRequest =
      [
        ...new Set(
          details
            .filter((a) => a.status === 'NeedPlayerInput')
            .map((a) => a.pendingInputRequest)
            .filter(Boolean),
        ),
      ].join('\n') || null;
    const open = quarter.is_current && !isGameReadOnly(quarter.game_status);
    const ordinary =
      ['Preparing', 'EventResponse', 'ActionSubmission'].includes(
        quarter.state,
      ) &&
      (!quarter.action_deadline ||
        quarter.action_deadline.getTime() > Date.now()) &&
      details.every((a) =>
        ['Draft', 'Submitted', 'Withdrawn', 'Invalidated'].includes(a.status),
      );
    const supplement =
      !!pendingInputRequest &&
      ['ActionSubmission', 'Locked', 'HostReview'].includes(quarter.state);
    const canEdit = own && open && (ordinary || supplement);
    const historyRows = rows.length
      ? (
          await db.query<{
            id: string;
            action_id: string;
            title: string;
            text: string;
            category: RoundPolicySectionInput['category'];
            secrecy: RoundPolicySectionInput['secrecy'];
            refs: RoundPolicySectionInput['refs'];
            submitted_at: Date;
            submission_group_id: string | null;
            section_order: number;
          }>(
            `SELECT * FROM action_submissions WHERE game_id=$1 AND action_id=ANY($2::uuid[]) ORDER BY submitted_at DESC,section_order,id DESC`,
            [key.gameId, rows.map((r) => r.id)],
          )
        ).rows
      : [];
    const history = new Map<string, RoundPolicy['history'][number]>();
    // Draft ordering must not reorder the host's last formal document.
    const formalOrder = new Map<string, number>();
    for (const entry of historyRows) {
      if (!formalOrder.has(entry.action_id))
        formalOrder.set(entry.action_id, entry.section_order);
      const id = entry.submission_group_id ?? entry.id;
      const item = history.get(id) ?? {
        id,
        submittedAt: entry.submitted_at.toISOString(),
        whole: !!entry.submission_group_id,
        sections: [],
      };
      item.sections.push({
        id: entry.action_id,
        title: entry.title,
        text: entry.text,
        category: entry.category,
        secrecy: entry.secrecy,
        refs: entry.refs,
      });
      history.set(id, item);
    }
    sections.sort(
      (a, b) => (formalOrder.get(a.id) ?? 0) - (formalOrder.get(b.id) ?? 0),
    );
    return {
      quarterId: key.quarterId,
      memberId: key.memberId,
      countryId: key.countryId,
      countryName: author.country_name,
      playerName: author.display_name,
      status: sections.length
        ? statusOf(sections.map((s) => s.status))
        : details.some((a) => a.status === 'Withdrawn')
          ? 'Withdrawn'
          : 'Draft',
      sectionCount: sections.length,
      submittedAt: historyRows[0]?.submitted_at.toISOString() ?? null,
      revision,
      quarter: {
        id: quarter.id,
        gameYear: quarter.game_year,
        season: quarter.season,
        sequenceNumber: quarter.sequence_number,
        state: quarter.state,
        actionDeadline: quarter.action_deadline?.toISOString() ?? null,
        currentWorldVersion: Number(quarter.current_world_version),
      },
      canEdit,
      canSubmit:
        canEdit && (quarter.state === 'ActionSubmission' || supplement),
      sections,
      pendingInputRequest,
      interpretation:
        details.find((a) => a.latestInterpretation)?.latestInterpretation ?? '',
      ...(own
        ? {
            draftSections: details
              .filter(
                (a) =>
                  !rows.find((r) => r.id === a.id)!.draft_removed &&
                  !['Withdrawn', 'Invalidated'].includes(a.status),
              )
              .map((a) => ({
                id: a.id,
                title: a.title,
                text: a.currentText,
                category: a.category,
                secrecy: a.secrecy,
                refs: a.refs.map(({ id: _id, ...ref }) => ref),
              })),
          }
        : {}),
      history: [...history.values()],
    };
  }

  async list(
    gameId: string,
    userId: string,
    quarterId: string,
  ): Promise<RoundPolicySummary[]> {
    return this.transaction(true, async (db) => {
      const actor = await this.member(db, gameId, userId);
      if (!host(actor.role) && actor.role !== 'Player') return [];
      const keys = (
        await db.query<{ member_id: string; country_id: string }>(
          `SELECT DISTINCT created_by_member_id AS member_id,country_id FROM actions
         WHERE game_id=$1 AND quarter_id=$2 AND ($3::boolean OR country_id=$4)
         AND ($3::boolean = FALSE OR submitted_original_text IS NOT NULL)`,
          [gameId, quarterId, host(actor.role), actor.controlled_country_id],
        )
      ).rows;
      const data = await Promise.all(
        keys.map((key) =>
          this.read(
            db,
            {
              gameId,
              quarterId,
              memberId: key.member_id,
              countryId: key.country_id,
            },
            userId,
          ),
        ),
      );
      return data
        .filter((p) => !host(actor.role) || p.submittedAt)
        .map(
          ({
            quarterId,
            memberId,
            countryId,
            countryName,
            playerName,
            status,
            sectionCount,
            submittedAt,
          }) => ({
            quarterId,
            memberId,
            countryId,
            countryName,
            playerName,
            status,
            sectionCount,
            submittedAt,
          }),
        );
    });
  }

  async get(
    gameId: string,
    userId: string,
    quarterId: string,
    memberId: string,
    countryId: string,
  ) {
    return this.transaction(true, (db) =>
      this.read(db, { gameId, quarterId, memberId, countryId }, userId),
    );
  }

  async mine(gameId: string, userId: string, quarterId: string) {
    return this.transaction(true, async (db) => {
      const actor = await this.member(db, gameId, userId);
      if (actor.role !== 'Player' || !actor.controlled_country_id)
        throw new ApiFault(
          403,
          'PLAYER_ACTION_REQUIRED',
          '请先由主持人分配国家。',
        );
      return this.read(
        db,
        {
          gameId,
          quarterId,
          memberId: actor.id,
          countryId: actor.controlled_country_id,
        },
        userId,
      );
    });
  }

  async fromAction(gameId: string, userId: string, actionId: string) {
    return this.transaction(true, async (db) => {
      const row = (
        await db.query<{
          quarter_id: string;
          created_by_member_id: string;
          country_id: string;
        }>(
          'SELECT quarter_id,created_by_member_id,country_id FROM actions WHERE game_id=$1 AND id=$2',
          [gameId, actionId],
        )
      ).rows[0];
      if (!row) throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到该政策。');
      return this.read(
        db,
        {
          gameId,
          quarterId: row.quarter_id,
          memberId: row.created_by_member_id,
          countryId: row.country_id,
        },
        userId,
      );
    });
  }

  private async replay(
    db: DatabaseClient,
    key: Key,
    userId: string,
    requestId: string,
    fingerprint: string,
  ) {
    const row = (
      await db.query<{ fingerprint: string; actor_user_id: string }>(
        'SELECT fingerprint,actor_user_id FROM round_policy_requests WHERE id=$1',
        [requestId],
      )
    ).rows[0];
    if (
      row &&
      (row.fingerprint !== fingerprint || row.actor_user_id !== userId)
    )
      throw new ApiFault(
        409,
        'POLICY_REQUEST_CONFLICT',
        '本次请求标识已用于其他内容。',
      );
    if (row) return true;
    await db.query(
      `INSERT INTO round_policy_requests(id,game_id,quarter_id,member_id,country_id,actor_user_id,fingerprint) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        requestId,
        key.gameId,
        key.quarterId,
        key.memberId,
        key.countryId,
        userId,
        fingerprint,
      ],
    );
    return false;
  }

  private version(actual: string, expected: string) {
    if (actual !== expected)
      throw new ApiFault(
        409,
        'ROUND_POLICY_CHANGED',
        '这份回合政策已有更新，请保留本页文字并重新读取后核对。',
      );
  }

  async save(
    gameId: string,
    userId: string,
    quarterId: string,
    input: SaveRoundPolicyInput,
  ) {
    await this.transaction(false, async (db) => {
      // Read identity first, then recheck it after acquiring the quarter lock.
      const before = await this.member(db, gameId, userId);
      if (before.role !== 'Player' || !before.controlled_country_id)
        throw new ApiFault(
          403,
          'PLAYER_ACTION_REQUIRED',
          '请先由主持人分配国家。',
        );
      const key = {
        gameId,
        quarterId,
        memberId: before.id,
        countryId: before.controlled_country_id,
      };
      const context = await this.context(db, key, userId, true);
      await db.query('SELECT require_writable_game($1)', [gameId]);
      if (
        await this.replay(
          db,
          key,
          userId,
          input.requestId,
          hash(['save', key, input]),
        )
      )
        return;
      this.version(context.revision, input.expectedRevision);
      const policy = await this.read(db, key, userId);
      if (!policy.canEdit || (input.submit && !policy.canSubmit))
        throw new ApiFault(
          409,
          'ACTION_SUBMISSION_LOCKED',
          '当前不能修改或提交整份政策，请核对回合阶段或补充请求。',
        );
      if (
        new Set(input.sections.map((s) => s.id)).size !== input.sections.length
      )
        throw new ApiFault(400, 'INVALID_POLICY_SECTION', '分项标识不能重复。');
      if (
        input.submit &&
        (!input.sections.length || input.sections.some((s) => !s.text.trim()))
      )
        throw new ApiFault(
          400,
          'ACTION_TEXT_REQUIRED',
          '请填写各分项的具体政策，或移除空白分项后再整份提交。',
        );
      const old = new Map(context.rows.map((r) => [r.id, r]));
      const newIds = input.sections
        .filter((s) => !old.has(s.id))
        .map((s) => s.id);
      if (
        newIds.length &&
        (
          await db.query('SELECT id FROM actions WHERE id=ANY($1::uuid[])', [
            newIds,
          ])
        ).rowCount
      )
        throw new ApiFault(400, 'INVALID_POLICY_SECTION', '分项包含无效标识。');
      const ids = input.sections.map((s) => s.id);
      await db.query(
        `UPDATE actions SET draft_removed=TRUE,updated_at=NOW() WHERE game_id=$1 AND quarter_id=$2 AND created_by_member_id=$3 AND country_id=$4 AND NOT(id=ANY($5::uuid[]))`,
        [gameId, quarterId, key.memberId, key.countryId, ids],
      );
      for (const [index, section] of input.sections.entries()) {
        await this.validateRefs(db, gameId, key.countryId, section.refs);
        const previous = old.get(section.id);
        if (previous && ['Withdrawn', 'Invalidated'].includes(previous.status))
          throw new ApiFault(
            409,
            'INVALID_POLICY_SECTION',
            '已撤回或失效的分项不能复用，请新增分项。',
          );
        if (previous) {
          await db.query(
            `UPDATE actions SET title=$3,current_text=$4,category=$5,secrecy=$6,version=version+1,draft_removed=FALSE,draft_order=$7,updated_at=NOW() WHERE game_id=$1 AND id=$2`,
            [
              gameId,
              section.id,
              section.title,
              section.text,
              section.category,
              section.secrecy,
              index,
            ],
          );
        } else {
          await db.query(
            `INSERT INTO actions(id,game_id,quarter_id,country_id,created_by_member_id,title,current_text,category,secrecy,draft_order) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [
              section.id,
              gameId,
              quarterId,
              key.countryId,
              key.memberId,
              section.title,
              section.text,
              section.category,
              section.secrecy,
              index,
            ],
          );
          await this.history(
            db,
            gameId,
            section.id,
            userId,
            null,
            'Draft',
            '加入本回合政策分项',
          );
        }
        await db.query(
          'DELETE FROM action_object_refs WHERE game_id=$1 AND action_id=$2',
          [gameId, section.id],
        );
        for (const ref of section.refs)
          await db.query(
            `INSERT INTO action_object_refs(id,game_id,action_id,ref_kind,object_type,object_id,label) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              randomUUID(),
              gameId,
              section.id,
              ref.refKind,
              ref.objectType,
              ref.objectId,
              ref.label,
            ],
          );
        await db.query(
          `INSERT INTO action_versions(id,game_id,action_id,version,title,original_text,category,secrecy,edited_by_user_id,is_manual)
          SELECT $1,game_id,id,version,title,current_text,category,secrecy,$4,TRUE FROM actions WHERE game_id=$2 AND id=$3`,
          [randomUUID(), gameId, section.id, userId],
        );
        if (input.submit) {
          const next =
            context.quarter.state === 'HostReview' ? 'HostReview' : 'Submitted';
          await db.query(
            `UPDATE actions SET status=$3,submitted_original_text=COALESCE(submitted_original_text,current_text),submitted_at=COALESCE(submitted_at,NOW()),submit_idempotency_key=$4,updated_at=NOW() WHERE game_id=$1 AND id=$2`,
            [gameId, section.id, next, randomUUID()],
          );
          await db.query(
            `INSERT INTO action_submissions(id,game_id,action_id,version,title,text,category,secrecy,refs,submission_group_id,section_order)
            SELECT $1,game_id,id,version,title,current_text,category,secrecy,$4::jsonb,$5,$6 FROM actions WHERE game_id=$2 AND id=$3`,
            [
              randomUUID(),
              gameId,
              section.id,
              JSON.stringify(section.refs),
              input.requestId,
              index,
            ],
          );
          await db.query(
            "UPDATE action_input_requests SET status='Answered',answered_at=NOW() WHERE game_id=$1 AND action_id=$2 AND status='Pending'",
            [gameId, section.id],
          );
          await this.history(
            db,
            gameId,
            section.id,
            userId,
            previous?.status ?? 'Draft',
            next,
            '整份回合政策正式提交',
          );
        }
      }
      if (input.submit)
        for (const previous of context.rows.filter(
          (r) =>
            !ids.includes(r.id) &&
            !['Withdrawn', 'Invalidated'].includes(r.status),
        )) {
          await db.query(
            "UPDATE actions SET status='Withdrawn',withdrawn_at=NOW(),updated_at=NOW() WHERE game_id=$1 AND id=$2",
            [gameId, previous.id],
          );
          await db.query(
            "UPDATE action_input_requests SET status='Answered',answered_at=NOW() WHERE game_id=$1 AND action_id=$2 AND status='Pending'",
            [gameId, previous.id],
          );
          await this.history(
            db,
            gameId,
            previous.id,
            userId,
            previous.status,
            'Withdrawn',
            '从整份回合政策中移除',
          );
        }
    });
    return this.mine(gameId, userId, quarterId);
  }

  private async history(
    db: DatabaseClient,
    gameId: string,
    actionId: string,
    userId: string,
    from: ActionStatus | null,
    to: ActionStatus,
    reason: string,
  ) {
    await db.query(
      `INSERT INTO action_status_history(id,game_id,action_id,from_status,to_status,actor_user_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [randomUUID(), gameId, actionId, from, to, userId, reason],
    );
  }

  async review(key: Key, userId: string, input: ReviewRoundPolicyInput) {
    await this.transaction(false, async (db) => {
      const context = await this.context(db, key, userId, true);
      if (!host(context.actor.role))
        throw new ApiFault(
          403,
          'HOST_PERMISSION_REQUIRED',
          '整份审核需要主持人权限。',
        );
      await db.query('SELECT require_writable_game($1)', [key.gameId]);
      if (
        await this.replay(
          db,
          key,
          userId,
          input.requestId,
          hash(['review', key, input]),
        )
      )
        return;
      this.version(context.revision, input.expectedRevision);
      if (
        !context.quarter.is_current ||
        !['ActionSubmission', 'Locked', 'HostReview'].includes(
          context.quarter.state,
        )
      )
        throw new ApiFault(
          409,
          'ACTION_REVIEW_LOCKED',
          '当前回合不能审核政策。',
        );
      const formal = context.rows.filter((r) => !inactive(r.status));
      if (!formal.length)
        throw new ApiFault(
          409,
          'NO_SUBMITTED_POLICY',
          '玩家尚未正式提交政策。',
        );
      if (
        input.target !== 'Interpretation' &&
        formal.some((r) => !reviewable.includes(r.status))
      )
        throw new ApiFault(
          409,
          'POLICY_AWAITING_INPUT',
          '请等待玩家整份交回补充后再审核。',
        );
      if (input.target === 'Interpretation') {
        for (const row of formal)
          await db.query(
            `INSERT INTO action_interpretations(id,game_id,action_id,text,created_by_user_id) VALUES($1,$2,$3,$4,$5)`,
            [randomUUID(), key.gameId, row.id, input.reason, userId],
          );
        return;
      }
      for (const row of formal) {
        if (row.status === input.target) continue;
        await db.query(
          'UPDATE actions SET status=$3,updated_at=NOW() WHERE game_id=$1 AND id=$2',
          [key.gameId, row.id, input.target],
        );
        if (input.target === 'NeedPlayerInput')
          await db.query(
            `INSERT INTO action_input_requests(id,game_id,action_id,message,created_by_user_id) VALUES($1,$2,$3,$4,$5)`,
            [randomUUID(), key.gameId, row.id, input.reason, userId],
          );
        await this.history(
          db,
          key.gameId,
          row.id,
          userId,
          row.status,
          input.target,
          input.reason,
        );
      }
      if (input.target === 'NeedPlayerInput') {
        const conversation = await ensurePolicyConversation(
          db,
          key.gameId,
          context.actor.id,
          formal[0]!.id,
        );
        const id = randomUUID();
        await db.query(
          `WITH inserted AS (INSERT INTO messages(id,game_id,conversation_id,sender_member_id,content,client_message_id,sent_at)
          VALUES($1,$2,$3,$4,$5,$1,(SELECT GREATEST(clock_timestamp(),last_message_at+INTERVAL '1 microsecond') FROM conversations WHERE id=$3)) RETURNING sent_at)
          UPDATE conversations SET last_message_at=(SELECT sent_at FROM inserted) WHERE id=$3`,
          [
            id,
            key.gameId,
            conversation,
            context.actor.id,
            `要求补充本回合整份政策：${input.reason}\n\n请统一修改并整份重新提交。`,
          ],
        );
      }
    });
    return this.get(
      key.gameId,
      userId,
      key.quarterId,
      key.memberId,
      key.countryId,
    );
  }
}
