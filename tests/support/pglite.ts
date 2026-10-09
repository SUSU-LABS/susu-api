import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { drizzle } from 'drizzle-orm/pglite';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../../src/db/schema';

/**
 * A real Postgres, in process.
 *
 * The route tests inject a fake read model, which is the right seam for testing
 * HTTP behaviour and the wrong one for testing these models. The models are the
 * layer where a query is written, and the mistakes available there — forgetting
 * `where user_id`, dropping a `read_at is null` predicate, order-by without a
 * tiebreaker — produce code that runs cleanly and returns plausible wrong
 * answers. A fake database cannot see any of them, and this service's connection
 * runs as the table owner, so RLS is not a safety net underneath.
 *
 * PGlite is Postgres compiled to wasm, so the migrations under test are the
 * migrations that ship, parsed by the same server. It is in-process: no server to
 * start, no port to collide, works offline.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..');

/**
 * `psql` meta-commands, which PGlite does not implement.
 *
 * Only the shim file uses them (`\set ON_ERROR_STOP`); the migrations are plain
 * SQL. Exported so the guard tests, which run `tests/db/*.sql` files written for
 * `psql`, can drop the same lines rather than keeping a second copy of the rule.
 */
export function stripMetaCommands(sql: string): string {
  return sql
    .split('\n')
    .filter((line) => !/^\s*\\/.test(line))
    .join('\n');
}

function read(relativePath: string): string {
  return readFileSync(join(repoRoot, relativePath), 'utf8');
}

/**
 * The migrations, in order.
 *
 * Kept as a literal list rather than read from `drizzle/meta/_journal.json`, so
 * that adding a migration to the directory without adding it here is a failing
 * test rather than a silently thinner schema. The journal is checked separately
 * by `pnpm db:check` in CI.
 */
const MIGRATIONS = [
  'drizzle/0000_profiles.sql',
  'drizzle/0001_invites_and_linking.sql',
  'drizzle/0002_nonces_and_redemptions.sql',
  'drizzle/0003_group_registrations.sql',
  'drizzle/0004_profile_images.sql',
  'drizzle/0005_notification_sources.sql',
  'drizzle/0006_notification_schedule.sql',
  'drizzle/0007_notification_order.sql',
  'drizzle/0008_notification_tombstones.sql',
] as const;

export type TestDatabase = NodePgDatabase<typeof schema>;

export type TestDb = {
  /** The drizzle client, typed as the models expect. */
  db: TestDatabase;
  /** Escape hatch for arranging fixtures with raw SQL. */
  query: (sql: string, params?: readonly unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  /** Executes raw SQL for statements a prepared query cannot express. */
  exec: (sql: string) => Promise<unknown>;
  /**
   * Creates the `auth.users` row a fixture's foreign keys point at.
   *
   * The migrations cascade from `auth.users`, so a fixture that only inserts a
   * `user_id` uuid is rejected — the same way it would be in production, where
   * Supabase owns that table.
   */
  createUser: (id: string) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Builds a migrated, empty database.
 *
 * The Supabase shims come first because the migrations reference `auth.users`;
 * they are the same shims CI applies before validating the guards, so a
 * migration that only works against a real Supabase project fails here too.
 */
export async function createTestDb(): Promise<TestDb> {
  const pglite = new PGlite();
  await pglite.exec(stripMetaCommands(read('tests/db/bootstrap_supabase_shims.sql')));

  for (const migration of MIGRATIONS) {
    for (const statement of read(migration).split('--> statement-breakpoint')) {
      if (statement.trim().length > 0) await pglite.exec(statement);
    }
  }

  const db = drizzle(pglite, { schema }) as unknown as TestDatabase;

  return {
    db,
    query: async (sql, params) => {
      const result = await pglite.query<Record<string, unknown>>(sql, params as unknown[]);
      return { rows: result.rows };
    },
    exec: async (sql) => pglite.exec(sql),
    createUser: async (id) => {
      await pglite.query('insert into auth.users (id) values ($1)', [id]);
    },
    close: async () => pglite.close(),
  };
}
