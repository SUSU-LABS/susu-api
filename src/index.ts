import { buildServer, NONCE_REAP_INTERVAL_MS } from './server';
import { getEnv } from './lib/env';

/**
 * Process entrypoint.
 *
 * Fatal startup errors are written to stderr without dumping configuration, so
 * that a misconfiguration can never leak a secret into logs.
 */
async function main(): Promise<void> {
  const env = getEnv();
  // The only caller that starts the spent-nonce reaper. Everything else — tests
  // above all — builds a server with no background timers unless it asks, and
  // the timer that is started here is cleared when the server closes.
  const app = await buildServer({ nonceReapIntervalMs: NONCE_REAP_INTERVAL_MS });

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ signal }, 'shutting down');
    try {
      // Waits for the server's `onClose` hooks, which include ending the
      // database pool — so the process is not exited from under an in-flight
      // query, and the pool is never left open behind a closed server.
      await app.close();
      process.exit(0);
    } catch (error) {
      app.log.error({ err: error }, 'error during shutdown');
      process.exit(1);
    }
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((error: unknown) => {
  const name = error instanceof Error ? error.name : 'Error';
  const message = error instanceof Error ? error.message : 'unknown startup failure';
  process.stderr.write(`Fatal startup error (${name}): ${message}\n`);
  process.exit(1);
});
