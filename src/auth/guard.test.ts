import { describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { authenticatedUser, createRequireAuth } from './guard';
import type { TokenVerifier } from './verify';

const USER = { id: '11111111-1111-1111-1111-111111111111', email: 'ada@example.com' };

/**
 * An app with one guarded route and one unguarded route.
 *
 * The unguarded route exists so the "route forgot the guard" behaviour is
 * asserted rather than assumed.
 */
async function appWith(verifyToken: TokenVerifier): Promise<FastifyInstance> {
  const app = Fastify();
  const requireAuth = createRequireAuth(verifyToken);

  app.get('/private', { preHandler: requireAuth }, async (request) => ({
    user: authenticatedUser(request),
  }));

  app.get('/public', async () => ({ ok: true }));

  await app.ready();
  return app;
}

const accepting = (): TokenVerifier => vi.fn(async () => USER);
const rejecting = (): TokenVerifier => vi.fn(async () => undefined);

describe('createRequireAuth', () => {
  it('admits a request carrying a valid bearer token', async () => {
    const app = await appWith(accepting());
    const response = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Bearer a-good-token' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ user: USER });
    await app.close();
  });

  it('passes the token through to the verifier unchanged', async () => {
    const verify = accepting();
    const app = await appWith(verify);

    await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Bearer a-good-token' },
    });

    expect(verify).toHaveBeenCalledWith('a-good-token');
    await app.close();
  });

  it('refuses a request with no authorization header', async () => {
    const app = await appWith(accepting());
    const response = await app.inject({ method: 'GET', url: '/private' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
    await app.close();
  });

  it('refuses a scheme that is not Bearer', async () => {
    const app = await appWith(accepting());
    const response = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Basic YWRhOnNlY3JldA==' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('refuses a Bearer header with no token', async () => {
    const verify = accepting();
    const app = await appWith(verify);
    const response = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Bearer ' },
    });

    expect(response.statusCode).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    await app.close();
  });

  it('refuses a Bearer header holding only whitespace', async () => {
    const verify = accepting();
    const app = await appWith(verify);
    const response = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Bearer    ' },
    });

    expect(response.statusCode).toBe(401);
    expect(verify).not.toHaveBeenCalled();
    await app.close();
  });

  it('advertises the scheme so a caller knows to retry with credentials', async () => {
    const app = await appWith(rejecting());
    const response = await app.inject({ method: 'GET', url: '/private' });

    expect(response.headers['www-authenticate']).toBe('Bearer');
    await app.close();
  });

  it('refuses a token the verifier rejects', async () => {
    const app = await appWith(rejecting());
    const response = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Bearer a-stale-token' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('fails closed when the verifier throws', async () => {
    // An identity provider that cannot be reached must not imply a valid
    // identity. This is the assertion that pins that decision.
    const app = await appWith(
      vi.fn(async () => {
        throw new Error('provider unreachable');
      }),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/private',
      headers: { authorization: 'Bearer any-token' },
    });

    expect(response.statusCode).toBe(401);
    await app.close();
  });

  it('leaves unguarded routes open', async () => {
    const app = await appWith(rejecting());
    const response = await app.inject({ method: 'GET', url: '/public' });

    expect(response.statusCode).toBe(200);
    await app.close();
  });
});

describe('authenticatedUser', () => {
  it('throws when a route reads the identity without the guard', async () => {
    // The failure is loud on purpose: an undefined id reaching a query turns
    // "this route is unprotected" into "this route queries as nobody".
    const app = Fastify();
    app.get('/forgot', async (request) => ({ user: authenticatedUser(request) }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/forgot' });
    expect(response.statusCode).toBe(500);
    await app.close();
  });
});
