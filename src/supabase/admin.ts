/**
 * The Supabase admin client.
 *
 * One client, built once, used for the two privileged operations this service
 * performs against Supabase Auth: resolving an access token to a user, and
 * deleting an account.
 *
 * It is typed as the slice of behaviour used here rather than as the vendor's
 * client type. That is not stylistic: the route and guard tests need to exercise
 * the failure paths, and a narrower type lets them supply a plain object instead
 * of standing up a Supabase project.
 *
 * `persistSession` and `autoRefreshToken` are both off. Those options exist for
 * a browser or a long-lived worker that should keep a session alive; this
 * service holds no session, and leaving them on would have it write tokens to
 * wherever it happened to be running.
 */
import { createClient } from '@supabase/supabase-js';

type GetUserResult = {
  data: { user: { id: string; email?: string | null } | null };
  error: { message: string } | null;
};

/** The slice of the admin client this service uses. */
export type SupabaseAdminClient = {
  auth: {
    getUser(accessToken: string): Promise<GetUserResult>;
    admin: {
      deleteUser(userId: string): Promise<{ error: { message: string } | null }>;
    };
  };
};

export function createSupabaseAdminClient(
  supabaseUrl: string,
  serviceRoleKey: string,
): SupabaseAdminClient {
  return createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  }) as unknown as SupabaseAdminClient;
}

/**
 * Deletes an account. Returns whether it succeeded rather than throwing.
 *
 * Deleting the Supabase Auth user is what cascades to this application's tables:
 * the profile, the wallet link, the user's notifications and the invites they
 * issued all declare `on delete cascade` against `auth.users`. Nothing in that
 * cascade can reach chain history, because chain-derived rows are keyed by
 * wallet and contract address rather than by user id.
 *
 * A failure is reported as a value so the route can answer 502 — the caller is
 * authenticated and their retry may succeed — instead of degrading into a
 * generic 500.
 */
export type AccountDeleter = (userId: string) => Promise<boolean>;

export function createAccountDeleter(client: SupabaseAdminClient): AccountDeleter {
  return async (userId: string): Promise<boolean> => {
    const { error } = await client.auth.admin.deleteUser(userId);
    return error === null;
  };
}
