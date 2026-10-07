/**
 * The invite redemption lock under true concurrency, against a real PostgreSQL.
 *
 * `tests/invite-store.test.ts` runs on PGlite with a single connection, which
 * serializes transactions client-side: a test there cannot tell whether the
 * invite row lock is held across the `shouldClaim` I/O. This file is the
 * regression test for that: the fix resolves `shouldClaim` (a read on the
 * shared pool) *before* the transaction that locks the invite row, so a slow
 * status read no longer holds the row lock across a network round trip.
 *
 * The test skips itself when no PostgreSQL answers at `PG_TEST_URL`
 * (default `postgresql://postgres:***@localhost:5432/postgres`), so CI
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
import { createInviteStore, type InviteStore } from '../src/db/invites';
import * as schema from '../src/db/schema';
import { stripMetaCommands } from './support/pglite';

const PG_URL =
  process.env['PG_TEST_URL'] ?? 'postgresql://postgres:***@localhost:5432/postgres';
const DB_NAME = `susu_invite_race_${process.pid}`;
const USER_ONE = '11111111-1111-1111-1111-111111111111';
const GROUP_CONTRACT_ID = `C${'A'.repeat(55)}`;
const CODE = `invitecode000001${'x'.repeat(24)}`;

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
let store: InviteStore | undefined;

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
    await client.query('insert into auth.users (id) values ($1)', [USER_ONE]);
  } finally {
    client.release();
  }

  store = createInviteStore(drizzle(pool, { schema }));
}, 60_000);

afterAll(async () => {
  if (!pgAvailable) return;
  await pool?.end();
  await adminPool?.query(`DROP DATABASE IF EXISTS "${DB_NAME}"`);
  await adminPool?.end();
});

describe.skipIf(!pgAvailable)('invite redemption lock under true PostgreSQL concurrency', () => {
  it('does not hold the invite row lock while the status read is in flight', async () => {
    if (!store || !pool) throw new Error('test setup failed');
    const dbPool = pool;

    const invite = await store.create({
      code: CODE,
      groupContractId: GROUP_CONTRACT_ID,
      createdBy: USER_ONE,
      expiresAt: null,
      maxUses: 5,
    });

    // A `shouldClaim` that sleeps, standing in for a slow `groupStatus` read on
    // the shared pool. The signal lets the assertion run while the read is
    // definitely in flight, rather than racing a fixed timer.
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const slowClaim = async () => {
      markStarted();
      await dbPool.query('select pg_sleep(1)');
      return true;
    };

    const pending = store.redeem({ code: invite.code, userId: USER_ONE, shouldClaim: slowClaim });
    await started;

    // While the status read is in flight, a separate session must be able to
    // lock the invite row. A short `lock_timeout` turns "blocked on the row
    // lock" (the bug) into a thrown error instead of a slow pass.
    const client = await dbPool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '300ms'");
      await client.query('SELECT id FROM invite_links WHERE code = $1 FOR UPDATE', [invite.code]);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    const outcome = await pending;
    expect(outcome).toEqual({
      outcome: 'redeemed',
      inviteId: invite.id,
      groupContractId: GROUP_CONTRACT_ID,
      claimed: true,
    });
  });
});
