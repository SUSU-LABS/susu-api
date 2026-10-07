import { describe, expect, it, vi } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  createTransactionReadModel,
  isTransactionHash,
  MAX_RECEIPT_EVENTS,
  normaliseTransactionHash,
} from '../src/db/transactions';
import type * as schema from '../src/db/schema';

/**
 * The transaction model.
 *
 * `decoded_events` belongs to `susu-indexer`, so there is no migration in this
 * repository that creates it and no PGlite fixture that could. These tests
 * therefore stub the rows and inspect the SQL, which is the same approach
 * `read-model.test.ts` takes for the same reason, and covers what is available to
 * get wrong: the query, and the mapping from a row to a receipt.
 */

const dialect = new PgDialect();

const TX_HASH = 'ab'.repeat(32);

function stubDb(rows: readonly unknown[]) {
  const execute = vi.fn(async (_statement: unknown) => ({ rows }));
  return { execute, db: { execute } as unknown as NodePgDatabase<typeof schema> };
}

function rendered(statement: unknown): { sql: string; params: unknown[] } {
  const query = dialect.sqlToQuery(statement as SQL);
  return { sql: query.sql, params: query.params };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    event_identity: `${TX_HASH}:0`,
    name: 'contribution',
    contract_id: `C${'A'.repeat(55)}`,
    ledger: '4606483',
    tx_index: '2',
    event_index: '0',
    payload: { amount: '100000000' },
    ...overrides,
  };
}

describe('isTransactionHash', () => {
  it('accepts 64 hex characters', () => {
    expect(isTransactionHash(TX_HASH)).toBe(true);
    expect(isTransactionHash(TX_HASH.toUpperCase())).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isTransactionHash('ab'.repeat(31))).toBe(false);
    expect(isTransactionHash('ab'.repeat(33))).toBe(false);
    expect(isTransactionHash('zz'.repeat(32))).toBe(false);
    expect(isTransactionHash('')).toBe(false);
    // An event identity or a contract address must not be mistaken for a hash.
    expect(isTransactionHash(`C${'A'.repeat(55)}`)).toBe(false);
  });
});

describe('normaliseTransactionHash', () => {
  it('lowercases, so a hash from any source finds the same rows', () => {
    expect(normaliseTransactionHash(TX_HASH.toUpperCase())).toBe(TX_HASH);
  });
});

describe('getReceipt', () => {
  it('queries by tx hash, ordered by event index', async () => {
    const { db, execute } = stubDb([]);

    await createTransactionReadModel(db).getReceipt(TX_HASH);

    const query = rendered(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain('from public.decoded_events');
    expect(query.sql).toContain('where tx_hash = $1');
    // The order is what makes a receipt readable and stable; without it a
    // two-event transaction could be reported fee-first.
    expect(query.sql).toContain('order by event_index');
    expect(query.params).toEqual([TX_HASH, MAX_RECEIPT_EVENTS]);
  });

  it('caps the events returned at MAX_RECEIPT_EVENTS, in the database', async () => {
    const { db, execute } = stubDb([]);

    await createTransactionReadModel(db).getReceipt(TX_HASH);

    // The bound lives in the SQL, not in JavaScript: the database must never
    // materialise the rows the response would discard. A transaction that
    // emits more events than the cap — or an adversarial contract in an allowed
    // invocation — still produces a bounded body.
    const query = rendered(execute.mock.calls[0]?.[0]);
    expect(query.sql).toContain('limit');
    expect(query.params).toContain(MAX_RECEIPT_EVENTS);
    expect(MAX_RECEIPT_EVENTS).toBeGreaterThan(0);
  });

  it('returns undefined when the index has no events for the transaction', async () => {
    const { db } = stubDb([]);

    expect(await createTransactionReadModel(db).getReceipt(TX_HASH)).toBeUndefined();
  });

  it('builds a receipt from every event, in the order given', async () => {
    const { db } = stubDb([
      row({ event_identity: `${TX_HASH}:0`, name: 'contribution', event_index: '0' }),
      row({ event_identity: `${TX_HASH}:1`, name: 'fee', event_index: '1' }),
    ]);

    const receipt = await createTransactionReadModel(db).getReceipt(TX_HASH);

    expect(receipt?.events.map((event) => event.name)).toEqual(['contribution', 'fee']);
    expect(receipt?.events.map((event) => event.eventIndex)).toEqual([0, 1]);
  });

  it('takes the ledger and transaction index from the events', async () => {
    const { db } = stubDb([row({ ledger: '4606483', tx_index: '7' })]);

    const receipt = await createTransactionReadModel(db).getReceipt(TX_HASH);

    // `bigint` and `integer` both arrive as strings from node-postgres, and a
    // ledger reported as a string would be a different JSON type from the one the
    // group routes use.
    expect(receipt?.ledger).toBe(4_606_483);
    expect(receipt?.txIndex).toBe(7);
  });

  it('echoes the normalised hash the caller asked for', async () => {
    const { db } = stubDb([row()]);

    const receipt = await createTransactionReadModel(db).getReceipt(TX_HASH);

    expect(receipt?.txHash).toBe(TX_HASH);
  });

  it('keeps the payload as it was decoded', async () => {
    const payload = { amount: '100000000', round: '1' };
    const { db } = stubDb([row({ payload })]);

    const receipt = await createTransactionReadModel(db).getReceipt(TX_HASH);

    // Amounts are base-unit strings and must stay strings. Re-serialising or
    // coercing here is how a precise value becomes a rounded number.
    expect(receipt?.events[0]?.payload).toEqual(payload);
  });

  it('rejects a count that arrived as something other than an integer', async () => {
    const { db } = stubDb([row({ ledger: '4606483.5' })]);

    // A fractional ledger is impossible on chain, so it means the column is not
    // what this query thinks it is. Failing loudly beats reporting 4606483.5.
    await expect(createTransactionReadModel(db).getReceipt(TX_HASH)).rejects.toThrow(
      /decoded_events.ledger/,
    );
  });

  it('handles a transaction with a single event', async () => {
    const { db } = stubDb([row()]);

    const receipt = await createTransactionReadModel(db).getReceipt(TX_HASH);

    expect(receipt?.events).toHaveLength(1);
  });
});
