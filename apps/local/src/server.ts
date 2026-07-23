import path from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app';
import { openLocalDatabase } from './database';
import { openLocalSessionService } from './local-session';
import { openBrowser } from './open-browser';

const dataDir = process.env.SUPERSELF_DATA_DIR ?? path.resolve('.data/dev');
const port = Number(process.env.PORT ?? 4317);
const database = await openLocalDatabase(dataDir);
const sessionService = await openLocalSessionService(dataDir);
const app = createApp({ serveWeb: true, sessionService });

const server = serve({
  fetch: app.fetch,
  hostname: '127.0.0.1',
  port,
}, (info) => {
  const url = `http://127.0.0.1:${info.port}`;
  const webUrl = process.env.SUPERSELF_WEB_URL ?? url;
  console.log(`Superself Local: ${webUrl}`);
  console.log(`Data: ${dataDir}`);

  const shouldOpenBrowser = process.env.SUPERSELF_OPEN_BROWSER !== 'false';
  const shouldPrintPairingUrl = process.env.SUPERSELF_PRINT_PAIRING_URL === 'true';
  if (shouldOpenBrowser || shouldPrintPairingUrl) {
    const pairingToken = sessionService.issuePairingToken();
    const pairingUrl = `${webUrl}/#pair=${encodeURIComponent(pairingToken)}`;
    if (shouldPrintPairingUrl) console.log(`One-time pairing URL: ${pairingUrl}`);
    if (shouldOpenBrowser) openBrowser(pairingUrl);
  }
});

async function shutdown() {
  server.close();
  await database.close();
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
