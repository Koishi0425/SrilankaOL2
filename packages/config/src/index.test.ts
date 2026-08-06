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
});
