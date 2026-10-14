import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { createGroupReadModel } from '../src/db/groups';
import { createTestDb } from './support/pglite';

const GROUP_ID = 'GTEST000000000000000000000000000000000000000000000000000';

/**
 * `groups`, `group_members` and `decoded_events` arrive with the Supabase
 * shims the support module applies, in the indexer's real shape. The three
 * fact tables the rounds query reads do not — they are created here to match
 * the columns the query selects.
 */
const FACT_TABLES = `
  create table contributions (
    contract_id text not null references public.groups (contract_id) on delete cascade,
    round integer not null,
    amount numeric not null
  );
  create table payouts (
    contract_id text not null references public.groups (contract_id) on delete cascade,
    round integer not null,
    recipient text not null,
    recipient_amount numeric not null
  );
  create table protocol_fees (
    contract_id text not null references public.groups (contract_id) on delete cascade,
    round integer not null,
    fee numeric not null
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
  // round 1: two contributions + payout + fee
  // round 2: one contribution, no payout, no fee
  // round 3: no contributions, payout only (edge: union drives the round)
  await query(
    `insert into contributions values
       ('${GROUP_ID}', 1, '250'), ('${GROUP_ID}', 1, '150'), ('${GROUP_ID}', 2, '200')`,
  );
  await query(
    `insert into payouts values
       ('${GROUP_ID}', 1, 'GALICE', '350'), ('${GROUP_ID}', 3, 'GBOB', '100')`,
  );
  await query(`insert into protocol_fees values ('${GROUP_ID}', 1, '30')`);
}

describe('getGroup grouped aggregate (#62)', () => {
  it('returns identical rounds/member data for the fixture', { timeout: 60000 }, async () => {
    const { db, exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);
      const model = createGroupReadModel(db);

      const group = await model.getGroup(GROUP_ID);
      expect(group).toBeDefined();
      expect(group!.members).toHaveLength(2);
      expect(group!.rounds).toEqual([
        {
          round: 1,
          contributionCount: 2,
          contributed: '400',
          payout: '350',
          recipient: 'GALICE',
          fee: '30',
        },
        {
          round: 2,
          contributionCount: 1,
          contributed: '200',
          payout: null,
          recipient: null,
          fee: null,
        },
        {
          round: 3,
          contributionCount: 0,
          contributed: '0',
          payout: '100',
          recipient: 'GBOB',
          fee: null,
        },
      ]);
    } finally {
      await close();
    }
  });

  it('produces no per-round correlated subplan in EXPLAIN', { timeout: 60000 }, async () => {
    const { db, exec, query, close } = await createTestDb();
    try {
      await exec(FACT_TABLES);
      await seed(query);
      const model = createGroupReadModel(db);

      // Capture the SQL+params the production method issues, then explain
      // THAT — a separately copied query could drift from what the code runs.
      const dialect = new PgDialect();
      const captured: { sql: string; params: unknown[] }[] = [];
      const origExecute = db.execute.bind(db);
      db.execute = ((statement: SQL) => {
        const compiled = dialect.sqlToQuery(statement);
        captured.push({ sql: compiled.sql, params: compiled.params });
        return origExecute(statement as never);
      }) as typeof db.execute;
      await model.getGroup(GROUP_ID);

      const rounds = captured.find((c) => c.sql.includes('from rounds'));
      expect(rounds).toBeDefined();
      const plan = await query(`explain ${rounds!.sql}`, rounds!.params as readonly unknown[]);
      const planText = plan.rows.map((r) => r['QUERY PLAN']).join('\n');
      expect(planText).not.toMatch(/SubPlan \d+/);
    } finally {
      await close();
    }
  });
});
