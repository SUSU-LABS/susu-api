import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { GroupReadModel, MemberActivityRecord } from '../src/db/groups';
import type { AccountReadModel, AccountView, ProfileChanges } from '../src/db/me';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

const USER_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_ID = '22222222-2222-2222-2222-222222222222';
const WALLET = 'GDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
const OTHER_WALLET = 'GEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';
const GROUP = 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

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

function fakeAccountReadModel(walletAddress: string | null = null): FakeReadModel {
  return {
    getAccount: vi.fn(async (userId: string) => accountView({ userId, walletAddress })),
    updateProfile: vi.fn(async (userId: string, changes: ProfileChanges) =>
      accountView({
        userId,
        displayName: changes.displayName ?? null,
        avatarPath: changes.avatarPath ?? null,
      }),
    ),
  } as unknown as FakeReadModel;
}

type FakeGroupReadModel = {
  listMemberActivity: ReturnType<typeof vi.fn>;
  groupExists: ReturnType<typeof vi.fn>;
};

function fakeGroupReadModel(activity: readonly MemberActivityRecord[] = []): FakeGroupReadModel {
  return {
    listMemberActivity: vi.fn(async () => ({ items: activity, hasMore: false })),
    groupExists: vi.fn(async () => false),
  };
}

type Harness = {
  app: FastifyInstance;
  readModel: FakeReadModel;
  groups: FakeGroupReadModel;
  deleteAccount: ReturnType<typeof vi.fn>;
  verify: ReturnType<typeof vi.fn>;
};

async function harness(
  options: {
    deleteSucceeds?: boolean;
    verify?: TokenVerifier;
    describeToken?: boolean;
    walletAddress?: string | null;
    activity?: readonly MemberActivityRecord[];
  } = {},
): Promise<Harness> {
  const { buildServer } = await import('../src/server');

  const readModel = fakeAccountReadModel(options.walletAddress ?? null);
  const groups = fakeGroupReadModel(options.activity);
  const deleteAccount = vi.fn(async () => options.deleteSucceeds ?? true);
  // Defaults to accepting, and resolving to a specific user, so the tests that
  // care about identity are asserting on the id rather than on the auth path.
  const verify = vi.fn(async () => ({ id: USER_ID, email: 'ada@example.com' }));

  const app = await buildServer({
    probeDatabase: async () => {},
    accountReadModel: readModel,
    readModel: groups as unknown as GroupReadModel,
    deleteAccount,
    verifyToken: (options.verify ?? verify) as TokenVerifier,
  });
  built.push(app);

  return { app, readModel, groups, deleteAccount, verify };
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

describe('GET /api/v1/me/activity', () => {
  const event = (overrides: Partial<MemberActivityRecord> = {}): MemberActivityRecord => ({
    contractId: GROUP,
    eventIdentity: 'evt-1',
    name: 'contribution_made',
    ledger: 42,
    txIndex: 0,
    eventIndex: 0,
    txHash: 'a'.repeat(64),
    payload: { amount: '5000000' },
    ...overrides,
  });

  it('refuses an unauthenticated request without reading anything', async () => {
    const { app, groups } = await harness({ walletAddress: WALLET });

    const response = await app.inject({ method: 'GET', url: '/api/v1/me/activity' });

    expect(response.statusCode).toBe(401);
    expect(groups.listMemberActivity).not.toHaveBeenCalled();
  });

  it('reads the feed for the wallet the token is linked to', async () => {
    const { app, groups } = await harness({ walletAddress: WALLET });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    // The address comes from the account model, which is keyed by the verified
    // token's subject — never from a parameter the caller controls.
    expect(groups.listMemberActivity).toHaveBeenCalledWith(WALLET, { limit: 20, offset: 0 });
  });

  it('ignores an address supplied in the query string', async () => {
    const { app, groups } = await harness({ walletAddress: WALLET });

    await app.inject({
      method: 'GET',
      url: `/api/v1/me/activity?member=${OTHER_WALLET}&address=${OTHER_WALLET}`,
      headers: AUTH,
    });

    expect(groups.listMemberActivity).toHaveBeenCalledWith(WALLET, expect.anything());
  });

  it('answers an account with no linked wallet with an empty feed', async () => {
    // Membership is by wallet, so an unlinked account is in no group. That is an
    // answer, not a failure: the client reads `walletAddress` from GET /me to
    // explain it, rather than translating an error it did not need.
    const { app, groups } = await harness({ walletAddress: null });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      data: [],
      page: { limit: 20, offset: 0, hasMore: false },
    });
    expect(groups.listMemberActivity).not.toHaveBeenCalled();
  });

  it('returns events with the group they came from', async () => {
    const { app } = await harness({ walletAddress: WALLET, activity: [event()] });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: AUTH,
    });

    expect(response.json().data).toEqual([event()]);
  });

  it('passes paging through and reports it', async () => {
    const { app, groups } = await harness({ walletAddress: WALLET });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?limit=5&offset=10',
      headers: AUTH,
    });

    expect(groups.listMemberActivity).toHaveBeenCalledWith(WALLET, { limit: 5, offset: 10 });
    expect(response.json().page).toEqual({ limit: 5, offset: 10, hasMore: false });
  });

  it('refuses a page size beyond the ceiling', async () => {
    const { app, groups } = await harness({ walletAddress: WALLET });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/activity?limit=1000',
      headers: AUTH,
    });

    expect(response.statusCode).toBe(400);
    expect(groups.listMemberActivity).not.toHaveBeenCalled();
  });

  it('forbids caching a feed that depends on who is asking', async () => {
    const { app } = await harness({ walletAddress: WALLET });

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/me/activity',
      headers: AUTH,
    });

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
    const path = `users/${USER_ID}/avatar/${'a'.repeat(32)}.png`;
    await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { avatarPath: path },
    });

    expect(readModel.updateProfile).toHaveBeenCalledWith(USER_ID, {
      avatarPath: path,
    });
  });

  it('rejects an avatar path that does not match the caller-shaped constraint', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { avatarPath: 'users/abc/avatar/x.webp' },
    });

    // users/abc/... can never satisfy the DB shape for this caller, so the
    // route refuses it: the constraint is never the first line of refusal.
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details: { path: string }[] };
    expect(body.error).toBe('invalid_request');
    expect(body.details[0]?.path).toBe('avatarPath');
    expect(readModel.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects an avatar path shaped for a different user', async () => {
    const { app, readModel } = await harness();
    const response = await app.inject({
      method: 'PATCH',
      url: '/api/v1/me',
      headers: AUTH,
      payload: { avatarPath: `users/${OTHER_ID}/avatar/${'b'.repeat(32)}.png` },
    });

    expect(response.statusCode).toBe(400);
    expect(readModel.updateProfile).not.toHaveBeenCalled();
  });

  it('rejects an avatar path with a bad hash or extension', async () => {
    const { app } = await harness();
    for (const bad of [
      `users/${USER_ID}/avatar/${'z'.repeat(32)}.png`, // not hex
      `users/${USER_ID}/avatar/${'c'.repeat(31)}.png`, // short hash
      `users/${USER_ID}/avatar/${'c'.repeat(32)}.gif`, // bad extension
      `users/${USER_ID}/avatar/${'c'.repeat(32)}.PNG`, // uppercase extension
    ]) {
      const response = await app.inject({
        method: 'PATCH',
        url: '/api/v1/me',
        headers: AUTH,
        payload: { avatarPath: bad },
      });
      expect(response.statusCode).toBe(400);
    }
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
