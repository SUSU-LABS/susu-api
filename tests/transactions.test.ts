import { afterAll, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { TransactionReadModel, TransactionReceipt } from '../src/db/transactions';
import type { TokenVerifier } from '../src/auth/verify';
import { configureTestEnv } from './support/fixtures';

configureTestEnv();

const TX_HASH = 'ab'.repeat(32);
const UPPER_TX_HASH = TX_HASH.toUpperCase();

const built: FastifyInstance[] = [];

afterAll(async () => {
  await Promise.all(built.map(async (app) => app.close()));
});

function receipt(overrides: Partial<TransactionReceipt> = {}): TransactionReceipt {
  return {
    txHash: TX_HASH,
    ledger: 4_606_483,
    txIndex: 2,
    events: [
      {
        eventIdentity: `${TX_HASH}:0`,
        name: 'contribution',
        contractId: `C${'A'.repeat(55)}`,
        eventIndex: 0,
        payload: { amount: '100000000' },
      },
      {
        eventIdentity: `${TX_HASH}:1`,
        name: 'fee',
        contractId: `C${'A'.repeat(55)}`,
        eventIndex: 1,
        payload: { amount: '500000' },
      },
    ],
    truncated: false,
    ...overrides,
  };
}

type FakeModel = TransactionReadModel & { getReceipt: ReturnType<typeof vi.fn> };

async function harness(receiptOrNothing: { receipt: TransactionReceipt | undefined }): Promise<{
  app: FastifyInstance;
  model: FakeModel;
}> {
  const { buildServer } = await import('../src/server');

  const model = {
    getReceipt: vi.fn(async () => receiptOrNothing.receipt),
  } as unknown as FakeModel;
  const verify = vi.fn(async () => ({ id: 'user', email: 'ada@example.com' }));

  const app = await buildServer({
    probeDatabase: async () => {},
    verifyToken: verify as unknown as TokenVerifier,
    transactionReadModel: model,
    readModel: {
      groupExists: vi.fn(),
      listGroups: vi.fn(),
      getGroup: vi.fn(),
      listContributions: vi.fn(),
      listPayouts: vi.fn(),
      listActivity: vi.fn(),
    } as never,
  });
  built.push(app);

  return { app, model };
}

describe('GET /api/v1/transactions/:txHash', () => {
  it('returns the receipt for a known transaction', async () => {
    const { app, model } = await harness({ receipt: receipt() });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().data.txHash).toBe(TX_HASH);
    expect(response.json().data.ledger).toBe(4_606_483);
    expect(model.getReceipt).toHaveBeenCalledWith(TX_HASH);
  });

  it('returns every event of the transaction, in event order', async () => {
    const { app } = await harness({ receipt: receipt() });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    // A contribution is followed by its fee. The unit is the transaction because
    // a receipt split into separate events is one a caller has to reassemble.
    expect(response.json().data.events.map((event: { name: string }) => event.name)).toEqual([
      'contribution',
      'fee',
    ]);
  });

  it('passes through the truncation flag for a bounded receipt', async () => {
    const { app } = await harness({ receipt: receipt({ truncated: true }) });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    expect(response.json().data.truncated).toBe(true);
  });

  it('names the contract that emitted each event', async () => {
    const { app } = await harness({ receipt: receipt() });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    // One transaction can touch more than one Susu contract, so the events are
    // not attributable without this.
    expect(response.json().data.events[0].contractId).toMatch(/^C[A-Z2-7]{55}$/);
  });

  it('does not require authentication', async () => {
    const { app } = await harness({ receipt: receipt() });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    // Everything here is on the public ledger.
    expect(response.statusCode).toBe(200);
  });

  it('lowercases the hash before the lookup', async () => {
    const { app, model } = await harness({ receipt: receipt() });

    await app.inject({ method: 'GET', url: `/api/v1/transactions/${UPPER_TX_HASH}` });

    // Without this an uppercase hash would be a valid identifier that finds
    // nothing, which is the worst of both outcomes.
    expect(model.getReceipt).toHaveBeenCalledWith(TX_HASH);
  });

  it('accepts an uppercase hash', async () => {
    const { app } = await harness({ receipt: receipt() });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${UPPER_TX_HASH}`,
    });

    expect(response.statusCode).toBe(200);
  });

  it('reports an unknown transaction', async () => {
    const { app } = await harness({ receipt: undefined });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'transaction_not_found' });
  });

  it('refuses a hash of the wrong length without a lookup', async () => {
    const { app, model } = await harness({ receipt: receipt() });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${'ab'.repeat(31)}`,
    });

    // A path segment that cannot match a row should not become a query, so a
    // junk hash cannot be used to probe for stored values.
    expect(response.statusCode).toBe(400);
    expect(model.getReceipt).not.toHaveBeenCalled();
  });

  it('refuses a hash that is not hex without a lookup', async () => {
    const { app, model } = await harness({ receipt: receipt() });

    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/transactions/${'zz'.repeat(32)}`,
    });

    expect(response.statusCode).toBe(400);
    expect(model.getReceipt).not.toHaveBeenCalled();
  });

  it('caches a found receipt, because a transaction is immutable', async () => {
    const { app } = await harness({ receipt: receipt() });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    expect(response.headers['cache-control']).toContain('public');
  });

  it('does not cache an absent receipt', async () => {
    const { app } = await harness({ receipt: undefined });

    const response = await app.inject({ method: 'GET', url: `/api/v1/transactions/${TX_HASH}` });

    // This is the case that can change: the indexer runs on a schedule, so a
    // recent transaction's absence means "not yet" and a cached absence would
    // become sticky.
    expect(response.headers['cache-control']).toBe('no-store');
  });
});
