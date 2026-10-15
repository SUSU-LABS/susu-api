import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGroupReadModel } from '../src/db/groups';
import { createTestDb, type TestDb } from './support/pglite';

/**
 * `getGroup`'s per-round payout/recipient/fee lookups, against a real Postgres.
 *
 * The lookups are scalar subqueries over `payouts` / `protocol_fees`, which
 * carry a `unique (contract_id, round)` — but a re-org, a retried ingest, or a
 * partial re-index can still land two rows for one round (the constraint is
 * what the indexer *intends*, not what the database guarantees under every
 * failure mode). Before the fix, the second row turned the subquery into
 * `more than one row returned by a subquery used as an expression` and
 * `GET /groups/:contractId` into a 500. The fix picks the row from the
 * highest ledger deterministically: the latest chain state wins.
 */

const GROUP = `C${'G'.repeat(55)}`;
const FACTORY = `C${'F'.repeat(55)}`;
const CREATOR = `G${'C'.repeat(55)}`;
const TOKEN = `C${'T'.repeat(55)}`;
const ALICE = `G${'A'.repeat(55)}`;
const BOB = `G${'B'.repeat(55)}`;

let test: TestDb;

beforeAll(async () => {
  test = await createTestDb();
  // Tables owned by susu-indexer, copied minimally: only the columns
  // `getGroup` reads. The real DDL lives in the indexer's
  // `20260816000000_chain_derived.sql`.
  await test.exec(`
    create table if not exists public.contributions (
      event_identity text primary key,
      contract_id text not null references public.groups (contract_id) on delete cascade,
      contributor text not null,
      round integer not null check (round > 0),
      amount numeric(39,0) not null check (amount > 0),
      ledger bigint not null check (ledger >= 0),
      tx_hash text not null
    );
    create table if not exists public.payouts (
      event_identity text primary key,
      contract_id text not null references public.groups (contract_id) on delete cascade,
      recipient text not null,
      round integer not null check (round > 0),
      recipient_amount numeric(39,0) not null check (recipient_amount > 0),
      ledger bigint not null check (ledger >= 0),
      tx_hash text not null
    );
    create table if not exists public.protocol_fees (
      event_identity text primary key,
      contract_id text not null references public.groups (contract_id) on delete cascade,
      treasury text not null,
      round integer not null check (round > 0),
      fee numeric(39,0) not null check (fee >= 0),
      ledger bigint not null check (ledger >= 0),
      tx_hash text not null
    );
  `);
});

afterAll(async () => {
  await test.close();
});

beforeEach(async () => {
  await test.exec(`
    delete from public.protocol_fees;
    delete from public.payouts;
    delete from public.contributions;
    delete from public.groups;
  `);
  await test.query(
    `insert into public.groups
      (contract_id, factory_contract_id, group_id, creator, token,
       contribution_amount, member_capacity, created_ledger, status,
       member_count, current_round, completed_rounds,
       contributed_total, paid_out_total, fee_total, last_event_ledger)
     values ($1, $2, 1, $3, $4, 100000000, 3, 100, 'active', 2, 1, 0, 200000000, 0, 0, 120)`,
    [GROUP, FACTORY, CREATOR, TOKEN],
  );
});

async function seedContribution(round: number, amount: string, ledger: number) {
  await test.query(
    `insert into public.contributions
       (event_identity, contract_id, contributor, round, amount, ledger, tx_hash)
     values ($1, $2, $3, $4, $5, $6, 'tx')`,
    [`c-${round}-${ledger}`, GROUP, ALICE, round, amount, ledger],
  );
}

async function seedPayout(
  round: number,
  recipient: string,
  amount: string,
  ledger: number,
  tag = '',
) {
  await test.query(
    `insert into public.payouts
       (event_identity, contract_id, recipient, round, recipient_amount, ledger, tx_hash)
     values ($1, $2, $3, $4, $5, $6, 'tx')`,
    [`p-${round}-${ledger}${tag}`, GROUP, recipient, round, amount, ledger],
  );
}

async function seedFee(round: number, fee: string, ledger: number) {
  await test.query(
    `insert into public.protocol_fees
       (event_identity, contract_id, treasury, round, fee, ledger, tx_hash)
     values ($1, $2, $3, $4, $5, $6, 'tx')`,
    [`f-${round}-${ledger}`, GROUP, `G${'T'.repeat(55)}`, round, fee, ledger],
  );
}

describe('getGroup with duplicate payout rows for one round', () => {
  it('returns 200-shaped data with the latest-ledger row winning', async () => {
    await seedContribution(1, '100000000', 110);
    // A re-org replays the round at a higher ledger with a different amount.
    await seedPayout(1, ALICE, '90000000', 115);
    await seedPayout(1, BOB, '95000000', 120);
    await seedFee(1, '5000000', 115);
    await seedFee(1, '4000000', 120);

    const group = await createGroupReadModel(test.db).getGroup(GROUP);

    expect(group).toBeDefined();
    expect(group!.rounds).toHaveLength(1);
    const round = group!.rounds[0]!;
    // Deterministic: the highest ledger wins, and payout/recipient/fee all
    // come from that same row — not max() of each column independently.
    expect(round.payout).toBe('95000000');
    expect(round.recipient).toBe(BOB);
    expect(round.fee).toBe('4000000');
  });

  it('breaks ledger ties deterministically from the same row', async () => {
    await seedContribution(1, '100000000', 110);
    // Two rows at the SAME ledger: `ledger desc` alone cannot decide, so the
    // tiebreaker (event_identity desc) picks one row and payout/recipient
    // must come from that same row, not be mixed across rows.
    // 'p-1-115-b' > 'p-1-115-a', so BOB's row wins the tiebreaker.
    await seedPayout(1, ALICE, '90000000', 115, '-a');
    await seedPayout(1, BOB, '95000000', 115, '-b');

    const group = await createGroupReadModel(test.db).getGroup(GROUP);

    expect(group).toBeDefined();
    expect(group!.rounds).toHaveLength(1);
    const round = group!.rounds[0]!;
    expect(round.payout).toBe('95000000');
    expect(round.recipient).toBe(BOB);
  });

  it('keeps the single-row shape unchanged', async () => {
    await seedContribution(1, '100000000', 110);
    await seedPayout(1, ALICE, '90000000', 115);
    await seedFee(1, '5000000', 115);

    const group = await createGroupReadModel(test.db).getGroup(GROUP);

    expect(group).toBeDefined();
    expect(group!.rounds).toHaveLength(1);
    const round = group!.rounds[0]!;
    expect(round.payout).toBe('90000000');
    expect(round.recipient).toBe(ALICE);
    expect(round.fee).toBe('5000000');
    expect(round.contributed).toBe('100000000');
    expect(round.contributionCount).toBe(1);
  });

  it('returns null payout/fee for a round with contributions only', async () => {
    await seedContribution(1, '100000000', 110);

    const group = await createGroupReadModel(test.db).getGroup(GROUP);

    expect(group).toBeDefined();
    expect(group!.rounds).toHaveLength(1);
    expect(group!.rounds[0]!.payout).toBeNull();
    expect(group!.rounds[0]!.recipient).toBeNull();
    expect(group!.rounds[0]!.fee).toBeNull();
  });
});
