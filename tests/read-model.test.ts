import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { createGroupReadModel, toGroupStatus, toGroupSummary } from '../src/db/groups';
import type * as schema from '../src/db/schema';
import { GROUP_CONTRACT_ID } from './support/fixtures';

/**
 * The read model is the boundary where database values become API values, so
 * these tests are about what happens when the database returns something
 * unexpected — which is exactly the case a happy-path test cannot see.
 */

const dialect = new PgDialect();

function stubDb(rows: readonly unknown[]) {
  const execute = vi.fn(async (_statement: unknown) => ({ rows }));
  return {
    execute,
    db: { execute } as unknown as NodePgDatabase<typeof schema>,
  };
}

/**
 * A stub that answers each successive query differently.
 *
 * `getGroup` issues three statements and stops early when the first finds
 * nothing, so a stub that answers every call the same way cannot reach the
 * later ones.
 */
function stubDbSequence(results: readonly (readonly unknown[])[]) {
  let index = 0;
  const execute = vi.fn(async (_statement: unknown) => ({
    rows: results[index++] ?? [],
  }));
  return {
    execute,
    db: { execute } as unknown as NodePgDatabase<typeof schema>,
  };
}

/** The SQL and bound parameters a captured `execute` call would have sent. */
function renderedQuery(statement: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement as SQL);
  return { sql: query.sql, params: query.params };
}

/** The SQL a captured `execute` call would have sent. */
function rendered(statement: unknown): string {
  return renderedQuery(statement).sql;
}

type GroupRowInput = Parameters<typeof toGroupSummary>[0];

function groupRow(overrides: Record<string, unknown> = {}): GroupRowInput {
  return {
    contract_id: GROUP_CONTRACT_ID,
    factory_contract_id: `C${'E'.repeat(55)}`,
    group_id: '1',
    creator: `G${'C'.repeat(55)}`,
    token: `C${'F'.repeat(55)}`,
    contribution_amount: '100000000',
    member_capacity: '3',
    created_ledger: '4606483',
    status: 'active',
    member_count: '3',
    current_round: '1',
    completed_rounds: '0',
    contributed_total: '300000000',
    paid_out_total: '0',
    fee_total: '0',
    last_event_ledger: '4606500',
    // Cast through `unknown` so a test can deliberately violate the row's type,
    // which is how the guard's behaviour on bad input gets exercised.
    ...overrides,
  } as unknown as GroupRowInput;
}

describe('money is cast in SQL, not converted afterwards', () => {
  it('casts every monetary column to text in the group query', async () => {
    const { db, execute } = stubDb([]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    const groupSql = rendered(execute.mock.calls[0]?.[0]);
    for (const column of [
      'contribution_amount',
      'contributed_total',
      'paid_out_total',
      'fee_total',
    ]) {
      expect(groupSql, column).toContain(`${column}::text`);
    }
  });

  it('casts amounts in each list query', async () => {
    const { db, execute } = stubDb([]);
    const model = createGroupReadModel(db);

    await model.listGroups({ limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[0]?.[0])).toContain('contribution_amount::text');

    await model.listContributions(GROUP_CONTRACT_ID, { limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[1]?.[0])).toContain('amount::text');

    await model.listPayouts(GROUP_CONTRACT_ID, { limit: 1, offset: 0 });
    expect(rendered(execute.mock.calls[2]?.[0])).toContain('recipient_amount::text');
  });

  it('sums the per-round pot in the database, not in JavaScript', async () => {
    // The total is never assembled from values that have been through a
    // JavaScript number: `sum()` stays a `numeric` and is cast on the way out.
    const { db, execute } = stubDbSequence([[groupRow()], [], []]);
    await createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID);

    // The third statement `getGroup` issues is the per-round aggregate. The
    // SQL is collapsed first so the assertion does not depend on how the
    // formatter wrapped the query.
    const roundsSql = rendered(execute.mock.calls[2]?.[0]).replace(/\s+/g, ' ');
    // The aggregate CTE selects straight from public.contributions, so there
    // is no `c.` table alias anymore; the numeric->text cast is what matters.
    expect(roundsSql).toContain('coalesce(sum(amount), 0)::text');
  });

  it('refuses an amount that arrived as a number instead of failing silently', async () => {
    // Simulates a lost `::text` cast, or a global type parser turning `numeric`
    // into a double. Returning the rounded value would be undetectable later.
    const { db } = stubDb([groupRow({ contributed_total: 300000000 })]);
    await expect(createGroupReadModel(db).getGroup(GROUP_CONTRACT_ID)).rejects.toThrow(
      /::text cast/,
    );
  });
});

describe('toGroupSummary', () => {
  it('maps a valid row, keeping money as strings', () => {
    const summary = toGroupSummary(groupRow());
    expect(summary.contractId).toBe(GROUP_CONTRACT_ID);
    expect(summary.groupId).toBe(1);
    expect(summary.contributedTotal).toBe('300000000');
    expect(summary.status).toBe('active');
  });

  it('preserves an amount that a double could not hold', () => {
    const maxI128 = '170141183460469231731687303715884105727';
    expect(toGroupSummary(groupRow({ contributed_total: maxI128 })).contributedTotal).toBe(maxI128);
  });

  it('rejects a status the contracts do not use', () => {
    expect(() => toGroupSummary(groupRow({ status: 'cancelled' }))).toThrow(/unrecognised value/);
  });

  it('rejects a ledger that is not a safe integer', () => {
    expect(() => toGroupSummary(groupRow({ created_ledger: '1e9' }))).toThrow(/safe integer/);
  });
});

describe('toGroupStatus', () => {
  it('accepts only the statuses the contracts emit', () => {
    expect(toGroupStatus('open')).toBe('open');
    expect(toGroupStatus('active')).toBe('active');
    expect(toGroupStatus('completed')).toBe('completed');
    expect(() => toGroupStatus('OPEN')).toThrow(/unrecognised value/);
  });
});

describe('pagination', () => {
  it('drops the extra row and reports that more exist', async () => {
    const rows = [1, 2, 3].map((round) => ({
      event_identity: `evt-${round}`,
      member: `G${'C'.repeat(55)}`,
      round,
      amount: '100000000',
      ledger: 4_606_500 + round,
      tx_hash: 'a'.repeat(64),
    }));

    const { db, execute } = stubDb(rows);
    const result = await createGroupReadModel(db).listContributions(GROUP_CONTRACT_ID, {
      limit: 2,
      offset: 0,
    });

    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
    // `limit + 1` is requested precisely so the extra row can be dropped here.
    // Asserted on the bound parameter, not the SQL text: the placeholder index
    // is an artefact of parameter ordering and not what this test is about.
    const { params } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(params[1]).toBe(3);
  });

  it('reports no more rows when the page is not full', async () => {
    const { db } = stubDb([]);
    const result = await createGroupReadModel(db).listPayouts(GROUP_CONTRACT_ID, {
      limit: 20,
      offset: 0,
    });
    expect(result.items).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });
});

describe('group existence', () => {
  it('is false when the group is not in the index', async () => {
    const { db } = stubDb([]);
    expect(await createGroupReadModel(db).groupExists(GROUP_CONTRACT_ID)).toBe(false);
  });

  it('is true when the group is present', async () => {
    const { db } = stubDb([{ present: 1 }]);
    expect(await createGroupReadModel(db).groupExists(GROUP_CONTRACT_ID)).toBe(true);
  });
});

describe('group status', () => {
  it('is undefined when the index has not seen the group', async () => {
    // Not the same as "not open". A group the indexer has not reached is the
    // normal state for a group its creator has just made, and the caller has to
    // be able to tell the two apart.
    const { db } = stubDb([]);
    expect(await createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID)).toBeUndefined();
  });

  it('reports the recorded status', async () => {
    const { db } = stubDb([{ status: 'active' }]);
    expect(await createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID)).toBe('active');
  });

  it('reads one column rather than assembling the whole group', async () => {
    const { db, execute } = stubDb([{ status: 'open' }]);
    await createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID);

    // One statement, and it does not touch members or rounds. This runs while a
    // visitor is waiting on a join, and `getGroup` would fetch all of it to
    // answer the same question.
    expect(execute).toHaveBeenCalledTimes(1);
    const { sql } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(sql).toContain('status');
    expect(sql).not.toContain('group_members');
  });

  it('refuses a status it does not recognise, instead of calling it closed', async () => {
    // A schema change has to be loud. Mapping an unknown value onto "not open"
    // would quietly refuse every join in the system, and look like a bug in
    // invites rather than a bug in the data.
    const { db } = stubDb([{ status: 'halted' }]);
    await expect(createGroupReadModel(db).groupStatus(GROUP_CONTRACT_ID)).rejects.toThrow(
      /unrecognised value/,
    );
  });
});

describe('the member activity feed', () => {
  const WALLET = `G${'D'.repeat(55)}`;

  it('scopes the feed by membership in SQL, not in JavaScript', async () => {
    const { db, execute } = stubDb([]);

    await createGroupReadModel(db).listMemberActivity(WALLET, { limit: 20, offset: 0 });

    const { sql, params } = renderedQuery(execute.mock.calls[0]?.[0]);
    // The address is a bound parameter of a membership test inside the query.
    // Filtering after the fact would mean reading other members' groups first,
    // and would leave the page size applying to rows the caller may not see.
    expect(sql).toContain('group_members');
    expect(sql).toContain('m.member =');
    expect(params).toContain(WALLET);
  });

  it('reads newest first, the opposite of a group audit trail', async () => {
    const { db, execute } = stubDb([]);

    await createGroupReadModel(db).listMemberActivity(WALLET, { limit: 20, offset: 0 });

    const sql = rendered(execute.mock.calls[0]?.[0]);
    expect(sql).toMatch(/order by e\.ledger desc/i);
  });

  it('carries the group each event came from', async () => {
    const { db } = stubDb([
      {
        contract_id: GROUP_CONTRACT_ID,
        event_identity: 'evt-1',
        name: 'payout_executed',
        ledger: 4_606_600,
        tx_index: 2,
        event_index: 0,
        tx_hash: 'b'.repeat(64),
        payload: { round: 2 },
      },
    ]);

    const result = await createGroupReadModel(db).listMemberActivity(WALLET, {
      limit: 20,
      offset: 0,
    });

    expect(result.items).toEqual([
      {
        contractId: GROUP_CONTRACT_ID,
        eventIdentity: 'evt-1',
        name: 'payout_executed',
        ledger: 4_606_600,
        txIndex: 2,
        eventIndex: 0,
        txHash: 'b'.repeat(64),
        payload: { round: 2 },
      },
    ]);
  });

  it('applies the page to a cross-group query too', async () => {
    const { db, execute } = stubDb([]);

    await createGroupReadModel(db).listMemberActivity(WALLET, { limit: 5, offset: 10 });

    const { params } = renderedQuery(execute.mock.calls[0]?.[0]);
    expect(params).toContain(6);
    expect(params).toContain(10);
  });
});
