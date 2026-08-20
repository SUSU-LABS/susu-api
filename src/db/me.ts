/**
 * The account read model: a user's profile and the wallet they have linked.
 *
 * This is application state, not chain state. It cannot change a balance or
 * authorise anything, and the chain does not consult it.
 */
import { eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { profiles, walletLinks } from './schema';

/**
 * The account as a client sees it.
 *
 * Timestamps are ISO strings and `createdAt` is `null` when no profile row
 * exists. That is a real state, not a missing one: the profile row is created
 * lazily, on the first write, so a user who signed up and set nothing has no row
 * and is nonetheless a valid, complete account.
 */
export type AccountView = {
  userId: string;
  displayName: string | null;
  avatarPath: string | null;
  walletAddress: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

/** The fields a user may change. Both are nullable so a value can be cleared. */
export type ProfileChanges = {
  displayName?: string | null;
  avatarPath?: string | null;
};

export type AccountReadModel = {
  getAccount(userId: string): Promise<AccountView>;
  updateProfile(userId: string, changes: ProfileChanges): Promise<AccountView>;
};

type Database = NodePgDatabase<typeof schema>;

export function createAccountReadModel(db: Database): AccountReadModel {
  /**
   * Reads the profile and the wallet link.
   *
   * Two lookups rather than one join, for a reason worth stating: a user may
   * have a profile and no wallet, or a wallet and no profile row. A join
   * anchored on either table would report the other table's absence as the
   * absence of the whole account, and the two absences mean different things.
   */
  async function getAccount(userId: string): Promise<AccountView> {
    const [profile] = await db
      .select()
      .from(profiles)
      .where(eq(profiles.userId, userId))
      .limit(1);

    const [wallet] = await db
      .select({ address: walletLinks.address })
      .from(walletLinks)
      .where(eq(walletLinks.userId, userId))
      .limit(1);

    return {
      userId,
      displayName: profile?.displayName ?? null,
      avatarPath: profile?.avatarPath ?? null,
      walletAddress: wallet?.address ?? null,
      createdAt: profile?.createdAt.toISOString() ?? null,
      updatedAt: profile?.updatedAt.toISOString() ?? null,
    };
  }

  /**
   * Applies profile changes, creating the row if it does not exist.
   *
   * An upsert rather than an update, because the profile row is created lazily:
   * the first thing a user sets may well be the first row they cause to exist.
   *
   * `updated_at` is not set here. The `profiles_set_updated_at` trigger owns it,
   * and writing it from two places is how the two eventually disagree.
   */
  async function updateProfile(userId: string, changes: ProfileChanges): Promise<AccountView> {
    if (Object.keys(changes).length === 0) {
      // Callers validate first, so reaching this is a programming error. Named
      // here rather than surfacing as a query builder failure.
      throw new Error('updateProfile called with no changes');
    }

    await db
      .insert(profiles)
      .values({ userId, ...changes })
      .onConflictDoUpdate({ target: profiles.userId, set: changes });

    return getAccount(userId);
  }

  return { getAccount, updateProfile };
}
