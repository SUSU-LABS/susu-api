import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { getEnv } from '../lib/env';
import { resolveSslPolicy, withoutSslModeParams } from './ssl';
import * as schema from './schema';

/**
 * PostgreSQL access.
 *
 * The database is a rebuildable index of chain activity — never the source of
 * truth. If database state ever conflicts with Stellar/Soroban state, the chain
 * wins and reconciliation repairs the database.
 *
 * The connection uses a privileged role and must be used only from server code.
 * Browser clients never receive these credentials.
 */

let pool: Pool | undefined;
let database: NodePgDatabase<typeof schema> | undefined;

export function getPool(): Pool {
  if (pool === undefined) {
    const env = getEnv();

    // The same pure decision `parseEnv` already refused to start without. It is
    // derived again here because the pool needs the value, and because deriving
    // it from one function means the check and the connection cannot disagree.
    const tls = resolveSslPolicy({
      connectionString: env.DATABASE_URL,
      ca: env.DATABASE_SSL_CA,
      allowUnverified: env.DATABASE_SSL_ALLOW_UNVERIFIED,
    });
    if (!tls.ok) {
      throw new Error(`Unsafe database TLS configuration — ${tls.reason}. ${tls.remedy}`);
    }

    pool = new Pool({
      // TLS is configured here rather than left to the connection string; see
      // `src/db/ssl.ts` for why `pg`'s default makes every query time out against
      // a hosted database, and what `DATABASE_SSL_CA` changes.
      connectionString: withoutSslModeParams(env.DATABASE_URL),
      ssl: tls.ssl,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
  }
  return pool;
}

export function getDb(): NodePgDatabase<typeof schema> {
  if (database === undefined) {
    database = drizzle(getPool(), { schema });
  }
  return database;
}

export async function closeDb(): Promise<void> {
  // The reference is dropped before the pool is awaited, not after. Several
  // servers can share this one pool — every `buildServer` registers the hook —
  // and Fastify closes an app's hooks concurrently, so two callers that both
  // saw a live pool would each call `end` and `pg` would refuse the second.
  // Taking it here makes the first caller the only one that ends it, and the
  // others resolve immediately.
  const closing = pool;
  pool = undefined;
  database = undefined;
  if (closing !== undefined) {
    await closing.end();
  }
}
