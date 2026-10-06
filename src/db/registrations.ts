/**
 * Group registrations: remembering a group address the chain just produced.
 *
 * WHY THIS EXISTS
 * A group's address is the hash of its own deployment, so the only way to learn a
 * group exists is to watch the Factory emit it. The indexer does that on a
 * schedule, so there is a window after a creator's confirmation in which the
 * address is real and this API has never heard of it. During that window the
 * creator cannot invite anyone, because creating an invite requires the API to
 * recognise the group.
 *
 * A registration bridges that window. It is an address, the account that claimed
 * it, and an expiry — nothing else. It is not a group: it carries no amount, no
 * membership and no status, nothing financial reads it, and it cannot make a
 * contract exist. The index remains the authority on what a group is, and an
 * indexed row makes the claim redundant simply by arriving.
 *
 * THE EXPIRY IS THE SECURITY PROPERTY
 * Nothing has to run for a false claim to stop being believed; the clock does it.
 * That is what makes a claim acceptable without verifying it against the chain:
 * the exposure is bounded in time, and the table cannot accumulate unverified
 * addresses that outlive the indexing lag they were meant to cover.
 *
 * A CAP, SO THE WINDOW CANNOT BE HELD OPEN AT SCALE
 * One account may hold a few live registrations at once. Without the cap an
 * account could register addresses indefinitely and keep a standing list of
 * unverified addresses the API would treat as groups. The cap is deliberately
 * small: a creator needs one, or one per group they are creating, and the honest
 * use of this table is rare.
 */
import { and, eq, gt, lte, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from './schema';
import { groupRegistrations } from './schema';

type Database = NodePgDatabase<typeof schema>;

/**
 * How long a registration is believed.
 *
 * The indexer runs every five minutes, so this is several runs' worth. The
 * margin is deliberate: the failure it covers is a delayed or missed indexing
 * run, and a window that expired at exactly one run would fail on the first run
 * that was late, which is when the creator most needs it.
 */
export const REGISTRATION_TTL_MS = 30 * 60 * 1000;

/**
 * How many live registrations one account may hold.
 *
 * Small, because the honest use is "the group I just created" and the dishonest
 * use is a standing list. A creator working on several groups at once is
 * plausible; a hundred is not.
 */
export const MAX_LIVE_REGISTRATIONS = 5;

export type RegistrationOutcome =
  | { readonly outcome: 'registered'; readonly contractId: string; readonly expiresAt: string }
  /** The account already holds the maximum number of live registrations. */
  | { readonly outcome: 'too_many' };

export type RegistrationStore = {
  /**
   * Claims that `contractId` is a group, for a bounded while.
   *
   * Idempotent for the account that made the claim, and extended by a repeat so a
   * creator who registers again is not told their own registration expired. It
   * does not extend someone else's claim: a second account registering an address
   * already claimed is told it is registered and changes nothing.
   */
  register(input: { contractId: string; userId: string }): Promise<RegistrationOutcome>;

  /**
   * Whether the address is currently claimed by an unexpired registration.
   *
   * Says nothing about whether it is a group. Callers combine this with the
   * index, and the index is what makes the answer durable.
   */
  isRegistered(contractId: string): Promise<boolean>;
};

export function createRegistrationStore(db: Database): RegistrationStore {
  async function countLive(userId: string): Promise<number> {
    const rows = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(groupRegistrations)
      .where(
        and(
          eq(groupRegistrations.registeredBy, userId),
          gt(groupRegistrations.expiresAt, sql`now()`),
        ),
      );

    return rows[0]?.count ?? 0;
  }

  return {
    async register({ contractId, userId }) {
      // Expired rows for this account are removed first. They answer nothing —
      // `isRegistered` would ignore them — so leaving them would only accumulate
      // rows and, worse, count against the cap that is meant to measure live
      // claims. Cleaning up the account's own rows keeps that bounded without a
      // background job.
      await db
        .delete(groupRegistrations)
        .where(
          and(
            eq(groupRegistrations.registeredBy, userId),
            lte(groupRegistrations.expiresAt, sql`now()`),
          ),
        );

      const expiresAt = new Date(Date.now() + REGISTRATION_TTL_MS);

      // The cap is checked against the claim being *replaced*, so re-registering
      // an address an account already holds is never refused for being at the
      // limit — otherwise the one case that should always work would fail.
      const existing = await db
        .select({ registeredBy: groupRegistrations.registeredBy })
        .from(groupRegistrations)
        .where(eq(groupRegistrations.contractId, contractId));

      const alreadyMine = existing[0]?.registeredBy === userId;
      if (alreadyMine) {
        const updated = await db
          .update(groupRegistrations)
          .set({ expiresAt })
          .where(
            and(
              eq(groupRegistrations.contractId, contractId),
              // Belt and braces against a concurrent claim by another account
              // between the read above and this write: the update matches nothing
              // rather than transferring the row.
              eq(groupRegistrations.registeredBy, userId),
            ),
          )
          .returning({ expiresAt: groupRegistrations.expiresAt });

        return {
          outcome: 'registered',
          contractId,
          expiresAt: (updated[0]?.expiresAt ?? expiresAt).toISOString(),
        } as const;
      }

      // Another account's claim, or none.
      // Enforce the cap atomically with `INSERT ... SELECT ... WHERE count < MAX`.
      // This prevents race conditions where concurrent calls both observe count < MAX and both insert.
      const insertResult = (await db.execute(sql`
        INSERT INTO "group_registrations" ("contract_id", "registered_by", "expires_at")
        SELECT ${contractId}, ${userId}, ${expiresAt}
        WHERE (
          SELECT count(*)::int
          FROM "group_registrations"
          WHERE "registered_by" = ${userId}
            AND "expires_at" > now()
        ) < ${MAX_LIVE_REGISTRATIONS}
        ON CONFLICT ("contract_id") DO NOTHING
        RETURNING "expires_at" AS "expiresAt"
      `)) as unknown as { rows: Array<{ expiresAt: Date | string }> };

      if (insertResult.rows[0] !== undefined) {
        const rowExpires = insertResult.rows[0].expiresAt;
        const iso = rowExpires instanceof Date ? rowExpires.toISOString() : new Date(rowExpires).toISOString();
        return {
          outcome: 'registered',
          contractId,
          expiresAt: iso,
        } as const;
      }

      // No row was inserted: either the user is at/over the cap, or the address is already claimed by someone else.
      if ((await countLive(userId)) >= MAX_LIVE_REGISTRATIONS) {
        return { outcome: 'too_many' } as const;
      }

      const holder = await db
        .select({ expiresAt: groupRegistrations.expiresAt })
        .from(groupRegistrations)
        .where(eq(groupRegistrations.contractId, contractId));

      return {
        outcome: 'registered',
        contractId,
        expiresAt: (holder[0]?.expiresAt ?? expiresAt).toISOString(),
      } as const;
    },

    async isRegistered(contractId) {
      const rows = await db
        .select({ contractId: groupRegistrations.contractId })
        .from(groupRegistrations)
        .where(
          and(
            eq(groupRegistrations.contractId, contractId),
            gt(groupRegistrations.expiresAt, sql`now()`),
          ),
        )
        .limit(1);

      return rows.length > 0;
    },
  };
}
