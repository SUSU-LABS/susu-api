/**
 * The registration cap under true concurrency, against a real PostgreSQL.
 *
 * `tests/registrations.test.ts` runs on PGlite with a single connection, which
 * serializes transactions client-side: its parallel-registrations test passes
 * whether or not the store actually serializes anything. This file is the
 * regression test for the phantom-read the row locks cannot stop — two
 * concurrent transactions that both observe MAX - 1 live rows and both
 * insert. It needs two real sessions, so it needs a real server.
 *
 * The test skips itself when no PostgreSQL answers at `PG_TEST_URL`
 * (default `postgresql://postgres:ecosdemo@localhost:5432/postgres`), so CI
 * without a database stays green and the PGlite suite remains the portable
 * one. Each run migrates a scratch database named for its own pid, so
 * parallel runs never share state.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createRegistrationStore,
  MAX_LIVE_REGISTRATIONS,
  type RegistrationStore,
} from '../src/db/registrations';
import * as schema from '../src/db/schema';
import { stripMetaCommands } from './support/pglite';

const PG_URL =
  process.env['PG_TEST_URL'] ?? 'postgresql://postgres:ecosdemo@localhost:5432/postgres';
const DB_NAME = `susu_reg_race_${process.pid}`;
const USER_ONE = '11111111-1111-1111-1111-111111111111';
const USER_TWO = '22222222-2222-2222-2222-222222222222';

const repoRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/** Same list as `tests/support/pglite.ts`: adding a migration there without adding it here is a bug. */
const MIGRATIONS = [
  'drizzle/0000_profiles.sql',
  'drizzle/0001_invites_and_linking.sql',
  'drizzle/0002_nonces_and_redemptions.sql',
  'drizzle/0003_group_registrations.sql',
  'drizzle/0004_profile_images.sql',
  'drizzle/0005_notification_sources.sql',
  'drizzle/0006_notification_schedule.sql',
  'drizzle/0007_notification_order.sql',
] as const;

function distinctContractId(index: number): string {
  return `C${String.fromCharCode(68 + index)}${'A'.repeat(54)}`;
}

async function serverAvailable(): Promise<boolean> {
  const probe = new Pool({ connectionString: PG_URL, max: 1, connectionTimeoutMillis: 3000 });
  try {
    await probe.query('select 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end();
  }
}

// Evaluated at collection time: the suite below only exists when a server answers.
const pgAvailable = await serverAvailable();

let adminPool: Pool | undefined;
let pool: Pool | undefined;
let store: RegistrationStore | undefined;

beforeAll(async () => {
  if (!pgAvailable) return;
  adminPool = new Pool({ connectionString: PG_URL, max: 1 });
  await adminPool.query(`CREATE DATABASE "${DB_NAME}"`);

  const dbUrl = PG_URL.replace(/\/[^/]*$/, `/${DB_NAME}`);
  pool = new Pool({ connectionString: dbUrl, max: 5 });
  const client = await pool.connect();
  try {
    await client.query(stripMetaCommands(read('tests/db/bootstrap_supabase_shims.sql')));
    for (const migration of MIGRATIONS) {
      for (const statement of read(migration).split('--> statement-breakpoint')) {
        if (statement.trim().length > 0) await client.query(statement);
      }
    }
    await client.query('insert into auth.users (id) values ($1), ($2)', [USER_ONE, USER_TWO]);
  } finally {
    client.release();
  }

  store = createRegistrationStore(drizzle(pool, { schema }));
}, 60_000);

afterAll(async () => {
  if (!pgAvailable) return;
  await pool?.end();
  await adminPool?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await adminPool?.end();
});

describe.skipIf(!pgAvailable)('registration cap under true PostgreSQL concurrency', () => {
  it('two concurrent registrations at the cap yield exactly one success', async () => {
    const db = store;
    if (!db || !pool) throw new Error('test setup failed');

    for (let index = 0; index < MAX_LIVE_REGISTRATIONS - 1; index += 1) {
      const filled = await db.register({ contractId: distinctContractId(index), userId: USER_ONE });
      expect(filled.outcome).toBe('registered');
    }

    // Without per-account serialization both calls observe the same live
    // count (MAX - 1) and both insert, leaving MAX + 1 live claims. The two
    // transactions run on separate pool sessions here, so the race is real —
    // unlike the PGlite suite, where the single connection serializes them.
    const [first, second] = await Promise.all([
      db.register({ contractId: distinctContractId(10), userId: USER_ONE }),
      db.register({ contractId: distinctContractId(11), userId: USER_ONE }),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(['registered', 'too_many']);

    const { rows } = await pool.query(
      'select count(*)::int as live from public.group_registrations where registered_by = $1 and expires_at > now()',
      [USER_ONE],
    );
    expect(rows[0]?.['live']).toBe(MAX_LIVE_REGISTRATIONS);
  });

  it('a registration blocks while the account advisory lock is held elsewhere', async () => {
    const db = store;
    if (!db || !pool) throw new Error('test setup failed');

    // Hold the account's lock on a raw session, in an open transaction.
    const holder = await pool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT pg_advisory_xact_lock(hashtextextended('${USER_TWO}', 0))`);

      // The store must take the same lock inside its transaction, so this
      // registration cannot proceed until the holder rolls back. Without the
      // fix no lock is taken and the call settles immediately.
      let settled = false;
      const pending = db
        .register({ contractId: distinctContractId(20), userId: USER_TWO })
        .then((result) => {
          settled = true;
          return result;
        });

      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(settled).toBe(false);

      await holder.query('ROLLBACK');
      const result = await pending;
      expect(result.outcome).toBe('registered');
    } finally {
      holder.release();
    }
  });
});
