/**
 * Verifying a caller's Supabase access token.
 *
 * WHY VERIFICATION IS DELEGATED RATHER THAN DONE LOCALLY
 * The obvious alternative is to verify the JWT signature here: read the token,
 * check the signature and expiry, take `sub` as the user id. It is faster, it
 * needs no network, and it is the wrong default for this service.
 *
 * Two reasons, and the second is the one that decides it:
 *
 *   1. Local verification requires the project's signing material. Under the
 *      symmetric scheme that is the JWT secret — a credential whose compromise
 *      mints a valid session for any user, held by a service that has no other
 *      reason to possess it. Under the asymmetric scheme it is a JWKS document
 *      that rotates, and a hand-rolled verifier must implement key selection and
 *      rotation correctly or fail open.
 *   2. A signature check answers "was this token issued by us and is it in
 *      date?". It cannot answer "is this session still valid?". Supabase can
 *      revoke a session, and a stateless check will keep honouring that token
 *      until it expires. For an API whose job includes binding wallets to
 *      accounts, treating a revoked session as live is the wrong failure.
 *
 * So the platform is asked. The cost is one round trip per authenticated
 * request, which is a real cost and is accepted deliberately: if it becomes the
 * bottleneck, the answer is a short-lived cache keyed by token with an explicit
 * TTL, not a hand-written verifier.
 *
 * The client is typed as the slice of behaviour this module uses, so tests can
 * supply a plain object instead of a Supabase client — and so the failure paths,
 * which are the ones that matter, are exercised without a network.
 */

export type AuthenticatedUser = {
  /** The Supabase user id. The same value `auth.uid()` returns in a policy. */
  id: string;
  email: string | undefined;
};

/**
 * Resolves an access token to a user, or `undefined` when it is not valid.
 *
 * Returning `undefined` rather than throwing keeps the caller's control flow
 * obvious: there is exactly one way to be unauthenticated, and no error message
 * from the provider is ever surfaced to a client.
 */
export type TokenVerifier = (accessToken: string) => Promise<AuthenticatedUser | undefined>;

/** The slice of `@supabase/supabase-js` used here. */
export type UserLookupClient = {
  auth: {
    getUser(accessToken: string): Promise<{
      data: { user: { id: string; email?: string | null } | null };
      error: { message: string } | null;
    }>;
  };
};

/**
 * Builds a verifier over a client that can resolve tokens.
 *
 * A provider error is treated exactly like an invalid token. The distinction is
 * invisible to the caller either way, and logging the provider's message while
 * responding identically keeps a transient outage from being reported to a
 * client as an authentication decision.
 */
export function createTokenVerifier(client: UserLookupClient): TokenVerifier {
  return async (accessToken: string): Promise<AuthenticatedUser | undefined> => {
    if (accessToken.length === 0) return undefined;

    const { data, error } = await client.auth.getUser(accessToken);
    if (error !== null) return undefined;

    const user = data.user;
    if (user === null || typeof user.id !== 'string' || user.id.length === 0) return undefined;

    return {
      id: user.id,
      // Normalised to `undefined` so callers never branch on `null` versus
      // absent. An account can legitimately have no email (a phone-only signup),
      // and that is not an error.
      email: user.email ?? undefined,
    };
  };
}
