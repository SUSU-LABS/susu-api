/**
 * The transaction read model: what the protocol recorded for one Stellar
 * transaction.
 *
 * This is the receipt endpoint. A client sends a transaction, gets a hash back
 * from the network, and wants to know what it did. Everything here comes from
 * `public.decoded_events`, written by `susu-indexer` from the chain, so the answer
 * is the chain's answer and not the client's account of it.
 *
 * A transaction can emit several events — a contribution is followed by the fee
 * that accompanies it — so the unit is the transaction, not the event. Returning
 * the events individually would make a caller reassemble a receipt that the ledger
 * already groups.
 *
 * EVENTUAL, BY NATURE
 * The indexer ingests on a schedule, so for a recent transaction the honest answer
 * is "not yet known" and the endpoint says `not found`. A caller polling after a
 * submission must treat 404 as *either* "this transaction touched no Susu
 * contract" or "the indexer has not reached it", and the response is cached in a
 * way that respects the difference.
 */
import { sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { assertCount } from '../lib/base-units';
import { queryRows } from './raw';
import type * as schema from './schema';

/** 32 bytes of hex, as the RPC reports a transaction hash. */
const TX_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

/**
 * The most decoded events one receipt may carry.
 *
 * A transaction can legitimately emit many events, but the receipt endpoint
 * answers with the whole array in a single JSON body, so an unbounded query
 * turns a chatty (or adversarial, in an allowed invocation) contract into an
 * arbitrarily large response. The cap is enforced in the SQL itself (`LIMIT`),
 * not in JavaScript, so the database never materialises rows the response would
 * discard. One hundred is far above what a legitimate Susu transaction emits —
 * a contribution is followed by its fee — while keeping the worst-case body
 * small and predictable.
 */
export const MAX_RECEIPT_EVENTS = 100;

/**
 * Whether a string could be a transaction hash.
 *
 * Uppercase is accepted because the hash is normalised before it is used, not
 * because the database contains uppercase ones. Rejecting it would make a
 * perfectly identifiable transaction unfindable depending on which tool produced
 * the string.
 */
export function isTransactionHash(value: string): boolean {
  return TX_HASH_PATTERN.test(value);
}

/** Lowercase, so a hash from any source finds the same rows. */
export function normaliseTransactionHash(value: string): string {
  return value.toLowerCase();
}

export type TransactionEvent = {
  readonly eventIdentity: string;
  /** The decoded event name, e.g. `contribution`. */
  readonly name: string;
  /** The contract that emitted it, so a multi-contract transaction is readable. */
  readonly contractId: string;
  readonly eventIndex: number;
  /** The decoded fields, exactly as the decoder produced them. */
  readonly payload: unknown;
};

export type TransactionReceipt = {
  readonly txHash: string;
  /** The ledger the transaction was included in. */
  readonly ledger: number;
  readonly txIndex: number;
  /**
   * In the order the contract emitted them. Capped at `MAX_RECEIPT_EVENTS`:
   * the response never carries more, however many events the transaction
   * emitted.
   */
  readonly events: readonly TransactionEvent[];
};

export type TransactionReadModel = {
  /**
   * The receipt for a transaction, or `undefined` if the index has no events for
   * it.
   *
   * `txHash` must already be normalised; the route does that.
   */
  getReceipt(txHash: string): Promise<TransactionReceipt | undefined>;
};

type EventRow = {
  event_identity: string;
  name: string;
  contract_id: string;
  ledger: number | string;
  tx_index: number | string;
  event_index: number | string;
  payload: unknown;
};

/**
 * Builds a receipt from the events of one transaction.
 *
 * The first row decides the ledger and transaction index, because every row
 * belongs to the same transaction and therefore to the same ledger and the same
 * position within it. Asserting that they agree rather than taking the first
 * would be more code for a case the primary key already prevents.
 */
function toReceipt(txHash: string, rows: readonly EventRow[]): TransactionReceipt | undefined {
  const first = rows[0];
  if (first === undefined) return undefined;

  return {
    // The hash the caller asked for, echoed back, rather than the stored
    // spelling: the same value, in the case the request used.
    txHash,
    ledger: assertCount(first.ledger, 'decoded_events.ledger'),
    txIndex: assertCount(first.tx_index, 'decoded_events.tx_index'),
    events: rows.map((row) => ({
      eventIdentity: row.event_identity,
      name: row.name,
      contractId: row.contract_id,
      eventIndex: assertCount(row.event_index, 'decoded_events.event_index'),
      payload: row.payload,
    })),
  };
}

export function createTransactionReadModel(
  db: NodePgDatabase<typeof schema>,
): TransactionReadModel {
  return {
    async getReceipt(txHash) {
      const rows = (await queryRows(
        db,
        sql`
          select
            event_identity,
            name,
            contract_id,
            ledger,
            tx_index,
            event_index,
            payload
          from public.decoded_events
          where tx_hash = ${txHash}
          order by event_index
          limit ${MAX_RECEIPT_EVENTS}
        `,
      )) as readonly EventRow[];

      const receipt = toReceipt(txHash, rows);
      return receipt;
    },
  };
}
