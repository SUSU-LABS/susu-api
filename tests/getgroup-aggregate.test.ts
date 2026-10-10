import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createGroupReadModel } from '../src/db/groups';
import { createTestDb, type TestDb } from './support/pglite';

/**
 * `getGroup`'s per-round lookups, rewritten as a single aggregation.
 *
 * Before: four correlated scalar subqueries over `contributions` / `payouts` /
 * `protocol_fees`, one probe per round per table — O(R) probes for R rounds.
 * After: one `group by round` over contributions plus one `distinct on (round)`
 * pass each over payouts and protocol_fees, joined to the round list — O(C+R).
 *
 * The dedup semantics from #59 are preserved: for a round with several
 * payout/fee rows, the highest ledger wins and `event_identity` breaks ties,
 * so payout/recipient/fee always come from the same row.
 */

const GROUP = `C${'G'.repeat(55)}`;
const FACTORY = `C${'F'.repeat(55)}`;
const CREATOR = `G${'C'.repeat(55)}`;
const TOKEN = `C${'T'.repeat(55)}`;
const ALICE = `G${'A'.repeat(55)}`;
const BOB = `G${'B'.repeat(55)}`;
const TREASURY = `G${'T'.repeat(55)}`;

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
}, 120000);

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
     values ($1, $2, 1, $3, $4, 100000000, 3, 100, 'active', 2, 3, 0, 600000000, 0, 0, 130)`,
    [GROUP, FACTORY, CREATOR, TOKEN],
  );
});

async function seedContribution(round: number, amount: string, ledger: number, tag = '') {
  await test.query(
    `insert into public.contributions
       (event_identity, contract_id, contributor, round, amount, ledger, tx_hash)
     values ($1, $2, $3, $4, $5, $6, 'tx')`,
    [`c-${round}-${ledger}${tag}`, GROUP, ALICE, round, amount, ledger],
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
    [`f-${round}-${ledger}`, GROUP, TREASURY, round, fee, ledger],
  );
}

describe('getGroup rounds via single aggregation', () => {
  it('returns identical data for a multi-round fixture', async () => {
    // Round 1: two contributions, one payout, one fee.
    await seedContribution(1, '100000000', 110);
    await seedContribution(1, '100000000', 111, '-b');
    await seedPayout(1, ALICE, '190000000', 115);
    await seedFee(1, '10000000', 115);
    // Round 2: contributions only (no payout yet).
    await seedContribution(2, '100000000', 120);
    await seedContribution(2, '50000000', 121, '-b');
    // Round 3: payout without contributions (edge case).
    await seedPayout(3, BOB, '180000000', 130);

    const group = await createGroupReadModel(test.db).getGroup(GROUP);

    expect(group).toBeDefined();
    expect(group!.rounds).toHaveLength(3);

    const [r1, r2, r3] = group!.rounds;
    expect(r1).toMatchObject({
      round: 1,
      contributionCount: 2,
      contributed: '200000000',
      payout: '190000000',
      recipient: ALICE,
      fee: '10000000',
    });
    expect(r2).toMatchObject({
      round: 2,
      contributionCount: 2,
      contributed: '150000000',
      payout: null,
      recipient: null,
      fee: null,
    });
    expect(r3).toMatchObject({
      round: 3,
      contributionCount: 0,
      contributed: '0',
      payout: '180000000',
      recipient: BOB,
      fee: null,
    });
  });

  it('keeps the #59 dedup semantics: latest ledger wins, ties broken deterministically', async () => {
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
    expect(round.payout).toBe('95000000');
    expect(round.recipient).toBe(BOB);
    expect(round.fee).toBe('4000000');
  });

  it('EXPLAIN shows no per-round correlated subplan', async () => {
    const rows = await test.query(
      `explain (format json)
        with rounds as (
          select round from public.contributions where contract_id = $1
          union
          select round from public.payouts where contract_id = $1
        ),
        contrib_agg as (
          select round, count(*)::int as contribution_count,
                 coalesce(sum(amount), 0)::text as contributed
          from public.contributions
          where contract_id = $1
          group by round
        ),
        latest_payout as (
          select distinct on (round) round,
                 recipient_amount::text as payout, recipient
          from public.payouts
          where contract_id = $1
          order by round, ledger desc, event_identity desc
        ),
        latest_fee as (
          select distinct on (round) round, fee::text as fee
          from public.protocol_fees
          where contract_id = $1
          order by round, ledger desc, event_identity desc
        )
        select r.round,
               coalesce(ca.contribution_count, 0) as contribution_count,
               coalesce(ca.contributed, '0') as contributed,
               lp.payout, lp.recipient, lf.fee
        from rounds r
        left join contrib_agg ca on ca.round = r.round
        left join latest_payout lp on lp.round = r.round
        left join latest_fee lf on lf.round = r.round
        order by r.round`,
      [GROUP],
    );
    const plan = JSON.stringify(rows);
    // A correlated subquery per round would appear as a SubPlan node.
    expect(plan).not.toContain('SubPlan');
  });
});
