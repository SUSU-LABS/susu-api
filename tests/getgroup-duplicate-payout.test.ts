import { describe, expect, it } from 'vitest';
import { createGroupReadModel } from '../src/db/groups';
import { createTestDb } from './support/pglite';

const GROUP_ID = 'GTEST000000000000000000000000000000000000000000000000000';

/**
 * Fact tables read by getGroup's rounds query. Groups and group_members arrive
 * with the Supabase shims in real shape; the fact tables are created here with
 * the columns matching susu-indexer's schema.
 */
const FACT_TABLES = `
  create table contributions (
    event_identity text primary key,
    contract_id text not null references public.groups (contract_id) on delete cascade,
    round integer not null,
    amount numeric not null,
    ledger bigint not null
  );
  create table payouts (
    event_identity text primary key,
    contract_id text not null references public.groups (contract_id) on delete cascade,
    round integer not null,
    recipient text not null,
    recipient_amount numeric not null,
    ledger bigint not null
  );
  create table protocol_fees (
    event_identity text primary key,
    contract_id text not null references public.groups (contract_id) on delete cascade,
    round integer not null,
    fee numeric not null,
    ledger bigint not null
  );
`;

async function seed(query: (sql: string) => Promise<unknown>) {
  await query(
    `insert into groups (
       contract_id, factory_contract_id, group_id, creator, token,
       contribution_amount, member_capacity, created_ledger, status,
       member_count, current_round, completed_rounds,
       contributed_total, paid_out_total, fee_total, last_event_ledger
     ) values (
       '${GROUP_ID}', 'GFACTORY', 1, 'GCREATOR', 'GTOKEN',
       '100', 10, 500, 'active', 2, 3, 2,
       '600', '300', '30', 900
     )`,
  );
  await query(
    `insert into group_members (contract_id, member, position, joined_ledger, event_identity) values
       ('${GROUP_ID}', 'GALICE', 1, 510, 'evt-member-1'),
       ('${GROUP_ID}', 'GBOB', 2, 520, 'evt-member-2')`,
  );
  await query(
    `insert into contributions (event_identity, contract_id, round, amount, ledger) values
       ('evt-c1', '${GROUP_ID}', 1, '250', 700),
       ('evt-c2', '${GROUP_ID}', 1, '150', 701)`,
  );
}

describe('getGroup duplicate payout and fee rows (#59)', () => {
  it('returns deterministic latest-ledger values when a round has duplicate payouts and fees', { timeout: 60000 }, async () => {
    const { db, exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);

      // Re-org / retried ingest scenario: two payouts for round 1.
      // Older payout at ledger 800, newer at ledger 850.
      await query(
        `insert into payouts (event_identity, contract_id, round, recipient, recipient_amount, ledger) values
           ('evt-p-old', '${GROUP_ID}', 1, 'GALICE', '300', 800),
           ('evt-p-new', '${GROUP_ID}', 1, 'GBOB', '350', 850)`,
      );
      await query(
        `insert into protocol_fees (event_identity, contract_id, round, fee, ledger) values
           ('evt-f-old', '${GROUP_ID}', 1, '20', 800),
           ('evt-f-new', '${GROUP_ID}', 1, '30', 850)`,
      );

      const model = createGroupReadModel(db);
      const group = await model.getGroup(GROUP_ID);

      expect(group).toBeDefined();
      expect(group!.rounds).toEqual([
        {
          round: 1,
          contributionCount: 2,
          contributed: '400',
          payout: '350',
          recipient: 'GBOB',
          fee: '30',
        },
      ]);
    } finally {
      await close();
    }
  });

  it('guarantees recipient and payout amount never desynchronize across duplicate rows', { timeout: 60000 }, async () => {
    const { db, exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);

      // Case where older row has higher amount than newer row:
      // Verifies both recipient and amount come from the exact same winning row (ledger 850 -> GBOB with 200).
      await query(
        `insert into payouts (event_identity, contract_id, round, recipient, recipient_amount, ledger) values
           ('evt-p-old', '${GROUP_ID}', 1, 'GALICE', '500', 800),
           ('evt-p-new', '${GROUP_ID}', 1, 'GBOB', '200', 850)`,
      );

      const model = createGroupReadModel(db);
      const group = await model.getGroup(GROUP_ID);

      expect(group).toBeDefined();
      expect(group!.rounds[0]?.recipient).toBe('GBOB');
      expect(group!.rounds[0]?.payout).toBe('200');
    } finally {
      await close();
    }
  });

  it('preserves single-row round behavior on happy path', { timeout: 60000 }, async () => {
    const { db, exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);

      await query(
        `insert into payouts (event_identity, contract_id, round, recipient, recipient_amount, ledger) values
           ('evt-p1', '${GROUP_ID}', 1, 'GALICE', '350', 800)`,
      );
      await query(
        `insert into protocol_fees (event_identity, contract_id, round, fee, ledger) values
           ('evt-f1', '${GROUP_ID}', 1, '30', 800)`,
      );

      const model = createGroupReadModel(db);
      const group = await model.getGroup(GROUP_ID);

      expect(group).toBeDefined();
      expect(group!.rounds).toEqual([
        {
          round: 1,
          contributionCount: 2,
          contributed: '400',
          payout: '350',
          recipient: 'GALICE',
          fee: '30',
        },
      ]);
    } finally {
      await close();
    }
  });

  it('confirms the unconstrained scalar subquery would fail on duplicates', { timeout: 60000 }, async () => {
    const { exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);
      await query(
        `insert into payouts (event_identity, contract_id, round, recipient, recipient_amount, ledger) values
           ('evt-p1', '${GROUP_ID}', 1, 'GALICE', '300', 800),
           ('evt-p2', '${GROUP_ID}', 1, 'GBOB', '350', 850)`,
      );

      await expect(
        query(
          `select (select p.recipient_amount::text from payouts p where p.contract_id = '${GROUP_ID}' and p.round = 1) as payout`,
        ),
      ).rejects.toThrow(/more than one row returned by a subquery/);
    } finally {
      await close();
    }
  });
});
