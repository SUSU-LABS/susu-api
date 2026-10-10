import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

let app: FastifyInstance;

beforeAll(async () => {
  const { buildServer } = await import('../src/server');
  // The readiness probe is injected so the suite does not need a database. The
  // real probe's failure path is covered explicitly below.
  app = await buildServer({ probeDatabase: async () => {} });
});

afterAll(async () => {
  await app?.close();
});

describe('health routes', () => {
  it('reports liveness', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('reports readiness with each check named', async () => {
    const response = await app.inject({ method: 'GET', url: '/ready' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: 'ready',
      checks: { config: 'ok', database: 'ok' },
    });
  });
});

describe('readiness when the database is unreachable', () => {
  it('reports unavailable without leaking the failure', async () => {
    const { buildServer } = await import('../src/server');
    const failing = await buildServer({
      probeDatabase: async () => {
        throw new Error('connection refused to postgresql://user:password@localhost:5432');
      },
    });

    try {
      const response = await failing.inject({ method: 'GET', url: '/ready' });

      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({
        status: 'unavailable',
        checks: { config: 'ok', database: 'unavailable' },
      });
      // The connection string must not reach the client, even inside an error.
      expect(response.body).not.toContain('password');
    } finally {
      await failing.close();
    }
  });
});

describe('unknown routes', () => {
  it('returns a generic 404 without internal detail', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/v1/does-not-exist' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'not_found' });
  });
});

describe('CORS allowlist', () => {
  it('allows a configured origin', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:5173' },
    });
    expect(response.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });

  it('does not allow an origin outside the allowlist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://evil.example.com' },
    });
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('response headers', () => {
  it('applies secure headers', async () => {
    const response = await app.inject({ method: 'GET', url: '/health' });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBeDefined();
  });
});

describe('expired wallet-link nonces', () => {
  /**
   * A nonce row is kept past its expiry on purpose, so a replay is refused as a
   * replay rather than as an unknown token. That means something has to remove
   * them, and for a while nothing did — `reap` was written, tested, and never
   * called, so the table grew by a row per abandoned link attempt with no bound.
   */
  it('are cleared on a timer', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => 3);
      const log = { info: vi.fn(), warn: vi.fn() };

      const timer = startNonceReaping({ reap }, log as never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(reap).toHaveBeenCalledTimes(1);
      expect(reap).toHaveBeenCalledWith(expect.any(Date));

      // Something was cleared, so it is worth a line in the log.
      expect(log.info).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'nonce_reap', count: 3 }),
        expect.any(String),
      );

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('survive a failing reap, which is logged rather than fatal', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => {
        throw new Error('database is unreachable');
      });
      const log = { info: vi.fn(), warn: vi.fn() };

      const timer = startNonceReaping({ reap }, log as never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(log.warn).toHaveBeenCalledWith(
        expect.objectContaining({ event: 'nonce_reap_failed' }),
        expect.any(String),
      );

      // An untidy table is not a reason to take the service down, so the next
      // tick tries again.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(reap).toHaveBeenCalledTimes(2);

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says nothing when there was nothing to clear', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => 0);
      const log = { info: vi.fn(), warn: vi.fn() };

      const timer = startNonceReaping({ reap }, log as never, 1_000);
      await vi.advanceTimersByTimeAsync(1_000);

      expect(reap).toHaveBeenCalledTimes(1);
      expect(log.info).not.toHaveBeenCalled();

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not start new reap work once closing has begun', async () => {
    const { startNonceReaping } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const reap = vi.fn(async () => 0);
      const log = { info: vi.fn(), warn: vi.fn() };
      let closing = false;

      const timer = startNonceReaping({ reap }, log as never, 1_000, () => closing);
      // Simulate close beginning before the next tick fires: a queued tick
      // must not start new work (clearInterval alone cannot stop it).
      closing = true;
      await vi.advanceTimersByTimeAsync(5_000);

      expect(reap).not.toHaveBeenCalled();

      clearInterval(timer);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('nonce-reaper server lifecycle', () => {
  it('clears the reaper interval when the server closes', async () => {
    const { buildServer } = await import('../src/server');

    // Do not inject a walletLinkStore so the reaper timer starts — the same
    // condition as "this is the real service".
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const server = await buildServer({ probeDatabase: async () => {} });

    await server.close();

    // The reaper's timer must have been cleared on close; otherwise a closed
    // server leaves a live interval that can lazily create a real DB pool and
    // query after close.
    expect(clearIntervalSpy).toHaveBeenCalled();

    clearIntervalSpy.mockRestore();
  });

  it('does not start the reaper when a store is injected', async () => {
    const { buildServer, REAP_INTERVAL_MS } = await import('../src/server');

    vi.useFakeTimers();
    try {
      const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
      const fakeStore = { reap: vi.fn(async () => 0) };

      const server = await buildServer({
        probeDatabase: async () => {},
        walletLinkStore: fakeStore as never,
      });

      try {
        // No reaper timer should have been created: a test that supplies a
        // store does not want a background timer. Filtered by the exported
        // interval constant rather than a magic number, so the assertion
        // tracks the implementation if the interval ever changes.
        const reaperCalls = setIntervalSpy.mock.calls.filter(([, ms]) => ms === REAP_INTERVAL_MS);
        expect(reaperCalls).toHaveLength(0);

        // Belt and braces: advancing past the reap interval must not invoke
        // reap on the injected store either.
        await vi.advanceTimersByTimeAsync(REAP_INTERVAL_MS + 1_000);
        expect(fakeStore.reap).not.toHaveBeenCalled();
      } finally {
        setIntervalSpy.mockRestore();
        await server.close();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops ticking after close', async () => {
    const { buildServer } = await import('../src/server');

    // Install fake timers before buildServer so the reaper interval is fake
    // and advancing time past it is observable.
    vi.useFakeTimers();
    try {
      const server = await buildServer({ probeDatabase: async () => {} });
      await server.close();

      // Advancing past the reap interval must not throw or schedule work:
      // the timer is gone.
      await vi.advanceTimersByTimeAsync(15 * 60 * 1000 + 1_000);
    } finally {
      vi.useRealTimers();
    }
  });
});
