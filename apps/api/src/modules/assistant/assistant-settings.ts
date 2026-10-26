import type { ServiceConfig } from '@srilanka/config';
import type {
  GlobalAssistantSettings,
  SaveGlobalAssistantSettings,
} from '@srilanka/contracts';
import type { DatabasePool } from '@srilanka/database';
import { z } from 'zod';
import { ApiFault } from '../../errors.js';
import {
  CompatibleAssistantModel,
  type AssistantModel,
} from './assistant-model.js';
import type { AssistantSecrets } from './assistant-secrets.js';

export function normalizeAssistantUrl(value: string): string {
  const url = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error('Invalid service URL');
  url.pathname = url.pathname
    .replace(/\/+$/u, '')
    .replace(/\/chat\/completions$/u, '');
  return url.toString().replace(/\/+$/u, '');
}

export const globalAssistantInputSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    enabled: z.boolean(),
    provider: z.enum(['deepseek', 'glm', 'compatible']),
    baseUrl: z
      .string()
      .trim()
      .min(1)
      .max(2048)
      .transform((value, ctx) => {
        try {
          return normalizeAssistantUrl(value);
        } catch {
          ctx.addIssue({
            code: 'custom',
            message:
              '请填写有效的 HTTP/HTTPS 地址，不包含账号、密钥、查询参数或片段。',
          });
          return z.NEVER;
        }
      }),
    model: z.string().trim().min(1).max(160),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(8192)
      .regex(/^[^\s\p{Cc}]+$/u)
      .optional(),
    jsonMode: z.boolean(),
    disableThinking: z.boolean(),
    timeoutMs: z.number().int().min(1000).max(120000),
  })
  .strict();

interface SettingsRow {
  enabled: boolean;
  provider: ServiceConfig['llm']['provider'];
  base_url: string;
  model: string;
  api_key_ciphertext: string;
  json_mode: boolean;
  disable_thinking: boolean;
  timeout_ms: number;
  revision: number;
  updated_at: Date;
}

export interface AssistantRuntime {
  model: AssistantModel;
  globalEnabled: boolean | null;
  revision: number;
  modelName: string;
}

export class AssistantSettingsService {
  constructor(
    private readonly database: DatabasePool,
    private readonly secrets: AssistantSecrets,
    private readonly fallback: ServiceConfig['llm'],
    private readonly transport: typeof fetch = fetch,
  ) {}

  private async requireAdministrator(userId: string) {
    const result = await this.database.query(
      "SELECT 1 FROM users WHERE id=$1 AND status='Active' AND system_role='Administrator'",
      [userId],
    );
    if (!result.rowCount)
      throw new ApiFault(
        403,
        'ADMINISTRATOR_REQUIRED',
        '全局 AI 设置仅系统管理员可管理。',
      );
  }

  private async row(): Promise<SettingsRow | undefined> {
    return (
      await this.database.query<SettingsRow>(
        'SELECT * FROM assistant_global_settings WHERE id=1',
      )
    ).rows[0];
  }

  private async configuration(
    row?: SettingsRow,
  ): Promise<ServiceConfig['llm']> {
    if (!row) return this.fallback;
    return {
      provider: row.provider,
      baseUrl: row.base_url,
      model: row.model,
      apiKey: await this.secrets.decrypt(row.api_key_ciphertext),
      jsonMode: row.json_mode,
      disableThinking: row.disable_thinking,
      timeoutMs: row.timeout_ms,
    };
  }

  async runtime(): Promise<AssistantRuntime> {
    const row = await this.row();
    let config: ServiceConfig['llm'];
    try {
      config = await this.configuration(row);
    } catch (error) {
      if (
        !(error instanceof ApiFault) ||
        error.code !== 'ASSISTANT_SECRET_UNAVAILABLE'
      )
        throw error;
      config = {
        ...this.fallback,
        provider: row?.provider ?? this.fallback.provider,
        baseUrl: row?.base_url ?? this.fallback.baseUrl,
        apiKey: '',
        model: row?.model ?? '',
      };
    }
    return {
      model: new CompatibleAssistantModel(config, this.transport),
      globalEnabled: row?.enabled ?? null,
      revision: row?.revision ?? 0,
      modelName: row?.model ?? this.fallback.model,
    };
  }

  async get(userId: string): Promise<GlobalAssistantSettings> {
    await this.requireAdministrator(userId);
    const row = await this.row();
    let configured = false;
    try {
      const config = await this.configuration(row);
      configured = Boolean(config.apiKey && config.model && config.baseUrl);
    } catch {
      /* The administrator can replace an unreadable saved credential. */
    }
    return {
      revision: row?.revision ?? 0,
      enabled: row?.enabled ?? true,
      configured,
      provider: row?.provider ?? this.fallback.provider,
      baseUrl: row?.base_url ?? this.fallback.baseUrl,
      model: row?.model ?? this.fallback.model,
      hasApiKey: Boolean(row?.api_key_ciphertext || this.fallback.apiKey),
      jsonMode: row?.json_mode ?? this.fallback.jsonMode,
      disableThinking: row?.disable_thinking ?? this.fallback.disableThinking,
      timeoutMs: row?.timeout_ms ?? this.fallback.timeoutMs,
      source: row ? 'Database' : 'Environment',
      updatedAt: row?.updated_at.toISOString() ?? null,
    };
  }

  async save(
    userId: string,
    input: SaveGlobalAssistantSettings,
  ): Promise<GlobalAssistantSettings> {
    const client = await this.database.connect();
    try {
      await client.query('BEGIN');
      const administrator = await client.query(
        "SELECT 1 FROM users WHERE id=$1 AND status='Active' AND system_role='Administrator' FOR UPDATE",
        [userId],
      );
      if (!administrator.rowCount)
        throw new ApiFault(
          403,
          'ADMINISTRATOR_REQUIRED',
          '全局 AI 设置仅系统管理员可管理。',
        );
      await client.query('SELECT pg_advisory_xact_lock($1)', [1936445702]);
      const previous = (
        await client.query<SettingsRow>(
          'SELECT * FROM assistant_global_settings WHERE id=1 FOR UPDATE',
        )
      ).rows[0];
      if ((previous?.revision ?? 0) !== input.expectedRevision)
        throw new ApiFault(
          409,
          'ASSISTANT_SETTINGS_CHANGED',
          '全局 AI 配置已被更新，请重新读取后再保存。',
        );
      const oldUrl = previous?.base_url ?? this.fallback.baseUrl;
      const oldProvider = previous?.provider ?? this.fallback.provider;
      if (
        !input.apiKey &&
        (oldUrl !== input.baseUrl || oldProvider !== input.provider)
      )
        throw new ApiFault(
          400,
          'ASSISTANT_KEY_REQUIRED',
          '更换服务地址或提供商时，请重新填写 API Key。',
        );
      const ciphertext = input.apiKey
        ? await this.secrets.encrypt(input.apiKey)
        : (previous?.api_key_ciphertext ??
          (this.fallback.apiKey
            ? await this.secrets.encrypt(this.fallback.apiKey)
            : ''));
      if (!ciphertext)
        throw new ApiFault(400, 'ASSISTANT_KEY_REQUIRED', '请填写 API Key。');
      if (input.enabled) await this.secrets.decrypt(ciphertext);
      await client.query(
        `INSERT INTO assistant_global_settings
        (id,enabled,provider,base_url,model,api_key_ciphertext,json_mode,disable_thinking,timeout_ms,revision,updated_by)
        VALUES (1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET enabled=EXCLUDED.enabled,provider=EXCLUDED.provider,base_url=EXCLUDED.base_url,
        model=EXCLUDED.model,api_key_ciphertext=EXCLUDED.api_key_ciphertext,json_mode=EXCLUDED.json_mode,
        disable_thinking=EXCLUDED.disable_thinking,timeout_ms=EXCLUDED.timeout_ms,revision=EXCLUDED.revision,
        updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [
          input.enabled,
          input.provider,
          input.baseUrl,
          input.model,
          ciphertext,
          input.jsonMode,
          input.disableThinking,
          input.timeoutMs,
          input.expectedRevision + 1,
          userId,
        ],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return this.get(userId);
  }

  async test(userId: string) {
    await this.requireAdministrator(userId);
    const row = await this.row();
    const config = await this.configuration(row);
    const model = new CompatibleAssistantModel(config, this.transport);
    const start = Date.now();
    await model.generate({
      purpose: 'Digest',
      length: 'Brief',
      sources: [
        {
          id: 'connection-test',
          label: '连接测试',
          text: 'AI 服务连接测试已完成。这是测试资料，不包含任何游戏信息。',
        },
      ],
    });
    return {
      provider: model.provider,
      model: config.model,
      latencyMs: Date.now() - start,
    };
  }
}
