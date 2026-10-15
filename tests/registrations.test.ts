import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createRegistrationStore,
  MAX_LIVE_REGISTRATIONS,
  REGISTRATION_TTL_MS,
  type RegistrationStore,
} from '../src/db/registrations';
import { createTestDb, type TestDb } from './support/pglite';
import { GROUP_CONTRACT_ID, OTHER_CONTRACT_ID } from './support/fixtures';

/**
 * The registration store against a real Postgres.
 *
 * What is worth testing here is the expiry and the cap, because both are the kind
 * of predicate that is easy to write and easy to get subtly wrong — `>` instead of
 * `>=`, comparing a timestamp against a client clock rather than the database's —
 * and either mistake produces a claim that outlives the window it was meant to
 * cover, which is the one property this table exists to have.
 */

const USER_ONE = '11111111-1111-1111-1111-111111111111';
const USER_TWO = '22222222-2222-2222-2222-222222222222';

/**
 * A contract-shaped address, distinct per index and inside the base32 alphabet.
 *
 * The base32 alphabet has no `0` or `1`, so an address built from digits is
 * refused by the constraint the store writes against — which is the constraint
 * working, but not what these tests are about.
 */
function distinctContractId(index: number): string {
  return `C${String.fromCharCode(68 + index)}${'A'.repeat(54)}`;
}

let testDb: TestDb;
let store: RegistrationStore;

beforeAll(async () => {
  testDb = await createTestDb();
  await testDb.createUser(USER_ONE);
  await testDb.createUser(USER_TWO);
  store = createRegistrationStore(testDb.db);
});

beforeEach(async () => {
  // Claims only. The users stay: `auth.users` is owned by Supabase, the
  // migrations cascade from it, and re-creating two fixed uuids per test would
  // collide with the rows the previous test left.
  await testDb.exec('delete from public.group_registrations');
});

afterAll(async () => {
  await testDb?.close();
});

describe('createRegistrationStore.register', () => {
  it('makes an address known', async () => {
    const result = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });

    expect(result.outcome).toBe('registered');
    expect(await store.isRegistered(GROUP_CONTRACT_ID)).toBe(true);
  });

  it('does not make a different address known', async () => {
    await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });

    expect(await store.isRegistered(OTHER_CONTRACT_ID)).toBe(false);
  });

  it('reports an expiry within the window it documents', async () => {
    const before = Date.now();
    const result = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });

    if (result.outcome !== 'registered') throw new Error('expected a registration');
    const expiresAt = new Date(result.expiresAt).getTime();

    // The window is a range rather than an instant: the database sets `created_at`
    // and the client computes `expires_at`, so a test asserting an exact value
    // would be asserting the two clocks agree to the millisecond.
    expect(expiresAt).toBeGreaterThanOrEqual(before + REGISTRATION_TTL_MS - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(before + REGISTRATION_TTL_MS + 5_000);
  });

  it('is idempotent for the account that made the claim, and extends it', async () => {
    const first = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });
    const second = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });

    if (first.outcome !== 'registered' || second.outcome !== 'registered') {
      throw new Error('expected registrations');
    }

    // Registering again is a refresh, not a refusal: a creator who registers the
    // same group twice has done nothing wrong, and the answer they need is that it
    // is known.
    expect(new Date(second.expiresAt).getTime()).toBeGreaterThanOrEqual(
      new Date(first.expiresAt).getTime(),
    );

    const rows = await testDb.query(
      'select count(*)::int as count from public.group_registrations',
    );
    expect(rows.rows[0]?.['count']).toBe(1);
  });

  it('does not let a second account take over a claim or extend it', async () => {
    const first = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });
    const second = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_TWO });

    if (first.outcome !== 'registered' || second.outcome !== 'registered') {
      throw new Error('expected registrations');
    }

    // The address stays claimed by the first account, with the first expiry. A
    // second account is told the address is registered — which is true, and is the
    // answer the caller wanted — without gaining the claim.
    const rows = await testDb.query(
      'select registered_by, expires_at from public.group_registrations where contract_id = $1',
      [GROUP_CONTRACT_ID],
    );

    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]?.['registered_by']).toBe(USER_ONE);
    expect(new Date(rows.rows[0]?.['expires_at'] as string).getTime()).toBe(
      new Date(first.expiresAt).getTime(),
    );
    expect(new Date(second.expiresAt).getTime()).toBe(new Date(first.expiresAt).getTime());
  });

  it('stops believing a claim once it has expired', async () => {
    await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });

    // Moved into the past rather than waiting 30 minutes. `isRegistered` compares
    // against the database's `now()`, which is the same clock that set the value,
    // so this is the expiry path and not a client/server clock disagreement.
    await testDb.query(
      "update public.group_registrations set created_at = now() - interval '2 hours', expires_at = now() - interval '90 minutes'",
    );

    expect(await store.isRegistered(GROUP_CONTRACT_ID)).toBe(false);

    // And the row is still there, because expiry is a predicate and not a delete.
    // The index is the only thing that makes a group durable; nothing has to run
    // for a claim to stop counting.
    const rows = await testDb.query(
      'select count(*)::int as count from public.group_registrations',
    );
    expect(rows.rows[0]?.['count']).toBe(1);
  });

  it('refuses to let one account hold more than the cap at once', async () => {
    for (let index = 0; index < MAX_LIVE_REGISTRATIONS; index += 1) {
      const result = await store.register({
        contractId: distinctContractId(index),
        userId: USER_ONE,
      });
      expect(result.outcome).toBe('registered');
    }

    const overCap = await store.register({ contractId: OTHER_CONTRACT_ID, userId: USER_ONE });
    expect(overCap.outcome).toBe('too_many');

    // A different account is unaffected: the cap is per account, and every actor
    // has the same small allowance.
    const other = await store.register({ contractId: OTHER_CONTRACT_ID, userId: USER_TWO });
    expect(other.outcome).toBe('registered');
  });

  it('does not count an expired claim against the cap', async () => {
    for (let index = 0; index < MAX_LIVE_REGISTRATIONS; index += 1) {
      await store.register({ contractId: distinctContractId(index), userId: USER_ONE });
    }

    await testDb.query(
      "update public.group_registrations set created_at = now() - interval '2 hours', expires_at = now() - interval '90 minutes'",
    );

    // The account is at the cap only in the sense that rows exist; every claim has
    // lapsed, so there is nothing being held open and another is allowed.
    const result = await store.register({ contractId: OTHER_CONTRACT_ID, userId: USER_ONE });
    expect(result.outcome).toBe('registered');
  });

  it('re-registering an address at the cap is still allowed', async () => {
    const contractId = distinctContractId(0);
    for (let index = 0; index < MAX_LIVE_REGISTRATIONS; index += 1) {
      await store.register({ contractId: distinctContractId(index), userId: USER_ONE });
    }

    // Already held by this account, so it replaces a claim rather than adding one.
    // Refusing here would be a bug the user hits by refreshing the page.
    const result = await store.register({ contractId, userId: USER_ONE });
    expect(result.outcome).toBe('registered');
  });

  it('two parallel registrations at the cap yield exactly one success and one too_many', async () => {
    for (let index = 0; index < MAX_LIVE_REGISTRATIONS - 1; index += 1) {
      const filled = await store.register({
        contractId: distinctContractId(index),
        userId: USER_ONE,
      });
      expect(filled.outcome).toBe('registered');
    }

    // The race this guards: without serialization both calls observe the same
    // live count (MAX - 1) and both insert, leaving MAX + 1 live claims.
    const [first, second] = await Promise.all([
      store.register({ contractId: distinctContractId(10), userId: USER_ONE }),
      store.register({ contractId: distinctContractId(11), userId: USER_ONE }),
    ]);

    expect([first.outcome, second.outcome].sort()).toEqual(['registered', 'too_many']);

    const rows = await testDb.query(
      'select count(*)::int as live from public.group_registrations where registered_by = $1 and expires_at > now()',
      [USER_ONE],
    );
    expect(rows.rows[0]?.['live']).toBe(MAX_LIVE_REGISTRATIONS);
  });

  it('is unaffected by application clock skew and satisfies positive window constraint', async () => {
    const realDateNow = Date.now;
    try {
      // Skew the application clock backwards by 2 hours (which with client-clock expiry
      // would produce expires_at < created_at, violating `expires_at > created_at`)
      Date.now = () => realDateNow() - 2 * 60 * 60 * 1000;

      const result = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });
      expect(result.outcome).toBe('registered');
      if (result.outcome !== 'registered') throw new Error('expected registration');

      // Check database state directly
      const rows = await testDb.query(
        'select created_at, expires_at from public.group_registrations where contract_id = $1',
        [GROUP_CONTRACT_ID],
      );
      expect(rows.rows).toHaveLength(1);
      const createdAt = new Date(rows.rows[0]?.['created_at'] as string).getTime();
      const expiresAt = new Date(rows.rows[0]?.['expires_at'] as string).getTime();

      // Window is positive and derived from the single database clock source
      expect(expiresAt).toBeGreaterThan(createdAt);
      expect(expiresAt - createdAt).toBe(REGISTRATION_TTL_MS);

      // And isRegistered remains true
      expect(await store.isRegistered(GROUP_CONTRACT_ID)).toBe(true);
    } finally {
      Date.now = realDateNow;
    }
  });

  it('derives expiry from database clock even when application clock is shifted into the future', async () => {
    const realDateNow = Date.now;
    try {
      Date.now = () => realDateNow() + 10 * 60 * 60 * 1000;

      const result = await store.register({ contractId: GROUP_CONTRACT_ID, userId: USER_ONE });
      expect(result.outcome).toBe('registered');
      if (result.outcome !== 'registered') throw new Error('expected registration');

      const rows = await testDb.query(
        'select created_at, expires_at from public.group_registrations where contract_id = $1',
        [GROUP_CONTRACT_ID],
      );
      const createdAt = new Date(rows.rows[0]?.['created_at'] as string).getTime();
      const expiresAt = new Date(rows.rows[0]?.['expires_at'] as string).getTime();

      expect(expiresAt).toBeGreaterThan(createdAt);
      expect(expiresAt - createdAt).toBe(REGISTRATION_TTL_MS);
    } finally {
      Date.now = realDateNow;
    }
  });
});
