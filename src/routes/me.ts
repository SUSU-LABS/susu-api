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
import type { AccountReadModel, ProfileChanges } from '../db/me';
import type { AccountDeleter } from '../supabase/admin';
import { invalidRequest } from './errors';

export type { AccountDeleter };

export type MeRoutesOptions = {
  accountReadModel: AccountReadModel;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  deleteAccount: AccountDeleter;
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
 * The avatar is stored as an object key, never a URL, and the key must stay a
 * relative path with no traversal. The upload path lands in a later phase; the
 * column is validated now so a stored value cannot become a path that resolves
 * outside the user's own prefix.
 */
const avatarPathSchema = z
  .string()
  .trim()
  .min(1, 'must not be empty')
  .max(255, 'must be 255 characters or fewer')
  .refine((value) => !value.startsWith('/'), 'must be a relative object key')
  .refine((value) => !value.includes('..'), 'must not contain ".."')
  .nullable();

const patchBody = z
  .object({
    displayName: displayNameSchema.optional(),
    avatarPath: avatarPathSchema.optional(),
  })
  .refine((value) => value.displayName !== undefined || value.avatarPath !== undefined, {
    message: 'provide displayName or avatarPath',
  });

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

export async function meRoutes(app: FastifyInstance, options: MeRoutesOptions): Promise<void> {
  const { accountReadModel, requireAuth, deleteAccount } = options;

  app.get('/me', { preHandler: requireAuth }, async (request, reply) => {
    const user = authenticatedUser(request);
    const account = await accountReadModel.getAccount(user.id);

    reply.header('cache-control', NO_STORE);
    return reply.send({ data: account });
  });

  app.patch('/me', { preHandler: requireAuth }, async (request, reply) => {
    const parsed = patchBody.safeParse(request.body);
    if (!parsed.success) return invalidRequest(reply, parsed.error);

    // Built explicitly rather than passed through, so an absent field stays
    // absent instead of being written as `undefined` and clearing a value the
    // caller never mentioned.
    const changes: ProfileChanges = {};
    if (parsed.data.displayName !== undefined) changes.displayName = parsed.data.displayName;
    if (parsed.data.avatarPath !== undefined) changes.avatarPath = parsed.data.avatarPath;

    const user = authenticatedUser(request);
    const account = await accountReadModel.updateProfile(user.id, changes);

    reply.header('cache-control', NO_STORE);
    return reply.send({ data: account });
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
