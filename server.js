import fs from 'node:fs';
import { loadConfig } from './src/config.js';
import { makeLogger } from './src/logger.js';
import { CpanelClient } from './src/cpanelClient.js';
import { Outbox } from './src/outbox.js';
import { SessionManager } from './src/sessionManager.js';
import { Scheduler } from './src/scheduler.js';
import { createApp } from './src/app.js';
import { baileysSocketFactory } from './src/baileysFactory.js';

const cfg = loadConfig();
const makeLog = makeLogger(cfg.logLevel);
const log = makeLog('server');

fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
const cpanel = new CpanelClient({ baseUrl: cfg.cpanelApiUrl, secret: cfg.serviceSecret });
const outbox = new Outbox({ dir: cfg.dataDir, cpanel, log: makeLog('outbox') });

let scheduler;
const sessions = new SessionManager({
  cfg, cpanel, makeLog, socketFactory: baileysSocketFactory,
  onConnected: (userId) => scheduler?.onWhatsappConnected(userId),
});
scheduler = new Scheduler({ cfg, cpanel, sessions, outbox, log: makeLog('scheduler') });

const app = createApp({ cfg, cpanel, sessions, scheduler, outbox, log });
const server = app.listen(cfg.port, () => {
  log.info(`listening on :${cfg.port}  data=${cfg.dataDir}  cpanel=${cfg.cpanelApiUrl}`);
  sessions.restoreAll().then(n => log.info(`restored ${n} WhatsApp session(s) from the volume`)).catch(e => log.error(e.message));
  scheduler.start();
});

const shutdown = async () => {
  log.info('shutting down');
  scheduler.stop();
  server.close();
  await sessions.shutdown().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('unhandledRejection', (e) => log.error(`unhandledRejection: ${e?.stack || e}`));
