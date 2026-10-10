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

let inFlightClose: Promise<void> | undefined;

export async function closeDb(): Promise<void> {
  if (inFlightClose !== undefined) {
    await inFlightClose;
    return;
  }
  if (pool !== undefined) {
    const activePool = pool;
    pool = undefined;
    database = undefined;
    inFlightClose = (async () => {
      try {
        if (!activePool.ended && !(activePool as { ending?: boolean }).ending) {
          await activePool.end();
        }
      } finally {
        inFlightClose = undefined;
      }
    })();
    await inFlightClose;
  }
}
