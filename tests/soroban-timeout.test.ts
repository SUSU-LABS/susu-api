import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { Account, Networks, TransactionBuilder } from '@stellar/stellar-sdk';
import { createSorobanSimulator } from '../src/lib/soroban';

it('enforces a timeout on the actual SDK HTTP transport', async () => {
  let received = false;
  const server = createServer((_request, _response) => {
    received = true;
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no listener address');
  const simulate = createSorobanSimulator(`http://127.0.0.1:${address.port}`, { timeoutMs: 100 });
  const transaction = new TransactionBuilder(
    new Account('GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF', '0'),
    { fee: '100', networkPassphrase: Networks.TESTNET },
  )
    .setTimeout(60)
    .build();
  try {
    await expect(simulate(transaction)).rejects.toMatchObject({ code: 'ECONNABORTED' });
    expect(received).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
