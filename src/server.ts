import express from 'express';
import { createNotificationSweeper } from './db/notification-sweep';
import { getDb } from './db';

const app = express();
let notificationSweeperInterval: NodeJS.Timeout | null = null;

// ... (outros imports e configurações existentes)

async function startServer() {
  const db = getDb();
  
  // Tenta rodar o sweeper via pg_cron (já configurado nas migrations)
  // Mas inicia um fallback em memória para garantir funcionamento em ambientes sem pg_cron
  const SWEEP_INTERVAL_MS = process.env.NOTIFICATION_SWEEP_INTERVAL_MS 
    ? parseInt(process.env.NOTIFICATION_SWEEP_INTERVAL_MS, 10) 
    : 1000 * 60 * 60; // Default: 1 hora

  notificationSweeperInterval = setInterval(async () => {
    try {
      console.log('[NotificationSweeper] Running scheduled sweep...');
      await createNotificationSweeper(db).sweep();
    } catch (error) {
      console.error('[NotificationSweeper] Error during scheduled sweep:', error);
    }
  }, SWEEP_INTERVAL_MS);

  // ... (restante da lógica de inicialização do servidor)
}

async function stopServer() {
  if (notificationSweeperInterval) {
    clearInterval(notificationSweeperInterval);
    console.log('[NotificationSweeper] Interval cleared.');
  }
  // ... (outras lógicas de fechamento)
}

// Exemplo de como o app.close deve ser chamado no entrypoint
// app.listen(...) -> process.on('SIGTERM', stopServer)

export { startServer, stopServer };
