/**
 * The authenticated-route guard.
 *
 * This is the only place a request's identity is decided. Routes opt in with
 * `{ preHandler: requireAuth }` and then read `authenticatedUser(request)`; no
 * route ever trusts a user id from a parameter, a body, or a header.
 *
 * FAIL CLOSED
 * A verifier that throws — a DNS failure, a provider outage, a timeout — is
 * treated as "not authenticated" rather than being allowed through. The
 * alternative, letting an unreachable identity provider imply a valid identity,
 * is a worse failure than an outage: it turns a dependency's downtime into an
 * open door. The consequence is that a Supabase outage makes authenticated
 * routes return 401, which is the intended trade.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AuthenticatedUser, TokenVerifier } from './verify';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by the auth guard. Absent on public routes. */
    user?: AuthenticatedUser;
  }
}

/** The scheme name, matched case-sensitively as RFC 6750 defines it. */
const BEARER_PREFIX = 'Bearer ';

function unauthorized(reply: FastifyReply): void {
  // `www-authenticate` is what makes this a 401 rather than a 403 to any client
  // that knows the difference: the request lacked valid credentials, and
  // retrying with a fresh token is a sensible thing for a caller to do.
  void reply.header('www-authenticate', 'Bearer').code(401).send({ error: 'unauthorized' });
}

/**
 * Builds the guard around a verifier.
 *
 * The verifier is injected rather than imported so route tests can exercise the
 * failure paths — no header, wrong scheme, empty token, rejected token, verifier
 * outage — without a network or a Supabase project.
 */
export function createRequireAuth(verifyToken: TokenVerifier) {
  return async function requireAuth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void> {
    const header = request.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith(BEARER_PREFIX)) {
      return unauthorized(reply);
    }

    const token = header.slice(BEARER_PREFIX.length).trim();
    if (token.length === 0) return unauthorized(reply);

    // A verifier that throws is an unauthenticated request, not an error the
    // client can act on, and not a reason to continue.
    let user: AuthenticatedUser | undefined;
    try {
      user = await verifyToken(token);
    } catch (error) {
      request.log.error({ err: error }, 'token verification failed');
      return unauthorized(reply);
    }

    if (user === undefined) return unauthorized(reply);

    request.user = user;
  };
}

/**
 * Reads the identity the guard established.
 *
 * Throws rather than returning undefined when a route forgot to declare the
 * guard. That is a programming error, and the alternative — an undefined id
 * flowing into a query — would turn "this route is unprotected" into "this route
 * queries as nobody", which is likelier to fail quietly and in the wrong
 * direction.
 */
export function authenticatedUser(request: FastifyRequest): AuthenticatedUser {
  const user = request.user;
  if (user === undefined) {
    throw new Error('authenticatedUser() called on a route without the auth guard');
  }
  return user;
}
