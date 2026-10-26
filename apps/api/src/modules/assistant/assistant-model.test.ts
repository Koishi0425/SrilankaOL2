import { describe, expect, it, vi } from 'vitest';
import { loadServiceConfig } from '@srilanka/config';
import { createLogger } from '@srilanka/logger';
import {
  CompatibleAssistantModel,
  modelPrompt,
  parseModelAnswer,
  type ModelRequest,
} from './assistant-model.js';
import { assistantInputSchema } from './assistant-routes.js';

const request: ModelRequest = {
  purpose: 'Digest',
  length: 'Normal',
  sources: [
    { id: 'report', label: '回合公告', text: '修建港口未能完成，国库扣除20。' },
  ],
};
const answer = {
  overview: '港口未完成。',
  highlights: [{ text: '国库扣除20。', sourceIds: ['report'] }],
  notices: [],
  draft: null,
};
function transport(content = JSON.stringify(answer), finishReason = 'stop') {
  return vi.fn<typeof fetch>().mockResolvedValue(
    new Response(
      JSON.stringify({
        choices: [
          {
            finish_reason: finishReason,
            message: { content, reasoning_content: '不返回内部推理' },
          },
        ],
      }),
    ),
  );
}
function configuration(provider: 'deepseek' | 'glm' = 'deepseek') {
  return loadServiceConfig({
    LLM_PROVIDER: provider,
    LLM_API_KEY: 'test-key-private',
    LLM_MODEL: 'test-model',
  }).llm;
}

describe('model adapter and bounded output', () => {
  it('redacts model credentials from configuration logs', () => {
    const lines: string[] = [];
    const logger = createLogger('info', {
      write: (line: string) => {
        lines.push(line);
      },
    });
    logger.info(
      {
        llm: { apiKey: 'nested-private-key' },
        apiKey: 'top-private-key',
        LLM_API_KEY: 'environment-private-key',
      },
      'Configuration',
    );
    const output = lines.join('');
    expect(output).toContain('[REDACTED]');
    expect(output).not.toContain('private-key');
  });
  it.each(['deepseek', 'glm'] as const)(
    'sends the %s wire format, bounded tokens and data separate from instructions',
    async (provider) => {
      const fetcher = transport();
      const model = new CompatibleAssistantModel(
        configuration(provider),
        fetcher,
      );
      expect(await model.generate(request)).toEqual(answer);
      const [url, options] = fetcher.mock.calls[0]!;
      expect(String(url)).toBe(
        provider === 'glm'
          ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions'
          : 'https://api.deepseek.com/chat/completions',
      );
      expect(options!.redirect).toBe('error');
      expect(options!.headers).toMatchObject({
        Authorization: 'Bearer test-key-private',
      });
      const body = JSON.parse(String(options!.body));
      expect(body).toMatchObject({
        stream: false,
        max_tokens: 3000,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      });
      expect(body.messages[0].content).not.toContain(request.sources[0]!.text);
      expect(body.messages[1].content).toBe(
        JSON.stringify({ sources: request.sources }),
      );
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('allows formatted JSON but rejects fake references, oversized content and unexpected drafts', () => {
    expect(
      parseModelAnswer(
        `\`\`\`json\n${JSON.stringify(answer)}\n\`\`\``,
        request,
      ),
    ).toEqual(answer);
    for (const value of [
      { ...answer, highlights: [{ text: '虚构', sourceIds: ['secret'] }] },
      { ...answer, draft: '未经允许的建议' },
      { ...answer, overview: '长'.repeat(1201) },
      { ...answer, command: 'publish' },
    ])
      expect(() => parseModelAnswer(JSON.stringify(value), request)).toThrow();
  });
  it('does not truncate a long but valid answer to the soft target', () => {
    const expanded = {
      ...answer,
      highlights: [{ text: '叙'.repeat(850), sourceIds: ['report'] }],
    };
    expect(parseModelAnswer(JSON.stringify(expanded), request)).toEqual(
      expanded,
    );
  });
  it('accepts categorized factual highlights and sends game context and verified totals as data', async () => {
    const structured = {
      ...answer,
      highlights: [
        {
          title: '港口工程',
          category: 'Pending',
          text: '港口尚未完成。',
          sourceIds: ['report'],
        },
      ],
    };
    const fetcher = transport(JSON.stringify(structured));
    const context = {
      gameName: '测试剧本',
      quarter: '第1年春季',
      audience: '玩家：仅本国已发布结果',
    };
    const totals = [
      { countryName: '河国', resource: 'Treasury' as const, amount: -20 },
    ];
    expect(
      await new CompatibleAssistantModel(configuration(), fetcher).generate({
        ...request,
        context,
        resourceTotals: totals,
      }),
    ).toEqual(structured);
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      context,
      confirmedResourceTotals: totals,
    });
    expect(body.messages[0].content).toContain('同一事件只归纳一次');
    expect(() =>
      parseModelAnswer(
        JSON.stringify({
          ...structured,
          highlights: [{ ...structured.highlights[0], category: 'Strategy' }],
        }),
        request,
      ),
    ).toThrow();
  });
  it('allows a feedback conflict to withhold the draft', () => {
    const feedback = { ...request, purpose: 'Feedback' as const };
    expect(
      parseModelAnswer(
        JSON.stringify({ ...answer, notices: ['裁定和已保存计划不一致。'] }),
        feedback,
      ).draft,
    ).toBeNull();
    expect(() => parseModelAnswer(JSON.stringify(answer), feedback)).toThrow();
  });
  it.each(['length', 'content_filter', 'tool_calls'])(
    'rejects unfinished or nontext response %s without retrying',
    async (reason) => {
      const fetcher = transport(JSON.stringify(answer), reason);
      await expect(
        new CompatibleAssistantModel(configuration(), fetcher).generate(
          request,
        ),
      ).rejects.toMatchObject({ code: 'ASSISTANT_INVALID_OUTPUT' });
      expect(fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it('does not echo upstream secrets or error messages', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response('test-key-private and private policy', { status: 401 }),
      );
    await expect(
      new CompatibleAssistantModel(configuration(), fetcher).generate(request),
    ).rejects.toMatchObject({
      message: '模型服务鉴权失败，请维护者检查密钥和模型权限。',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('times out connection attempts and bounds provider bytes', async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options!.signal!.addEventListener('abort', () =>
            reject(new Error('private provider data')),
          );
        }),
    );
    await expect(
      new CompatibleAssistantModel(
        { ...configuration(), timeoutMs: 5 },
        fetcher,
      ).generate(request),
    ).rejects.toMatchObject({
      code: 'ASSISTANT_UNAVAILABLE',
      message: expect.stringContaining('超时'),
    });
    const huge = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response('x'.repeat(256_001)));
    await expect(
      new CompatibleAssistantModel(configuration(), huge).generate(request),
    ).rejects.toMatchObject({ code: 'ASSISTANT_INVALID_OUTPUT' });
  });
  it('uses role-specific factual instructions and never sends vendor fields to generic services', async () => {
    expect(modelPrompt(request)).toContain('不提出策略');
    expect(modelPrompt({ ...request, purpose: 'Feedback' })).toContain(
      '主持人本次裁定',
    );
    const fetcher = transport();
    await new CompatibleAssistantModel(
      {
        ...configuration(),
        provider: 'compatible',
        disableThinking: true,
        jsonMode: false,
      },
      fetcher,
    ).generate({ ...request, length: 'Detailed' });
    const body = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
    expect(body).not.toHaveProperty('thinking');
    expect(body).not.toHaveProperty('response_format');
    expect(body.max_tokens).toBe(4800);
  });
  it('rejects raw prompts, missing rulings and wrong-purpose input at the API boundary', () => {
    const input = {
      purpose: 'Digest',
      quarterId: crypto.randomUUID(),
      expectedVersion: 1,
      expectedCorrectionVersion: 0,
    };
    expect(assistantInputSchema.safeParse(input).success).toBe(true);
    expect(
      assistantInputSchema.safeParse({ ...input, sources: request.sources })
        .success,
    ).toBe(false);
    expect(
      assistantInputSchema.safeParse({ ...input, ruling: '玩家伪造裁定' })
        .success,
    ).toBe(false);
    expect(
      assistantInputSchema.safeParse({ ...input, purpose: 'Feedback' }).success,
    ).toBe(false);
  });
});
