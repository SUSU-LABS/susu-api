import fastify from 'fastify';
import { closeDb } from './db/client'; // Import closeDb

export function buildServer() {
    const app = fastify({
        logger: true,
    });

    // Register plugins, routes, etc.
    // ... (existing code)

    // Add the onClose hook to close the database pool gracefully during shutdown
    app.addHook('onClose', async () => {
        app.log.info('Fastify onClose hook triggered: Closing PostgreSQL pool...');
        await closeDb();
        app.log.info('PostgreSQL pool closed.');
    });

    return app;
}
