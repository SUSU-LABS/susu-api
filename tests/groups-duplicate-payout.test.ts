import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createGroupReadModel } from '../src/db/groups';
import { createTestDb, type TestDb } from './support/pglite';
import { GROUP_CONTRACT_ID, ACCOUNT_ADDRESS } from './support/fixtures';

/**
 * `getGroup` against a real Postgres, on the one failure the stub tests cannot
 * reach: a round that carries a duplicate payout (or fee) row.
 *
 * The existing `read-model.test.ts` fakes the database, so it passes whether or
 * *not* the SQL is correct — and it never produced "more than one row", which is
 * what a scalar subquery used as an expression turns into a hard Postgres error
 * (a 500) on the first duplicated payout. The indexer can emit that: a
 * rebroadcast event, or two fee rows for one round. This test seeds exactly that
 * shape in a real engine and checks that `getGroup` reports a defined value
 * instead of throwing.
 *
 * `groups`, `group_members`, `contributions`, `payouts` and `protocol_fees` are
 * owned by `susu-indexer`, so they are not in the migrations this harness runs.
 * They are created here with only the columns `getGroup` reads; the read model
 * never writes them, so the local definitions cannot drift into a write path.
 */

let testDb: TestDb;
let model: ReturnType<typeof createGroupReadModel>;

beforeAll(async () => {
  testDb = await createTestDb();
  model = createGroupReadModel(testDb.db);

  // `groups` and `group_members` already exist in the test shims (with their
  // real RLS posture and the extra `event_identity` / `discovered_at` /
  // `updated_at` columns). `contributions`, `payouts` and `protocol_fees` are
  // owned by `susu-indexer` and are not in the shims, so they are created here
  // with only the columns `getGroup` reads. The read model never writes any of
  // these, so the local definitions cannot drift into a write path.
  await testDb.exec(`
    create table public.contributions (
      event_identity text not null,
      contract_id text not null,
      round integer not null,
      member text not null,
      amount numeric(39,0) not null,
      ledger bigint not null,
      tx_hash text not null,
      primary key (event_identity)
    );
    create table public.payouts (
      event_identity text not null,
      contract_id text not null,
      round integer not null,
      recipient text not null,
      recipient_amount numeric(39,0) not null,
      ledger bigint not null,
      tx_hash text not null,
      primary key (event_identity)
    );
    create table public.protocol_fees (
      event_identity text not null,
      contract_id text not null,
      round integer not null,
      fee numeric(39,0) not null,
      ledger bigint not null,
      tx_hash text not null,
      primary key (event_identity)
    );
  `);
});

afterAll(async () => {
  await testDb.close();
});

/** Drops every row this test owns, so each case seeds a clean, independent shape. */
async function clean(): Promise<void> {
  await testDb.exec(`
    delete from public.protocol_fees where contract_id = '${GROUP_CONTRACT_ID}';
    delete from public.payouts where contract_id = '${GROUP_CONTRACT_ID}';
    delete from public.contributions where contract_id = '${GROUP_CONTRACT_ID}';
    delete from public.group_members where contract_id = '${GROUP_CONTRACT_ID}';
    delete from public.groups where contract_id = '${GROUP_CONTRACT_ID}';
  `);
}

async function seedGroup(): Promise<void> {
  await testDb.query(
    `insert into public.groups (
       contract_id, factory_contract_id, group_id, creator, token,
       contribution_amount, member_capacity, created_ledger, status,
       member_count, current_round, completed_rounds,
       contributed_total, paid_out_total, fee_total, last_event_ledger
     ) values (
       $1, $1, 1, $2, $2,
       1000000000, 8, 0, 'active',
       2, 1, 1,
       1000000000, 900000000, 10000000, 5
     )`,
    [GROUP_CONTRACT_ID, ACCOUNT_ADDRESS],
  );
  await testDb.query(
    `insert into public.group_members (
       contract_id, member, position, joined_ledger, event_identity
     ) values
       ($1, $2, 1, 1, $3),
       ($1, $4, 2, 2, $5)`,
    [
      GROUP_CONTRACT_ID,
      ACCOUNT_ADDRESS,
      `${GROUP_CONTRACT_ID}m1`,
      ACCOUNT_ADDRESS + '1',
      `${GROUP_CONTRACT_ID}m2`,
    ],
  );
  // Round 1 contributed by two members.
  await testDb.query(
    `insert into public.contributions
       (event_identity, contract_id, round, member, amount, ledger, tx_hash)
     values
       ($1, $1, 1, $2, 500000000, 2, $1),
       ($3, $1, 1, $4, 500000000, 3, $3)`,
    [GROUP_CONTRACT_ID, ACCOUNT_ADDRESS, `${GROUP_CONTRACT_ID}c1`, ACCOUNT_ADDRESS + '1'],
  );
}

describe('getGroup round amounts with duplicated payout/fee rows (issue #59)', () => {
  it('reports a defined payout instead of 500ing when a round has two payout rows', async () => {
    await clean();
    await seedGroup();

    // The bug shape: one round, two payout rows (a rebroadcast event), and a
    // second fee row. A scalar subquery used as an expression is a hard error
    // the moment this exists; `max()` collapses it to one defined value.
    await testDb.query(
      `insert into public.payouts
         (event_identity, contract_id, round, recipient, recipient_amount, ledger, tx_hash)
       values
         ($1, $1, 1, $2, 800000000, 4, $1),
         ($3, $1, 1, $2, 800000000, 5, $3)`,
      [GROUP_CONTRACT_ID, ACCOUNT_ADDRESS + '1', `${GROUP_CONTRACT_ID}p2`],
    );
    await testDb.query(
      `insert into public.protocol_fees
         (event_identity, contract_id, round, fee, ledger, tx_hash)
       values
         ($1, $1, 1, 10000000, 6, $1),
         ($2, $1, 1, 10000000, 7, $2)`,
      [GROUP_CONTRACT_ID, `${GROUP_CONTRACT_ID}f2`],
    );

    const group = await model.getGroup(GROUP_CONTRACT_ID);

    expect(group).not.toBeUndefined();
    const round1 = group!.rounds.find((r) => r.round === 1);
    expect(round1).toBeDefined();
    // Two payout rows of 800000000 -> a defined 800000000, not a throw.
    expect(round1!.payout).toBe('800000000');
    expect(round1!.recipient).toBe(ACCOUNT_ADDRESS + '1');
    // Two fee rows of 10000000 -> a defined 10000000, not a throw.
    expect(round1!.fee).toBe('10000000');
  });

  it('chooses the maximum when the duplicate rows disagree', async () => {
    await clean();
    await seedGroup();
    // The duplicate rows are now *different* amounts; the read must be
    // deterministic, which `max()` guarantees.
    await testDb.query(
      `insert into public.payouts
         (event_identity, contract_id, round, recipient, recipient_amount, ledger, tx_hash)
       values
         ($1, $1, 1, $2, 700000000, 8, $1),
         ($3, $1, 1, $2, 850000000, 9, $3)`,
      [GROUP_CONTRACT_ID, ACCOUNT_ADDRESS + '1', `${GROUP_CONTRACT_ID}hi`],
    );

    const group = await model.getGroup(GROUP_CONTRACT_ID);
    const round1 = group!.rounds.find((r) => r.round === 1);
    expect(round1!.payout).toBe('850000000');
  });

  it('proves the old scalar form is exactly what 500s on this data', async () => {
    // Seeds the duplicate shape itself, then shows a plain scalar subquery used
    // as an expression — the form the fix removed — is the exact Postgres error
    // that was the production 500. (The same rows fetched at the top level is
    // legal Postgres; the error is specific to a subquery standing in for a
    // single value, which is how the old query used it.)
    await clean();
    await seedGroup();
    await testDb.query(
      `insert into public.payouts
         (event_identity, contract_id, round, recipient, recipient_amount, ledger, tx_hash)
       values
         ($1, $1, 1, $2, 800000000, 1, $1),
         ($3, $1, 1, $2, 800000000, 2, $3)`,
      [GROUP_CONTRACT_ID, ACCOUNT_ADDRESS + '1', `${GROUP_CONTRACT_ID}dup`],
    );

    // The old shape: a scalar subquery as a selected expression.
    await expect(
      testDb.query(
        `select
           (select p.recipient_amount::text from public.payouts p
            where p.contract_id = $1 and p.round = 1) as payout`,
        [GROUP_CONTRACT_ID],
      ),
    ).rejects.toThrow(/more than one row/);

    // The same rows at the top level are fine — proving the failure is
    // specifically the subquery-as-expression form the fix eliminated.
    const topLevel = await testDb.query(
      `select recipient_amount::text as recipient_amount
       from public.payouts where contract_id = $1 and round = 1`,
      [GROUP_CONTRACT_ID],
    );
    expect(topLevel.rows).toHaveLength(2);
  });

  it('leaves a single-row round unchanged (happy path preserved)', async () => {
    await clean();
    await seedGroup();
    // Exactly one payout row, one fee row — the normal shape.
    await testDb.query(
      `insert into public.payouts
         (event_identity, contract_id, round, recipient, recipient_amount, ledger, tx_hash)
       values
         ($1, $1, 1, $2, 900000000, 10, $1)`,
      [GROUP_CONTRACT_ID, ACCOUNT_ADDRESS + '1'],
    );
    await testDb.query(
      `insert into public.protocol_fees
         (event_identity, contract_id, round, fee, ledger, tx_hash)
       values
         ($1, $1, 1, 12345678, 11, $1)`,
      [GROUP_CONTRACT_ID],
    );

    const group = await model.getGroup(GROUP_CONTRACT_ID);
    const round1 = group!.rounds.find((r) => r.round === 1);
    expect(round1!.payout).toBe('900000000');
    expect(round1!.recipient).toBe(ACCOUNT_ADDRESS + '1');
    expect(round1!.fee).toBe('12345678');
  });
});
