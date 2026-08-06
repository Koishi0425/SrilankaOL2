import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { App } from './App.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App', () => {
  it('shows dependency readiness from the API envelope', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          data: {
            status: 'ok',
            service: 'api',
            version: '0.0.0',
            dependencies: { database: 'up', redis: 'up' },
          },
          meta: { requestId: 'req_web_test' },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );

    render(<App />);

    expect(await screen.findByText('PostgreSQL')).toBeInTheDocument();
    expect(screen.getByText('追踪 ID：req_web_test')).toBeInTheDocument();
    expect(screen.getAllByText('正常')).toHaveLength(3);
  });
});
