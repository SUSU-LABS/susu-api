import { describe, expect, it, vi } from 'vitest';
import { createTokenVerifier, type UserLookupClient } from './verify';

type GetUserResult = Awaited<ReturnType<UserLookupClient['auth']['getUser']>>;

function clientReturning(result: GetUserResult): UserLookupClient & {
  auth: { getUser: ReturnType<typeof vi.fn> };
} {
  return { auth: { getUser: vi.fn(async () => result) } } as unknown as UserLookupClient & {
    auth: { getUser: ReturnType<typeof vi.fn> };
  };
}

const VALID: GetUserResult = {
  data: { user: { id: '11111111-1111-1111-1111-111111111111', email: 'ada@example.com' } },
  error: null,
};

describe('createTokenVerifier', () => {
  it('resolves a valid token to its user', async () => {
    const verify = createTokenVerifier(clientReturning(VALID));

    await expect(verify('a-token')).resolves.toEqual({
      id: '11111111-1111-1111-1111-111111111111',
      email: 'ada@example.com',
    });
  });

  it('does not call the provider for an empty token', async () => {
    const client = clientReturning(VALID);
    const verify = createTokenVerifier(client);

    await expect(verify('')).resolves.toBeUndefined();
    // The check exists to avoid spending a network round trip on a request that
    // cannot succeed, so "was not called" is the assertion, not just the result.
    expect(client.auth.getUser).not.toHaveBeenCalled();
  });

  it('rejects a token the provider declines', async () => {
    const verify = createTokenVerifier(
      clientReturning({ data: { user: null }, error: { message: 'invalid claim' } }),
    );

    await expect(verify('stale-token')).resolves.toBeUndefined();
  });

  it('rejects a response with no user even without an error', async () => {
    // Defensive: the shape is the provider's to change, and a missing user must
    // never be read as an authenticated one.
    const verify = createTokenVerifier(clientReturning({ data: { user: null }, error: null }));

    await expect(verify('a-token')).resolves.toBeUndefined();
  });

  it('rejects a user with an empty id', async () => {
    const verify = createTokenVerifier(
      clientReturning({ data: { user: { id: '', email: null } }, error: null }),
    );

    await expect(verify('a-token')).resolves.toBeUndefined();
  });

  it('normalises a null email to undefined rather than passing null through', async () => {
    const verify = createTokenVerifier(
      clientReturning({ data: { user: { id: 'abc', email: null } }, error: null }),
    );

    const user = await verify('a-token');
    expect(user).toEqual({ id: 'abc', email: undefined });
    // An account with no email is legitimate (phone-only signup), so the caller
    // should never have to distinguish null from absent.
    expect(user?.email).toBeUndefined();
  });

  it('propagates a provider throw so the guard can fail closed', async () => {
    const client = {
      auth: {
        getUser: vi.fn(async () => {
          throw new Error('network unreachable');
        }),
      },
    } as unknown as UserLookupClient;
    const verify = createTokenVerifier(client);

    // Deliberately not swallowed here: the guard decides what an outage means,
    // and it decides "unauthenticated".
    await expect(verify('a-token')).rejects.toThrow('network unreachable');
  });
});
