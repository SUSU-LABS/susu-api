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

/** One entry as Storage's list endpoint returns it. Only the name is needed. */
type StorageObjectEntry = { name: string };

type StorageListResult = {
  data: StorageObjectEntry[] | null;
  error: { message: string } | null;
};

type StorageRemoveResult = {
  data: { name: string }[] | null;
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
  storage: {
    from(bucket: string): {
      list(path: string, options?: { limit?: number; offset?: number }): Promise<StorageListResult>;
      remove(paths: string[]): Promise<StorageRemoveResult>;
    };
  };
};

/** The bucket profile photos live in. Kept beside the deleter that empties it. */
export const PROFILE_IMAGE_BUCKET = 'profile-images';

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
 * THE PHOTO IS NOT REACHABLE BY THAT CASCADE. A Storage object is a row in
 * `storage.objects` plus a blob behind the Storage API; the blob is removed by
 * the API, not by a foreign key, so the objects are deleted here — before the
 * account, and through the same service-role client.
 *
 * ORDER, AND WHAT FAILURE MEANS
 * The photo is removed first, and a failure there does not stop the account
 * deletion. That ordering is deliberate: the account is the thing the user asked
 * to destroy, and refusing to destroy it because a blob would not delete would
 * make the requested operation fail for a reason the user cannot act on. The
 * cost of the reverse order is the opposite and worse: an account gone while its
 * photo remains.
 *
 * A failed cleanup is reported to the caller's logger and otherwise ignored. The
 * object that survives is still private — the only policy that could read it was
 * the owner's, and the owner no longer exists — so this is untidy rather than
 * exposed, and it is recorded rather than silently swallowed.
 *
 * A failure of the account deletion itself is reported as a value so the route
 * can answer 502 — the caller is authenticated and their retry may succeed —
 * instead of degrading into a generic 500.
 */
export type AccountDeleter = (userId: string) => Promise<boolean>;

export type AccountDeleterOptions = {
  /**
   * Where a cleanup that did not finish is reported.
   *
   * Injected rather than logged here so this module keeps no opinion about
   * logging, and so a test can assert the warning was raised.
   */
  readonly onWarning?: (message: string) => void;
  readonly bucket?: string;
};

/**
 * The number of avatar objects fetched per page.
 *
 * The app keeps one photo per user, but a client that somehow accumulated
 * objects must not turn account deletion into an unbounded scan, so listing is
 * paged.
 */
const AVATAR_LIST_LIMIT = 100;

/**
 * A ceiling on how many objects one deletion will collect.
 *
 * Pagination alone terminates on a short page, but an adversarial or corrupt
 * store could keep returning full pages forever. Once this many objects have
 * been collected the cleanup stops and warns rather than looping without end.
 * It is far above any real account, so reaching it is itself a signal.
 */
const MAX_AVATAR_OBJECTS = 1_000;

async function removeProfileImages(
  client: SupabaseAdminClient,
  bucket: string,
  userId: string,
  onWarning: (message: string) => void,
): Promise<void> {
  const prefix = `users/${userId}/avatar`;

  // Pages are gathered before anything is removed: deleting as we page would
  // shift the objects a later offset expects and skip the ones that moved down.
  const paths: string[] = [];
  let offset = 0;
  let truncated = false;

  while (true) {
    const listing = await client.storage
      .from(bucket)
      .list(prefix, { limit: AVATAR_LIST_LIMIT, offset });
    if (listing.error !== null || listing.data === null) {
      onWarning(
        `profile image cleanup could not list ${prefix}: ${listing.error?.message ?? 'no data'}`,
      );
      return;
    }

    for (const entry of listing.data) {
      paths.push(`${prefix}/${entry.name}`);
    }

    if (listing.data.length < AVATAR_LIST_LIMIT) break;

    offset += listing.data.length;
    if (paths.length >= MAX_AVATAR_OBJECTS) {
      truncated = true;
      break;
    }
  }

  if (paths.length === 0) return;

  // Remove in pages rather than in one call: a failure in a later page still
  // records how many objects were left behind, and a single oversized request
  // is one the Storage API may reject outright.
  let removed = 0;
  for (let index = 0; index < paths.length; index += AVATAR_LIST_LIMIT) {
    const page = paths.slice(index, index + AVATAR_LIST_LIMIT);
    const result = await client.storage.from(bucket).remove(page);
    if (result.error !== null) {
      onWarning(
        `profile image cleanup left ${paths.length - removed} object(s) in ${bucket}: ${result.error.message}`,
      );
      return;
    }
    removed += page.length;
  }

  if (truncated) {
    onWarning(
      `profile image cleanup removed ${removed} object(s) from ${bucket} but the listing was ` +
        `truncated at ${MAX_AVATAR_OBJECTS}; more objects may remain.`,
    );
  }
}

export function createAccountDeleter(
  client: SupabaseAdminClient,
  options: AccountDeleterOptions = {},
): AccountDeleter {
  const bucket = options.bucket ?? PROFILE_IMAGE_BUCKET;
  const onWarning = options.onWarning ?? ((): void => {});

  return async (userId: string): Promise<boolean> => {
    await removeProfileImages(client, bucket, userId, onWarning);

    const { error } = await client.auth.admin.deleteUser(userId);
    return error === null;
  };
}
