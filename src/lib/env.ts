import { z } from 'zod';
import { Networks } from '@stellar/stellar-sdk';
import { resolveSslPolicy } from '../db/ssl';

/**
 * Server-side environment validation.
 *
 * This module is server-only. Its values must never be imported, bundled, or
 * forwarded to the browser. The API is an application layer: it holds no
 * financial authority and never decides balances, recipients, or eligibility.
 */

/** The MVP protocol fee. Changing this is a financial-invariant change. */
export const PROTOCOL_FEE_BPS_MVP = 50;

/**
 * The network each well-known Stellar passphrase identifies. A passphrase is a
 * network's identity on the wire: signing or verifying against the wrong one
 * silently addresses the wrong ledger, so a known passphrase that does not
 * match the configured network is a startup error, not a warning.
 *
 * Passphrases outside this map (custom standalone networks) are accepted as-is:
 * only a positive identification of the *wrong* network is rejected.
 */
const KNOWN_PASSPHRASE_NETWORKS: ReadonlyMap<string, 'local' | 'testnet' | 'mainnet'> = new Map([
  [Networks.TESTNET, 'testnet'],
  [Networks.PUBLIC, 'mainnet'],
  [Networks.STANDALONE, 'local'],
  [Networks.SANDBOX, 'local'],
]);

const contractIdSchema = z.union([z.string().regex(/^C[A-Z2-7]{55}$/), z.literal('')]);
const accountIdSchema = z.union([z.string().regex(/^G[A-Z2-7]{55}$/), z.literal('')]);

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),

  // Database. The API holds no custody; the database is a rebuildable index.
  DATABASE_URL: z
    .string()
    .refine(
      (value) => value.startsWith('postgres://') || value.startsWith('postgresql://'),
      'must be a postgres:// or postgresql:// connection string',
    ),
  // PEM contents of the database server's CA. Optional, but see
  // DATABASE_SSL_ALLOW_UNVERIFIED below: without it, or that flag, the API
  // refuses to start rather than connecting to a server it cannot authenticate.
  // Supabase publishes its CA at Project Settings -> Database -> SSL
  // configuration. Server-only, like everything here.
  DATABASE_SSL_CA: z.string().optional(),
  // Explicit acknowledgement that the database server will not be authenticated.
  // Named for what it permits: setting it accepts a machine-in-the-middle risk,
  // it does not enable a feature. See `src/db/ssl.ts` for why Supabase cannot be
  // verified with the default trust store.
  DATABASE_SSL_ALLOW_UNVERIFIED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
  SUPABASE_URL: z.string().url(),
  // Server-only. Never exposed to the browser.
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  // Stellar. Testnet by default; Mainnet requires explicit opt-in.
  STELLAR_NETWORK: z.enum(['local', 'testnet', 'mainnet']),
  STELLAR_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  FACTORY_CONTRACT_ID: contractIdSchema,
  USDC_CONTRACT_ID: contractIdSchema,
  TREASURY_ADDRESS: accountIdSchema,

  // Must match the contract. Enforced below.
  PROTOCOL_FEE_BPS: z.coerce.number().int().positive(),

  // Single-use, expiring wallet-link nonces.
  WALLET_NONCE_SECRET: z.string().min(32),

  // Explicit opt-in required before the API may be pointed at Mainnet.
  ALLOW_MAINNET: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),

  // Comma-separated allowlist. Empty means no cross-origin access.
  CORS_ALLOWED_ORIGINS: z.string().default(''),

  // Comma-separated list of trusted proxy CIDRs (e.g. Render private ranges).
  // Empty means no proxies are trusted (trustProxy: false), preventing header spoofing.
  TRUSTED_PROXY_CIDRS: z.string().default(''),

  // Optional S3-compatible storage. Server-only credentials.
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
});

export type Env = z.infer<typeof envSchema>;

/** Decodes a JWT payload for inspection only — never for an authorization decision. */
export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split('.');
  const payload = parts[1];
  if (parts.length !== 3 || !payload) return undefined;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
    return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function assertSecurityInvariants(env: Env): void {
  const claims = decodeJwtPayload(env.SUPABASE_SERVICE_ROLE_KEY);
  if (claims && claims['role'] !== 'service_role') {
    throw new Error(
      'SUPABASE_SERVICE_ROLE_KEY does not contain a service_role token. ' +
        'Refusing to start with a non-elevated key in a server-only variable.',
    );
  }

  if (env.PROTOCOL_FEE_BPS !== PROTOCOL_FEE_BPS_MVP) {
    throw new Error(
      `PROTOCOL_FEE_BPS must be ${PROTOCOL_FEE_BPS_MVP}. The protocol fee is a financial ` +
        'invariant and must match the deployed contracts exactly. Changing it requires human review.',
    );
  }

  if (env.STELLAR_NETWORK === 'mainnet' && !env.ALLOW_MAINNET) {
    throw new Error(
      'STELLAR_NETWORK is mainnet but ALLOW_MAINNET is not "true". ' +
        'Mainnet is out of scope until the Mainnet readiness gate is passed with explicit approval.',
    );
  }

  // A passphrase names the network. Accepting `testnet` with the Mainnet
  // passphrase (or vice versa) starts cleanly and then signs, verifies, and
  // labels wallet-link messages against the wrong ledger — the nonce message
  // at `src/lib/nonce.ts` would name a network the deployment is not on.
  // Refuse it here, at startup, rather than after the first confusing failure.
  const passphraseNetwork = KNOWN_PASSPHRASE_NETWORKS.get(env.STELLAR_NETWORK_PASSPHRASE);
  if (passphraseNetwork !== undefined && passphraseNetwork !== env.STELLAR_NETWORK) {
    throw new Error(
      `STELLAR_NETWORK is "${env.STELLAR_NETWORK}" but STELLAR_NETWORK_PASSPHRASE is the ` +
        `"${passphraseNetwork}" network passphrase. A mismatched passphrase silently addresses ` +
        'the wrong ledger; refusing to start.',
    );
  }

  // Refuse a database connection that would be encrypted but unauthenticated.
  // Checked here, at startup, rather than when the first query runs: a pool that
  // fails mid-request turns a configuration mistake into an outage, and this is a
  // decision that must be made deliberately rather than defaulted into.
  const tls = resolveSslPolicy({
    connectionString: env.DATABASE_URL,
    ca: env.DATABASE_SSL_CA,
    allowUnverified: env.DATABASE_SSL_ALLOW_UNVERIFIED,
  });
  if (!tls.ok) {
    throw new Error(`Unsafe database TLS configuration — ${tls.reason}. ${tls.remedy}`);
  }
}

/**
 * Validates raw environment values. Throws with a descriptive message when
 * configuration is invalid or violates a security invariant.
 */
export function parseEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid server environment configuration — ${issues}`);
  }

  assertSecurityInvariants(result.data);
  return result.data;
}

let cachedEnv: Env | undefined;

/** Returns validated server configuration, parsing once on first use. */
export function getEnv(): Env {
  if (cachedEnv === undefined) {
    cachedEnv = parseEnv(process.env as Record<string, unknown>);
  }
  return cachedEnv;
}
