import fastify, { FastifyInstance, FastifyServerOptions } from 'fastify';
import { Pool } from 'pg';
import { getConfig } from './config';
import { logger } from './logger';
import { runMigrations } from './db/migrations';
import { createAuthPlugin } from './plugins/auth';
import { createKeyPlugin } from './plugins/key';
import { createDocsPlugin } from './plugins/docs';
import { createMetricsPlugin } from './plugins/metrics';
import { createUserRoutes } from './routes/user';
import { createKeyRoutes } from './routes/key';
import { createAgentRoutes } from './routes/agent';
import { createModelRoutes } from './routes/model';
import { createCompletionRoutes } from './routes/completion';
import { createChatRoutes } from './routes/chat';
import { createEmbeddingRoutes } from './routes/embeddings';
import { createAdminRoutes } from './routes/admin';
import { createModelConfigRoutes } from './routes/model-config';
import { createKeyPoolRoutes } from './routes/key-pool';
import { createUsageRoutes } from './routes/usage';
import { createQuotaRoutes } from './routes/usage';
import { createProxyService } from './services/proxy';
import { createRouterService } from './services/router';
import { createCacheService } from './services/cache';
import { createRateLimitService } from './services/ratelimit';
import { createCreditService } from './services/credit';
import { createDbService } from './services/db';
import { createLoggerPlugin } from './plugins/logger';

export interface ServerOptions extends FastifyServerOptions {
  dbPool?: Pool;
}

export async function buildServer(options: ServerOptions = {}): Promise<FastifyInstance> {
  const config = getConfig();
  
  // Create Fastify instance
  const app = fastify({
    logger: logger,
    ...options,
  });

  // Setup Database
  const pool = options.dbPool || new Pool({
    connectionString: config.DATABASE_URL,
  });

  // Run migrations if not in test environment or if requested
  if (config.NODE_ENV !== 'test' && !options.dbPool) {
    try {
      await runMigrations(pool);
    } catch (err) {
      logger.error('Failed to run migrations', err);
      throw err;
    }
  }

  // Initialize Services
  const dbService = createDbService(pool);
  const cacheService = createCacheService({
    url: config.REDIS_URL,
    enabled: config.REDIS_ENABLED,
  });
  const rateLimitService = createRateLimitService(cacheService);
  const creditService = createCreditService(dbService);
  const routerService = createRouterService(dbService);
  const proxyService = createProxyService({
    router: routerService,
    rateLimiter: rateLimitService,
    credits: creditService,
  });

  // Decorate fastify with services
  app.decorate('db', dbService);
  app.decorate('cache', cacheService);
  app.decorate('rateLimiter', rateLimitService);
  app.decorate('credits', creditService);
  app.decorate('router', routerService);
  app.decorate('proxy', proxyService);

  // Register plugins
  await app.register(createLoggerPlugin());
  await app.register(createAuthPlugin(), { db: dbService, cache: cacheService });
  await app.register(createKeyPlugin(), { db: dbService });
  await app.register(createDocsPlugin());
  await app.register(createMetricsPlugin());

  // Register routes
  await app.register(createUserRoutes, { prefix: '/v1/user' });
  await app.register(createKeyRoutes, { prefix: '/v1/keys' });
  await app.register(createAgentRoutes, { prefix: '/v1/agents' });
  await app.register(createModelRoutes, { prefix: '/v1/models' });
  await app.register(createCompletionRoutes, { prefix: '/v1' });
  await app.register(createChatRoutes, { prefix: '/v1' });
  await app.register(createEmbeddingRoutes, { prefix: '/v1' });
  await app.register(createAdminRoutes, { prefix: '/v1/admin' });
  await app.register(createModelConfigRoutes, { prefix: '/v1/admin/configs' });
  await app.register(createKeyPoolRoutes, { prefix: '/v1/admin/pools' });
  await app.register(createUsageRoutes, { prefix: '/v1/usage' });
  await app.register(createQuotaRoutes, { prefix: '/v1/quota' });

  // Root endpoint
  app.get('/', async () => {
    return {
      name: 'SUSU API',
      version: '1.0.0',
      status: 'healthy',
      timestamp: new Date().toISOString(),
    };
  });

  // Health check
  app.get('/health', async () => {
    try {
      await pool.query('SELECT 1');
      return { status: 'ok', database: 'connected' };
    } catch (err) {
      app.log.error('Health check failed:', err);
      return { status: 'error', database: 'disconnected' };
    }
  });

  // Nonce reaper timer setup
  const nonceReaperInterval = 15 * 60 * 1000; // 15 minutes
  const nonceReaperTimer = setInterval(async () => {
    try {
      const client = await pool.connect();
      try {
        // Clean up expired nonces (older than 24 hours)
        const result = await client.query(
          `DELETE FROM nonces WHERE created_at < NOW() - INTERVAL '24 hours'`
        );
        if (result.rowCount && result.rowCount > 0) {
          app.log.info({ count: result.rowCount }, 'Reaped expired nonces');
        }
      } finally {
        client.release();
      }
    } catch (err) {
      app.log.error('Error reaping nonces:', err);
    }
  }, nonceReaperInterval);

  // Ensure timer doesn't prevent Node from exiting if server closes, 
  // but more importantly clear it on app close.
  if (nonceReaperTimer.unref) {
    nonceReaperTimer.unref();
  }

  app.addHook('onClose', async () => {
    clearInterval(nonceReaperTimer);
    if (!options.dbPool) {
      await pool.end();
    }
  });

  return app;
}
