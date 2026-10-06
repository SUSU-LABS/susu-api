/**
 * The account endpoints.
 *
 * These describe the signed-in user to themselves: their profile and the wallet
 * they have linked. Nothing here can move money, and nothing here is consulted
 * by the chain.
 *
 * Every route declares the auth guard, and every route reads its identity from
 * `authenticatedUser(request)` — never from a parameter or a body. That is what
 * makes "read my account" incapable of becoming "read anyone's account".
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticatedUser } from '../auth/guard';
import type { MemberActivityRecord } from '../db/groups';
import type { AccountReadModel, ProfileChanges } from '../db/me';
import { envelope, paginationFields, type Page, type PageResult } from '../lib/pagination';
import type { AccountDeleter } from '../supabase/admin';
import { invalidRequest } from './errors';

export type { AccountDeleter };

export type MeRoutesOptions = {
  accountReadModel: AccountReadModel;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  deleteAccount: AccountDeleter;
  /**
   * The caller's chain activity, across every group their wallet is in.
   *
   * Injected as one function rather than the whole group read model: this route
   * needs exactly this question answered, and passing the model would hand the
   * account surface the ability to read any group it liked.
   */
  listMemberActivity: (address: string, page: Page) => Promise<PageResult<MemberActivityRecord>>;
};

/**
 * Account data is private and there is exactly one correct copy of it, so it is
 * never stored by an intermediary. A shared cache holding one user's profile
 * under a URL that another user can request is the classic way this goes wrong.
 */
const NO_STORE = 'no-store';

const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(80, 'must be 80 characters or fewer')
  .nullable();

/**
 * The avatar is stored as an object key, never a URL. Migration 0004_profile_images.sql
 * enforces the DB constraint `profiles_avatar_path_shape`:
 * `users/<user_id>/avatar/[0-9a-f]{32}.(png|jpe?g|webp)`.
 * We validate this schema anchored to the authenticated user's ID so that the database
 * constraint is never the first line of refusal.
 */
function avatarPathSchemaFor(userId: string) {
  const pattern = new RegExp(`^users/${userId}/avatar/[0-9a-f]{32}\\.(png|jpe?g|webp)$`);
  return z
    .string()
    .trim()
    .regex(pattern, `must match users/${userId}/avatar/<32-hex-hash>.(png|jpg|jpeg|webp)`)
    .nullable();
}

function patchBodySchema(userId: string) {
  return z
    .object({
      displayName: displayNameSchema.optional(),
      avatarPath: avatarPathSchemaFor(userId).optional(),
    })
    .refine((value) => value.displayName !== undefined || value.avatarPath !== undefined, {
      message: 'provide displayName or avatarPath',
    });
}

/**
 * Account deletion requires an explicit confirmation value.
 *
 * This is a speed bump, not a security control: the request is already
 * authenticated as the account being deleted, and no value here raises the
 * caller's privilege. What it prevents is the accident — a mistyped method, a
 * `fetch` reused from another call, a script run against the wrong environment —
 * turning into irreversible data loss. The account's own chain history is not
 * affected either way; see the route for what deletion does and does not reach.
 */
const deleteBody = z.object({
  confirm: z.literal('DELETE', {
    message: 'send {"confirm":"DELETE"} to delete the account',
  }),
});

/** The `limit`/`offset` pair for the activity feed, validated like every other list. */
const pageQuery = z.object(paginationFields);

export async function meRoutes(app: FastifyInstance, options: MeRoutesOptions): Promise<void> {
  const { accountReadModel, requireAuth, deleteAccount, listMemberActivity } = options;

  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = authenticatedUser(request);
    const account = await accountReadModel.getAccount(user.id);

    reply.header('cache-control', NO_STORE);
    return reply.send({ data: account });
  });

  app.patch('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = authenticatedUser(request);
    const parsed = patchBodySchema(user.id).safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    // Built explicitly rather than passed through, so an absent field stays
    // absent instead of being written as `undefined` and clearing a value the
    // caller never mentioned.
    const changes: ProfileChanges = {};
    if (parsed.data.displayName !== undefined) changes.displayName = parsed.data.displayName;
    if (parsed.data.avatarPath !== undefined) changes.avatarPath = parsed.data.avatarPath;

    try {
      const account = await accountReadModel.updateProfile(user.id, changes);
      reply.header('cache-control', NO_STORE);
      return reply.send({ data: account });
    } catch (error: unknown) {
      if (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { code: string }).code === '23514'
      ) {
        return reply.code(400).send({
          error: 'invalid_request',
          details: [{ path: 'avatarPath', message: 'violates profile avatar path constraint' }],
        });
      }
      throw error;
    }
  });

  /**
   * The signed-in user's activity feed.
   *
   * WHY IT IS UNDER /me RATHER THAN A NEW SURFACE
   * The answer depends on who is asking — it is every event from every group the
   * caller's wallet belongs to — so it is an account-scoped read, and it belongs
   * with the other account-scoped reads. The group's own activity list still
   * exists for the case where a client already knows which group it is looking
   * at, and the two answer different questions.
   *
   * NO_WALLET IS AN EMPTY FEED, NOT AN ERROR
   * Membership is what makes an event reachable here, and membership is by
   * wallet. A caller who has not linked one is in no group, so they have no feed;
   * answering `200` with nothing is that truth. Inventing an error would push a
   * state the client can already read from `GET /me` — where `walletAddress` is
   * `null` — into an error path it would have to translate.
   *
   * Not cached, like the rest of this surface: the URL is the same for every
   * caller, and the response is not.
   */
  app.get('/me/activity', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = pageQuery.safeParse(request.query);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const user = authenticatedUser(request);
    const account = await accountReadModel.getAccount(user.id);

    reply.header('cache-control', NO_STORE);

    if (account.walletAddress === null) {
      return reply.send(
        envelope({ items: [], hasMore: false }, parsed.data.limit, parsed.data.offset),
      );
    }

    const result = await listMemberActivity(account.walletAddress, parsed.data);
    return reply.send(envelope(result, parsed.data.limit, parsed.data.offset));
  });

  app.delete('/me', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = deleteBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    const user = authenticatedUser(request);
    const deleted = await deleteAccount(user.id);

    if (!deleted) {
      // The provider refused or could not be reached. Distinct from 401: the
      // caller is authenticated and their retry may well succeed.
      return reply.code(502).send({ error: 'account_deletion_failed' });
    }

    // Deleting the auth user cascades to the application tables that reference
    // it — profile, wallet link, notifications, and the invites the user issued.
    // It deliberately does not reach chain history: contributions and payouts
    // are keyed by wallet and contract address, never by user id, so a user
    // cannot erase a payout they received by closing their account.
    return reply.code(204).send();
  });
}
