import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { createTestDb, closeTestDb } from "./utils/db.ts";
import {
  createWalletLinkStore,
  type WalletLinkStore,
} from "../src/db/wallet.ts";

describe("WalletLinkStore (real Postgres)", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>;
  let store: WalletLinkStore;

  beforeEach(async () => {
    db = await createTestDb();
    store = createWalletLinkStore(db);
  });

  afterEach(async () => {
    await closeTestDb(db);
  });

  // ---- consumeNonce / nonce single-use -----------------------------------

  describe("consumeNonce", () => {
    it("returns true on first consumption and false on second (single-use)", async () => {
      const nonce = "nonce-single-use-test";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonce})`;

      assert.equal(await store.consumeNonce(nonce), true);
      // A second consume must fail — the row is consumed.
      assert.equal(await store.consumeNonce(nonce), false);
    });

    it("returns false when the nonce does not exist", async () => {
      assert.equal(await store.consumeNonce("nonexistent-nonce"), false);
    });
  });

  // ---- link / address_taken constraint -----------------------------------

  describe("link", () => {
    it("succeeds for a fresh address and nonce", async () => {
      const address = "0x1111111111111111111111111111111111111111";
      const wallet = "wallet-fresh";
      const nonce = "nonce-link-fresh";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonce})`;

      const result = await store.link({ address, wallet, nonce });
      assert.ok(result);
      assert.equal(result.address, address);
      assert.equal(result.wallet, wallet);
    });

    it("throws when the address is already taken (SQLSTATE 23505)", async () => {
      const address = "0x2222222222222222222222222222222222222222";
      const walletA = "wallet-a";
      const nonceA = "nonce-link-taken-a";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonceA})`;
      await store.link({ address, wallet: walletA, nonce: nonceA });

      const walletB = "wallet-b";
      const nonceB = "nonce-link-taken-b";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonceB})`;

      // The second link with the same address must hit the unique constraint
      // named `wallet_links_address_unique` and surface SQLSTATE 23505.
      await assert.rejects(
        async () =>
          store.link({ address, wallet: walletB, nonce: nonceB }),
        (err: { code?: string }) => {
          assert.equal(err?.code, "23505");
          return true;
        }
      );
    });
  });

  // ---- re-link replacement -----------------------------------------------

  describe("re-link replacement", () => {
    it("allows re-linking when the old link is expired first", async () => {
      const address = "0x3333333333333333333333333333333333333333";
      const walletOld = "wallet-old";
      const nonceOld = "nonce-relink-old";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonceOld})`;
      await store.link({ address, wallet: walletOld, nonce: nonceOld });

      // Expire the old link so reap can clean it up.
      await db`UPDATE wallet_links SET expires_at = NOW() - INTERVAL '1 day' WHERE address = ${address}`;
      await store.reap();

      const walletNew = "wallet-new";
      const nonceNew = "nonce-relink-new";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonceNew})`;

      // After reaping, the address is free again.
      const result = await store.link({ address, wallet: walletNew, nonce: nonceNew });
      assert.equal(result.wallet, walletNew);
    });
  });

  // ---- reap by expiry ----------------------------------------------------

  describe("reap", () => {
    it("removes links whose expires_at is in the past", async () => {
      const now = new Date();
      const future = new Date(now.getTime() + 60_000); // 1 min ahead

      // Insert a link that is still valid.
      const addressValid = "0x4444444444444444444444444444444444444444";
      const walletValid = "wallet-valid";
      const nonceValid = "nonce-reap-valid";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonceValid})`;
      await store.link({ address: addressValid, wallet: walletValid, nonce: nonceValid });

      // Insert a link whose expiry has already passed.
      const addressExpired = "0x5555555555555555555555555555555555555555";
      const walletExpired = "wallet-expired";
      const nonceExpired = "nonce-reap-expired";
      await db`INSERT INTO wallet_link_nonces (nonce) VALUES (${nonceExpired})`;
      await store.link({ address: addressExpired, wallet: walletExpired, nonce: nonceExpired });
      await db`UPDATE wallet_links SET expires_at = NOW() - INTERVAL '1 day' WHERE address = ${addressExpired}`;

      await store.reap();

      // The valid link should remain.
      const rowsAfter = await db`SELECT * FROM wallet_links`;
      const remaining = rowsAfter.filter((r: { address: string }) => r.address === addressValid);
      assert.equal(remaining.length, 1);

      // The expired link should have been removed.
      const gone = rowsAfter.find((r: { address: string }) => r.address === addressExpired);
      assert.equal(gone, undefined);
    });
  });
});
