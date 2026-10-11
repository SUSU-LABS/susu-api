import { afterEach, describe, expect, it, vi } from 'vitest';
import { configureTestEnv } from './support/fixtures';
import { buildServer } from '../src/server';
import * as database from '../src/db/client';

configureTestEnv();

afterEach(async () => {
  vi.restoreAllMocks();
  await database.closeDb();
});

describe('database shutdown lifecycle', () => {
  it('ends the database pool when the server closes', async () => {
    const app = await buildServer({ probeDatabase: async () => {} });
    const pool = database.getPool();
    await app.ready();
    expect(pool.ended).toBe(false);
    await app.close();
    expect(pool.ended).toBe(true);
  });

  it('waits for database shutdown before resolving app.close', async () => {
    const app = await buildServer({ probeDatabase: async () => {} });
    await app.ready();
    const originalClose = database.closeDb;
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = vi.spyOn(database, 'closeDb').mockImplementation(async () => {
      await pending;
      await originalClose();
    });
    let finished = false;
    const closing = app.close().then(() => {
      finished = true;
    });
    try {
      await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
      expect(finished).toBe(false);
    } finally {
      release();
      await closing;
    }
    expect(finished).toBe(true);
  });

  it('closes a shared pool only once when servers shut down together', async () => {
    const first = await buildServer({ probeDatabase: async () => {} });
    const second = await buildServer({ probeDatabase: async () => {} });
    await Promise.all([first.ready(), second.ready()]);
    const pool = database.getPool();
    const end = vi.spyOn(pool, 'end');
    await Promise.all([first.close(), second.close()]);
    expect(end).toHaveBeenCalledOnce();
    expect(pool.ended).toBe(true);
  });

  it('propagates database shutdown failure', async () => {
    const app = await buildServer({ probeDatabase: async () => {} });
    await app.ready();
    vi.spyOn(database, 'closeDb').mockRejectedValueOnce(new Error('pool shutdown failed'));
    await expect(app.close()).rejects.toThrow('pool shutdown failed');
  });
});
