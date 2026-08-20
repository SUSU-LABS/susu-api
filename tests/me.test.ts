import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { AccountReadModel, AccountView, ProfileChanges } from '../src/db/me';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';

const AUTH = { authorization: 'Bearer a-good-token' };

/** Every app this suite builds, so nothing is left with an open handle. */
const built: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(built.map(async (app) => app.close()));
});

function accountView(overrides: Partial<AccountView> = {}): AccountView {
  return {
    userId: USER_ID,
    displayName: null,
    avatarPath: null,
    walletAddress: null,
    createdAt: null,
    updatedAt: null,
    ...overrides,
  };
}

type FakeReadModel = AccountReadModel & {
  getAccount: ReturnType<typeof vi.fn>;
  updateProfile: ReturnType<typeof vi.fn>;
};

function fakeAccountReadModel(): FakeReadModel {
  return {
    getAccount: vi.fn(async (userId: string) => accountView({ userId })),
    updateProfile: vi.fn(async (userId: string, changes: ProfileChanges) =>
      accountView({
        userId,
        displayName: changes.displayName ?? null,
        avatarPath: changes.avatarPath ?? null,
      }),
    ),
  } as unknown as FakeReadModel;
}

type Harness = {
  app: FastifyInstance;
  readModel: FakeReadModel;
  deleteAccount: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
};

async function harness(
  options: { deleteSucceeds?: boolean; verify?: TokenVerifier; describeToken?: boolean } = {},
): Promise<Harness> {
  const { buildServer } = await import('../src/server');

  const readModel = fakeAccountReadModel();
  const deleteAccount = vi.fn(async () => options.deleteSucceeds ?? true);
  // Defaults to accepting, and resolving to a specific user, so the tests that
  // care about identity are asserting on the id rather than on the auth path.
  const verify = vi.fn(async () => ({ id: USER_ID, email: 'ada@example.com' }));

  const app = await buildServer({
    probeDatabase: async () => {},
    accountReadModel: readModel,
    deleteAccount,
    verifyToken: (options.verify ?? verify) as TokenVerifier,
  });
  built.push(app);

  return { app, readModel, deleteAccount, verify };
}

describe('GET /api/v1/me', () => {
  it('refuses an unauthenticated request', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/v1/me' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: 'unauthorized' });
  });

  it('returns the account belonging to the verified token', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: accountView({ userId: USER_ID }) });
    // Identity comes from the token, not from anything the caller sent. Asserting
    // the argument is what pins that.
    expect(readModel.getAccount).toHaveBeenCalledWith(USER_ID);
  });

  it('describes an account with no profile row rather than failing', async () => {
    // A user who signed up and set nothing is a valid account: the profile row is
    // created lazily, so absent timestamps and names are the expected shape.
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: AUTH });

    expect(response.statusCode).toBe(200);
    expect(response.json().data).toMatchObject({
      displayName: null,
      avatarPath: null,
      createdAt: null,
    });
  });

  it('forbids caching account data', async () => {
    const { app } = await harness();
    const response = await app.inject({ method: 'GET', url: '/api/v1/me', headers: AUTH });

    expect(response.headers['cache-control']).toBe('no-store');
  });
});

describe('PATCH /api/v1/me', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      payload: { displayName: 'Ada' },
    });

    expect(response.statusCode).toBe(401);
    expect(readModel.updateProfile).not.toHaveBeenCalled();
  });

  it('sets a display name', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { displayName: 'Ada' },
    });

    expect(response.statusCode).toBe(200);
    expect(readModel.updateProfile).toHaveBeenCalledWith(USER_ID, { displayName: 'Ada' });
  });

  it('trims surrounding whitespace', async () => {
    const { app, readModel } = await harness();
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { displayName: '  Ada  ' },
    });

    expect(readModel.updateProfile).toHaveBeenCalledWith(USER_ID, { displayName: 'Ada' });
  });

  it('ignores an identity supplied in the body', async () => {
    // The whole point of reading identity from the token: a caller cannot name
    // the account they are editing. `userId` is not a field of the schema, so it
    // is stripped rather than rejected.
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { userId: OTHER_ID, displayName: 'Ada' },
    });

    expect(response.statusCode).toBe(200);
    expect(readModel.updateProfile).toHaveBeenCalledWith(USER_ID, { displayName: 'Ada' });
  });

  it('clears a display name when explicitly null', async () => {
    // Absent and null mean different things: absent leaves the value alone, null
    // removes it. Collapsing them would make clearing impossible.
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { displayName: null },
    });

    expect(response.statusCode).toBe(200);
    expect(readModel.updateProfile).toHaveBeenCalledWith(USER_ID, { displayName: null });
  });

  it('does not write a field the caller did not mention', async () => {
    const { app, readModel } = await harness();
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { avatarPath: 'users/abc/avatar/x.webp' },
    });

    expect(readModel.updateProfile).toHaveBeenCalledWith(USER_ID, {
      avatarPath: 'users/abc/avatar/x.webp',
    });
  });

  it('rejects an empty body', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe('invalid_request');
    expect(readModel.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects a blank display name', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { displayName: '   ' },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an overlong display name', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { displayName: 'a'.repeat(81) },
    });

    expect(response.statusCode).toBe(400);
  });

  it('rejects an avatar path that escapes its own prefix', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { avatarPath: '../../other-user/avatar.webp' },
    });

    expect(response.statusCode).toBe(400);
    expect(readModel.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects an absolute avatar path', async () => {
    const { app } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { avatarPath: '/etc/passwd' },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe('DELETE /api/v1/me', () => {
  it('refuses an unauthenticated request', async () => {
    const { app, deleteAccount } = await harness();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      payload: { confirm: 'DELETE' },
    });

    expect(response.statusCode).toBe(401);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('refuses a request without the confirmation value', async () => {
    // The speed bump: a mistyped method or a reused fetch must not be able to
    // delete an account irreversibly.
    const { app, deleteAccount } = await harness();
    const response = await app.inject({ method: 'DELETE', url: '/api/v1/me', headers: AUTH });

    expect(response.statusCode).toBe(400);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('refuses a request with the wrong confirmation value', async () => {
    const { app, deleteAccount } = await harness();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { confirm: 'delete' },
    });

    expect(response.statusCode).toBe(400);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('deletes the account belonging to the verified token', async () => {
    const { app, deleteAccount } = await harness();
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { confirm: 'DELETE' },
    });

    expect(response.statusCode).toBe(204);
    expect(deleteAccount).toHaveBeenCalledWith(USER_ID);
  });

  it('reports a provider failure distinctly from a rejection', async () => {
    const { app } = await harness({ deleteSucceeds: false });
    const response = await app.inject({
      method: 'DELETE',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { confirm: 'DELETE' },
    });

    // 502, not 401: the caller is authenticated and a retry may succeed.
    expect(response.statusCode).toBe(502);
    expect(response.json()).toEqual({ error: 'account_deletion_failed' });
  });
});
