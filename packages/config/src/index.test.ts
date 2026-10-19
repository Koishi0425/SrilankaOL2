import { describe, expect, it } from 'vitest';

import { loadServiceConfig } from './index.js';

describe('loadServiceConfig', () => {
  it('isolates test defaults from development defaults', () => {
    const config = loadServiceConfig({ NODE_ENV: 'test' });

    expect(config.databaseUrl).toContain('srilanka_test');
    expect(config.redisUrl.endsWith('/1')).toBe(true);
  });

  it('rejects invalid ports', () => {
    expect(() => loadServiceConfig({ PORT: '70000' })).toThrow();
  });
  it('keeps the model service optional and selects provider-specific endpoints', () => {
    expect(loadServiceConfig({}).llm.apiKey).toBe('');
    expect(loadServiceConfig({}).llm.model).toBe('');
    expect(loadServiceConfig({ LLM_PROVIDER: 'glm' }).llm.baseUrl).toBe(
      'https://open.bigmodel.cn/api/paas/v4',
    );
    expect(() => loadServiceConfig({ LLM_PROVIDER: 'compatible' })).toThrow();
    expect(() =>
      loadServiceConfig({
        LLM_BASE_URL: 'https://key:secret@example.org?key=hidden',
      }),
    ).toThrow();
    expect(() => loadServiceConfig({ LLM_TIMEOUT_MS: '0' })).toThrow();
  });
  it('closes registration by default in production and accepts explicit modes', () => {
    expect(loadServiceConfig({ NODE_ENV: 'production' }).registrationMode).toBe(
      'Closed',
    );
    expect(loadServiceConfig({ NODE_ENV: 'test' }).registrationMode).toBe(
      'Open',
    );
    expect(
      loadServiceConfig({ NODE_ENV: 'production', REGISTRATION_MODE: 'invite' })
        .registrationMode,
    ).toBe('InviteOnly');
    expect(() => loadServiceConfig({ REGISTRATION_MODE: 'unknown' })).toThrow();
  });
});
