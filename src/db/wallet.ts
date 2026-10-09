/**
 * The wallet-link store: spending nonces and recording bindings.
 *
 * Both operations are here rather than in the route because both are decided by
 * the database. Single use is an insert that cannot succeed twice, and "one
 * address, one account" is a unique index. A route that checked first and wrote
 * second would be describing an intention, not enforcing one.
 */
import { eq, lt } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { walletLinkNonces, walletLinks } from './schema';

type Database = NodePgDatabase<typeof schema>;

/** PostgreSQL's code for a unique violation. */
const UNIQUE_VIOLATION = '23505';

/** The constraint that means "this address already belongs to another account". */
const ADDRESS_UNIQUE = 'wallet_links_address_unique';

function isUniqueViolationOn(error: unknown, constraint: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown; cause?: unknown };
  if (candidate.code === UNIQUE_VIOLATION && candidate.constraint === constraint) return true;
  // drizzle wraps query failures in DrizzleQueryError; the Postgres error
  // carrying `code`/`constraint` lives under `.cause`.
  const cause = candidate.cause;
  if (typeof cause !== 'object' || cause === null) return false;
  const inner = cause as { code?: unknown; constraint?: unknown };
  return inner.code === UNIQUE_VIOLATION && inner.constraint === constraint;
}

export type WalletLinkStore = {
  /**
   * Records that a nonce has been spent.
   *
   * Returns `false` when the nonce was already spent. That is a refusal rather
   * than an error: a replay is exactly what this is for, and the caller turns it
   * into a response.
   */
  consumeNonce(input: { jti: string; userId: string; expiresAt: Date }): Promise<boolean>;

  /**
   * Binds an address to an account, replacing any previous binding for that
   * account.
   *
   * Returns `address_taken` when the address is already bound to somebody else.
   * This is not a conflict to resolve by overwriting: the address is an on-chain
   * identity, and giving it to a second account would leave the app unable to say
   * which of them the chain considers the member.
   */
  link(input: {
    userId: string;
    address: string;
  }): Promise<{ outcome: 'linked' } | { outcome: 'address_taken' }>;

  /** The address bound to an account, if any. */
  findAddress(userId: string): Promise<string | undefined>;

  /**
   * Deletes spent nonces whose expiry has passed.
   *
   * Rows are kept past expiry rather than deleted on the way out so that a
   * replayed nonce is refused as a replay rather than as an unknown token; the
   * distinction only matters for logs, but it is free to preserve.
   */
  reap(now: Date): Promise<number>;
};

export function createWalletLinkStore(db: Database): WalletLinkStore {
  return {
    async consumeNonce({ jti, userId, expiresAt }) {
      const inserted = await db
        .insert(walletLinkNonces)
        .values({ jti, userId, expiresAt })
        .onConflictDoNothing({ target: walletLinkNonces.jti })
        .returning({ jti: walletLinkNonces.jti });

      return inserted.length > 0;
    },

    async link({ userId, address }) {
      try {
        await db
          .insert(walletLinks)
          .values({ userId, address })
          // The primary key is the user, so re-linking replaces rather than
          // accumulates: an account has one wallet.
          .onConflictDoUpdate({ target: walletLinks.userId, set: { address } });
        return { outcome: 'linked' };
      } catch (error) {
        // The conflict clause handles the user's own row. It does not handle the
        // address belonging to someone else, because that is a different unique
        // index and therefore a different — and genuine — conflict.
        if (isUniqueViolationOn(error, ADDRESS_UNIQUE)) return { outcome: 'address_taken' };
        throw error;
      }
    },

    async findAddress(userId) {
      const [row] = await db
        .select({ address: walletLinks.address })
        .from(walletLinks)
        .where(eq(walletLinks.userId, userId))
        .limit(1);
      return row?.address;
    },

    async reap(now) {
      const deleted = await db
        .delete(walletLinkNonces)
        .where(lt(walletLinkNonces.expiresAt, now))
        .returning({ jti: walletLinkNonces.jti });
      return deleted.length;
    },
  };
}
