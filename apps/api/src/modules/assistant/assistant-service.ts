import { createHash } from 'node:crypto';
import type {
  AssistantInput,
  AssistantResult,
  AssistantSource,
  AssistantStatus,
  CountryResource,
  GameRole,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';
import { ApiFault } from '../../errors.js';
import type { GameService } from '../games/game-service.js';
import type { SettlementService } from '../settlements/settlement-service.js';
import type { AssistantModel, ModelRequest } from './assistant-model.js';

const hash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
const hostRole = (role: GameRole) =>
  role === 'Host' || role === 'Administrator';

export class AssistantService {
  private readonly running = new Set<string>();
  constructor(
    private readonly database: DatabasePool,
    private readonly games: GameService,
    private readonly settlements: SettlementService,
    private readonly model: AssistantModel,
  ) {}

  async status(gameId: string, userId: string): Promise<AssistantStatus> {
    const game = await this.games.getForUser(gameId, userId);
    return {
      configured: this.model.configured,
      enabled: game.aiEnabled,
      canManage:
        hostRole(game.role) && !['Archived', 'Completed'].includes(game.status),
      provider: this.model.provider,
    };
  }

  async configure(
    gameId: string,
    userId: string,
    enabled: boolean,
    expectedEnabled: boolean,
  ) {
    const status = await this.status(gameId, userId);
    if (!status.canManage)
      throw new ApiFault(
        403,
        'HOST_PERMISSION_REQUIRED',
        '该操作需要活动游戏的主持人权限。',
      );
    if (enabled && !status.configured)
      throw new ApiFault(
        503,
        'ASSISTANT_NOT_CONFIGURED',
        '模型服务尚未配置，请维护者设置服务端环境变量。',
      );
    const result = await this.database.query(
      `UPDATE games g SET ai_enabled=$3 WHERE g.id=$1 AND g.ai_enabled=$4
       AND g.status NOT IN ('Archived','Completed') AND EXISTS (
         SELECT 1 FROM game_members gm WHERE gm.game_id=g.id AND gm.user_id=$2
         AND gm.status='Active' AND gm.role IN ('Host','Administrator')) RETURNING g.id`,
      [gameId, userId, enabled, expectedEnabled],
    );
    if (!result.rowCount)
      throw new ApiFault(
        409,
        'ASSISTANT_SETTINGS_CHANGED',
        '设置或权限已变化，请重新读取。',
      );
    return this.status(gameId, userId);
  }

  private async context(gameId: string, userId: string, input: AssistantInput) {
    const game = await this.games.getForUser(gameId, userId);
    if (!game.aiEnabled)
      throw new ApiFault(
        409,
        'ASSISTANT_DISABLED',
        '主持人尚未开启本局的模型辅助。',
      );
    if (!this.model.configured)
      throw new ApiFault(
        503,
        'ASSISTANT_NOT_CONFIGURED',
        '模型服务尚未配置，请联系维护者。',
      );
    if (input.purpose === 'Feedback' && !hostRole(game.role))
      throw new ApiFault(
        403,
        'HOST_PERMISSION_REQUIRED',
        '起草反馈需要主持人权限。',
      );
    const initialAudience = (
      await this.database.query<{
        role: GameRole;
        controlled_country_id: string | null;
      }>(
        "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
        [gameId, userId],
      )
    ).rows[0];
    if (!initialAudience || initialAudience.role !== game.role)
      throw new ApiFault(
        409,
        'ASSISTANT_CONTEXT_CHANGED',
        '权限已变化，请刷新后生成。',
      );
    // This service already projects publication state, country permissions and corrections.
    // Never read a full host snapshot then try to hide its fields in the model prompt.
    const data = await this.settlements.get(gameId, userId, input.quarterId);
    if (input.purpose === 'Digest' && !data.publishedAt)
      throw new ApiFault(
        409,
        'SETTLEMENT_NOT_PUBLISHED',
        '发布结算后才能生成速览。',
      );
    if (
      data.version !== input.expectedVersion ||
      (data.corrections?.length ?? 0) !== input.expectedCorrectionVersion
    )
      throw new ApiFault(
        409,
        'ASSISTANT_CONTEXT_CHANGED',
        '结算已有更新，请刷新后生成。',
      );
    const sources: AssistantSource[] = [];
    const resourceTotals: AssistantResult['resourceTotals'] = [];
    const add = (id: string, label: string, text: string) => {
      if (text.trim()) sources.push({ id, label, text });
    };
    if (input.purpose === 'Digest') {
      add('report', '已发布的回合公告', data.publicReport);
      for (const action of data.actions) {
        // Intent/submittedText is intentionally excluded from a results-only digest.
        add(
          `action:${action.actionId}`,
          `${action.countryName} · ${action.title}`,
          [
            action.status === 'Rejected' ? '该政策被拒绝。' : '',
            action.reviewReason ? `审核意见：${action.reviewReason}` : '',
            action.feedback ? `已发布反馈：${action.feedback}` : '',
          ]
            .filter(Boolean)
            .join('\n'),
        );
      }
      const knowledgeNames = {
        Unknown: '未知',
        Rumored: '传闻',
        Discovered: '已发现',
        Mapped: '已测绘',
        Observed: '正在观察',
        Outdated: '过时信息',
      };
      for (const reveal of data.mapReveals ?? [])
        add(
          `reveal:${reveal.actionId}`,
          `已发布探索记录（${knowledgeNames[reveal.state]}）`,
          `信息性质：${knowledgeNames[reveal.state]}。${reveal.note}`,
        );
      const seasonNames = {
        Spring: '春季',
        Summer: '夏季',
        Autumn: '秋季',
        Winter: '冬季',
      };
      for (const correction of data.corrections ?? []) {
        const change = correction.change;
        const appliedAt = `第${correction.appliedQuarter.gameYear}年${seasonNames[correction.appliedQuarter.season]}`;
        if (change.kind === 'Resource')
          add(
            `correction:${correction.id}`,
            '已执行的资源更正通知',
            `${change.countryName} ${change.resource === 'Treasury' ? '国库' : '人力'}更正 ${change.amount}，在${appliedAt}入账。更正通知与实际账目是同一笔变化，不能重复累计。原因：${correction.reason}`,
          );
        if (change.kind === 'ArmyStrength')
          add(
            `correction:${correction.id}`,
            '已执行的部队更正通知',
            `${change.countryName} ${change.armyName}兵力由${change.before}更正为${change.after}，执行时间为${appliedAt}。原因：${correction.reason}`,
          );
      }
      // Own actual ledger only; no draft costs, current balances, map truth or foreign ledgers.
      // Host access is explicit and observers receive no national ledger rows.
      const ledger = await this.database.query<{
        id: string;
        country_name: string;
        country_id: string;
        resource: CountryResource;
        amount: string;
        reason: string;
        kind: string;
      }>(
        `SELECT l.id,l.country_id,c.name AS country_name,l.resource,l.amount,l.reason,l.kind
         FROM country_resource_ledger l JOIN countries c ON c.id=l.country_id AND c.game_id=l.game_id
         JOIN game_members gm ON gm.game_id=l.game_id AND gm.user_id=$2 AND gm.status='Active'
         WHERE l.game_id=$1 AND l.quarter_id=$3 AND l.kind IN ('Settlement','Correction')
         AND (gm.role IN ('Host','Administrator') OR (gm.role='Player' AND gm.controlled_country_id=l.country_id))
         ORDER BY l.id LIMIT 1001`,
        [gameId, userId, input.quarterId],
      );
      if (ledger.rows.length > 1000)
        throw new ApiFault(
          400,
          'ASSISTANT_CONTEXT_TOO_LARGE',
          '本回合账目过多，请直接查看结算原文和账目。',
        );
      const totals = new Map<
        string,
        AssistantResult['resourceTotals'][number]
      >();
      for (const row of ledger.rows) {
        add(
          `ledger:${row.id}`,
          `${row.country_name} · ${row.kind === 'Correction' ? '更正账目' : '正式账目'}`,
          `${row.resource === 'Treasury' ? '国库' : '人力'}变化 ${row.amount}；${row.reason}`,
        );
        const key = `${row.country_id}:${row.resource}`;
        const total = totals.get(key) ?? {
          countryName: row.country_name,
          resource: row.resource,
          amount: 0,
        };
        total.amount =
          Math.round((total.amount + Number(row.amount)) * 100) / 100;
        totals.set(key, total);
      }
      resourceTotals.push(...totals.values());
    } else {
      if (
        ['Completed', 'Archived'].includes(game.status) ||
        !data.isCurrent ||
        data.publishedAt ||
        data.quarter.state !== 'Resolving'
      )
        throw new ApiFault(
          409,
          'SETTLEMENT_LOCKED',
          '请在当前回合的结算草稿中起草反馈。',
        );
      const action = data.actions.find(
        (item) => item.actionId === input.actionId,
      );
      if (!action)
        throw new ApiFault(404, 'OBJECT_NOT_FOUND', '未找到这份结算政策。');
      if (!input.ruling?.trim())
        throw new ApiFault(
          400,
          'ASSISTANT_RULING_REQUIRED',
          '请先填写主持人已经决定的结果。',
        );
      add('ruling', '主持人本次裁定（结果依据）', input.ruling.trim());
      add(
        'policy',
        `${action.countryName} · ${action.title}（仅为玩家意图）`,
        action.submittedText,
      );
      add(
        'review',
        '审核意见',
        `${action.status === 'Rejected' ? '政策被拒绝。' : ''}${action.reviewReason}`,
      );
      const related = <T extends { actionId: string | null }>(
        items: T[] | undefined,
      ) => (items ?? []).filter((item) => item.actionId === action.actionId);
      const planLines = [
        ...related(data.resourceChanges).map(
          (item) =>
            `${item.countryName} ${item.resource === 'Treasury' ? '国库' : '人力'} ${item.amount}：${item.reason}`,
        ),
        ...related(data.stateChanges).map((item) => item.summary),
        ...related(data.recruitments).map((item) => item.summary),
        ...related(data.diplomacyChanges).map((item) => item.summary),
        ...related(data.governmentChanges).map((item) => item.summary),
        ...related(data.battles).flatMap((item) => [
          item.title,
          ...item.effects.map((effect) => effect.summary),
        ]),
        ...(data.mapReveals ?? [])
          .filter((item) => item.actionId === action.actionId)
          .map((item) => item.note),
      ];
      add(
        'plans',
        '与该政策关联的已保存计划（尚未发布，冲突须指出）',
        planLines.join('\n'),
      );
    }
    if (!sources.length)
      throw new ApiFault(
        400,
        'ASSISTANT_NO_CONTENT',
        '本回合尚无可归纳的已发布内容。',
      );
    if (JSON.stringify(sources).length > 100_000)
      throw new ApiFault(
        400,
        'ASSISTANT_CONTEXT_TOO_LARGE',
        '本回合文字过多，请直接查看结算原文；没有截断原文生成摘要。',
      );
    const finalAudience = (
      await this.database.query(
        "SELECT role,controlled_country_id FROM game_members WHERE game_id=$1 AND user_id=$2 AND status='Active'",
        [gameId, userId],
      )
    ).rows[0];
    if (hash(initialAudience) !== hash(finalAudience))
      throw new ApiFault(
        409,
        'ASSISTANT_CONTEXT_CHANGED',
        '权限已变化，请刷新后生成。',
      );
    return {
      sources,
      resourceTotals,
      fingerprint: hash([
        initialAudience,
        data.version,
        data.corrections,
        sources,
      ]),
    };
  }

  private async quota(scope: string, max: number, seconds: number) {
    const rows = await this.database.query<{
      attempts: number;
      expires_at: Date;
    }>(
      `INSERT INTO auth_rate_limits (bucket,attempts,expires_at) VALUES ($1,1,NOW()+$2*INTERVAL '1 second')
       ON CONFLICT (bucket) DO UPDATE SET attempts=CASE WHEN auth_rate_limits.expires_at<=NOW() THEN 1 ELSE auth_rate_limits.attempts+1 END,
       expires_at=CASE WHEN auth_rate_limits.expires_at<=NOW() THEN EXCLUDED.expires_at ELSE auth_rate_limits.expires_at END RETURNING attempts,expires_at`,
      [hash(['assistant', scope]), seconds],
    );
    if (rows.rows[0]!.attempts > max)
      throw new ApiFault(
        429,
        'ASSISTANT_RATE_LIMITED',
        '本时段生成次数已用完，请稍后再试。',
        {
          retryAfter: Math.max(
            1,
            Math.ceil((rows.rows[0]!.expires_at.getTime() - Date.now()) / 1000),
          ),
        },
      );
  }

  async generate(
    gameId: string,
    userId: string,
    input: AssistantInput,
  ): Promise<AssistantResult> {
    if (this.running.has(userId))
      throw new ApiFault(
        409,
        'ASSISTANT_ALREADY_RUNNING',
        '已有内容正在生成，请等待完成。',
      );
    if (this.running.size >= 3)
      throw new ApiFault(
        429,
        'ASSISTANT_BUSY',
        '当前生成请求较多，请稍后重试。',
        { retryAfter: 20 },
      );
    this.running.add(userId);
    try {
      const context = await this.context(gameId, userId, input);
      await this.quota(`user:${userId}`, 30, 3600);
      await this.quota(`game:${gameId}`, 300, 86400);
      const request: ModelRequest = {
        purpose: input.purpose,
        length: input.length,
        sources: context.sources,
      };
      const answer = await this.model.generate(request);
      // No database connection/transaction is held during network inference.
      const latest = await this.context(gameId, userId, input);
      if (latest.fingerprint !== context.fingerprint)
        throw new ApiFault(
          409,
          'ASSISTANT_CONTEXT_CHANGED',
          '生成期间结算内容或权限已变化，请刷新后生成。',
        );
      return {
        purpose: input.purpose,
        answer,
        sources: context.sources,
        resourceTotals: context.resourceTotals,
        generatedAt: new Date().toISOString(),
      };
    } finally {
      this.running.delete(userId);
    }
  }
}
