import { describe, expect, it } from 'vitest';
import { createGroupReadModel } from '../src/db/groups';
import { createTestDb } from './support/pglite';

const GROUP_ID = 'GTEST000000000000000000000000000000000000000000000000000';

/**
 * `groups`, `group_members` and `decoded_events` arrive with the Supabase
 * shims the support module applies, in the indexer's real shape. The three
 * fact tables the rounds query reads do not — they are created here with the
 * columns the query selects and orders by.
 */
const FACT_TABLES = `
  create table contributions (
    contract_id text not null references public.groups (contract_id) on delete cascade,
    event_identity text primary key,
    round integer not null,
    amount numeric not null,
    ledger bigint not null
  );
  create table payouts (
    contract_id text not null references public.groups (contract_id) on delete cascade,
    event_identity text primary key,
    round integer not null,
    recipient text not null,
    recipient_amount numeric not null,
    ledger bigint not null
  );
  create table protocol_fees (
    contract_id text not null references public.groups (contract_id) on delete cascade,
    event_identity text primary key,
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
    `insert into contributions values
       ('${GROUP_ID}', 'evt-c1', 1, '250', 700), ('${GROUP_ID}', 'evt-c2', 1, '150', 701)`,
  );
}

describe('getGroup duplicate payout/fee rows (#59)', () => {
  it(
    'returns 200 with the latest-ledger row when a round has two payouts',
    { timeout: 60000 },
    async () => {
      const { db, exec, query, close } = await createTestDb();
      try {
        await exec(FACT_TABLES);
        await seed(query);
        // The duplicate the issue guards against: two payouts for round 1 —
        // the re-org/partial-re-index shape. The newer one (ledger 850)
        // must win deterministically.
        await query(
          `insert into payouts values
             ('${GROUP_ID}', 'evt-p-old', 1, 'GALICE', '300', 800),
             ('${GROUP_ID}', 'evt-p-new', 1, 'GBOB', '350', 850)`,
        );
        await query(
          `insert into protocol_fees values
             ('${GROUP_ID}', 'evt-f-old', 1, '20', 800),
             ('${GROUP_ID}', 'evt-f-new', 1, '30', 850)`,
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
    },
  );

  it('is unchanged for the single-row-per-round case', { timeout: 60000 }, async () => {
    const { db, exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);
      await query(`insert into payouts values ('${GROUP_ID}', 'evt-p1', 1, 'GALICE', '350', 800)`);
      await query(`insert into protocol_fees values ('${GROUP_ID}', 'evt-f1', 1, '30', 800)`);
      const model = createGroupReadModel(db);

      const group = await model.getGroup(GROUP_ID);
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
});
