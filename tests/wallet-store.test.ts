import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk/base';
import { createWalletLinkStore, type WalletLinkStore } from '../src/db/wallet';
import { createTestDb, type TestDb } from './support/pglite';

/**
 * The wallet-link store against a real Postgres.
 *
 * The route tests inject a fake store, which is the right seam for testing
 * HTTP behaviour and the wrong one for testing this store. The two facts this
 * file exists to check are both decided by the database, not by the code
 * around it: single use is an insert that cannot succeed twice, and "one
 * address, one account" is a unique index. A fake store would reimplement
 * those decisions instead of observing them.
 *
 * The address-taken case is the sharpest one: the store maps the literal
 * constraint name `wallet_links_address_unique` and SQLSTATE `23505` to the
 * `address_taken` outcome. If a migration renamed that constraint, the
 * mapping would silently stop matching and "address taken" would become a
 * 500. The test below asserts the `address_taken` outcome through the real
 * constraint, so a rename turns it red.
 */

let testDb: TestDb;
let store: WalletLinkStore;

beforeAll(async () => {
  testDb = await createTestDb();
  store = createWalletLinkStore(testDb.db);
});

afterAll(async () => {
  await testDb.close();
});

/**
 * A distinct user per fixture.
 *
 * Valid uuid shape so the columns accept it, and version 4 in the third group so
 * nothing that validates versions rejects it either. Created in `auth.users`
 * because `wallet_links.user_id` has a foreign key there.
 */
let userCounter = 0;
async function nextUser(): Promise<string> {
  userCounter += 1;
  const userId = `${String(userCounter).padStart(8, '0')}-0000-4000-8000-000000000000`;
  await testDb.createUser(userId);
  return userId;
}

let nonceCounter = 0;
/** A distinct nonce id per fixture, shaped like the real issuer's base64url ids. */
function nextJti(): string {
  nonceCounter += 1;
  return `test-nonce-${String(nonceCounter).padStart(8, '0')}`;
}

function nextAddress(): string {
  return Keypair.random().publicKey();
}

const FUTURE = new Date(Date.now() + 365 * 86400000);
const PAST = new Date('2020-01-01T00:00:00.000Z');
const NOW = new Date();

describe('consumeNonce', () => {
  it('returns true the first time and false on replay', async () => {
    const userId = await nextUser();
    const jti = nextJti();

    expect(await store.consumeNonce({ jti, userId, expiresAt: FUTURE })).toBe(true);
    expect(await store.consumeNonce({ jti, userId, expiresAt: FUTURE })).toBe(false);
  });

  it('treats different jtis independently', async () => {
    const userId = await nextUser();

    expect(await store.consumeNonce({ jti: nextJti(), userId, expiresAt: FUTURE })).toBe(true);
    expect(await store.consumeNonce({ jti: nextJti(), userId, expiresAt: FUTURE })).toBe(true);
  });
});

describe('link', () => {
  it('links an address and findAddress returns it', async () => {
    const userId = await nextUser();
    const address = nextAddress();

    expect(await store.link({ userId, address })).toEqual({ outcome: 'linked' });
    expect(await store.findAddress(userId)).toBe(address);
  });

  it('reports address_taken through the real unique constraint', async () => {
    const holder = await nextUser();
    const contender = await nextUser();
    const address = nextAddress();

    expect(await store.link({ userId: holder, address })).toEqual({ outcome: 'linked' });
    // This is the assertion that pins the constraint name: the store only
    // returns `address_taken` when the database error carries SQLSTATE 23505
    // *and* the literal constraint name `wallet_links_address_unique`. If a
    // migration renamed the constraint, this call would throw instead.
    expect(await store.link({ userId: contender, address })).toEqual({
      outcome: 'address_taken',
    });

    // The failed link changes nothing: the holder keeps the address and the
    // contender has none.
    expect(await store.findAddress(holder)).toBe(address);
    expect(await store.findAddress(contender)).toBeUndefined();
  });

  it('re-linking replaces the address for the same account', async () => {
    const userId = await nextUser();
    const other = await nextUser();
    const first = nextAddress();
    const second = nextAddress();

    expect(await store.link({ userId, address: first })).toEqual({ outcome: 'linked' });
    expect(await store.link({ userId, address: second })).toEqual({ outcome: 'linked' });
    expect(await store.findAddress(userId)).toBe(second);

    // The old address is freed: someone else can now take it.
    expect(await store.link({ userId: other, address: first })).toEqual({
      outcome: 'linked',
    });
  });
});

describe('reap', () => {
  it('deletes only expired nonces and reports the count', async () => {
    const userId = await nextUser();
    const expired = nextJti();
    const fresh = nextJti();

    expect(await store.consumeNonce({ jti: expired, userId, expiresAt: PAST })).toBe(true);
    expect(await store.consumeNonce({ jti: fresh, userId, expiresAt: FUTURE })).toBe(true);

    expect(await store.reap(NOW)).toBe(1);

    const { rows } = await testDb.query(
      'select jti from wallet_link_nonces where jti in ($1, $2)',
      [expired, fresh],
    );
    expect(rows.map((row) => row['jti']).sort()).toEqual([fresh]);

    // The surviving nonce is still single-use: it was not reaped.
    expect(await store.consumeNonce({ jti: fresh, userId, expiresAt: FUTURE })).toBe(false);
  });
});
