import express from 'express';
import rateLimit from 'express-rate-limit';
import { makeAuth } from './auth.js';
import { WaError } from './whatsappSession.js';

/**
 * Railway HTTP API (used by the Android app).  All /api routes need `Authorization: Bearer <cPanel login token>`.
 * Persistent data (balance, transactions, pending queue) is served by the cPanel API; this service exposes
 * WhatsApp linking + the automation controls that must run on the always-on worker.
 */
export function createApp({ cfg, cpanel, sessions, scheduler, outbox, log }) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);                                    // Railway terminates TLS in front of us
  app.use(express.json({ limit: '20kb' }));
  app.use((req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });

  // Public, non-sensitive liveness probe (Railway health check).
  app.get(['/', '/health'], (req, res) => res.json({ ok: true, service: 'finpulse-railway-worker', persistentStorage: cfg.persistentStorage, uptimeSeconds: Math.round(process.uptime()) }));

  const auth = makeAuth({ cpanel });
  const general = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, message: { success: false, code: 'RATE_LIMITED', message: 'Too many requests' } });
  const linkLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 10, keyGenerator: (req) => req.userId || req.ip, message: { success: false, code: 'RATE_LIMITED', message: 'Too many linking attempts. Wait a few minutes.' } });

  const api = express.Router();
  api.use(general, auth);
  const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (e instanceof WaError) {
      const status = { ALREADY_LINKED: 409, BAD_PHONE: 400, NOT_CONNECTED: 409 }[e.code] || 500;
      return res.status(status).json({ success: false, code: e.code, message: e.message });
    }
    if (e?.name === 'CpanelError') return res.status(e.retryable ? 503 : 502).json({ success: false, code: e.code, message: e.retryable ? 'Database temporarily unavailable' : e.message });
    log.error(`route error: ${e.stack || e.message}`);
    res.status(500).json({ success: false, code: 'SERVER_ERROR', message: 'Internal error' });
  });

  const waStatus = (userId) => sessions.get(userId)?.getPublicStatus() ?? { state: 'DISCONNECTED', connected: false, hasSession: false, qrDataUrl: null, pairingCode: null, phoneMasked: null, lastError: null };

  // ---------- WhatsApp linking ----------
  const NO_VOLUME = { success: false, code: 'NO_PERSISTENT_VOLUME', message: 'The Railway server has no Volume attached, so the WhatsApp link would be lost on every restart/redeploy. Attach a Volume with mount path /data in Railway, then link again.' };
  const needVolume = (req, res, next) => (cfg.persistentStorage ? next() : res.status(409).json(NO_VOLUME));

  api.get('/whatsapp/status', wrap(async (req, res) => {
    res.json({ success: true, storagePersistent: cfg.persistentStorage, whatsapp: waStatus(req.userId), unofficialNotice: 'Unofficial WhatsApp client (Baileys). Not an official WhatsApp/SBI API; account restrictions are possible.' });
  }));

  api.post('/whatsapp/link/qr', needVolume, linkLimiter, wrap(async (req, res) => {
    await sessions.getOrCreate(req.userId).startLinking();
    res.json({ success: true, message: 'Linking started. Poll /api/whatsapp/status for the QR code.', whatsapp: waStatus(req.userId) });
  }));

  api.post('/whatsapp/link/pair', needVolume, linkLimiter, wrap(async (req, res) => {
    const code = await sessions.getOrCreate(req.userId).requestPairingCode(req.body?.phone);
    res.json({ success: true, pairingCode: code, message: 'In WhatsApp: Linked devices > Link a device > Link with phone number instead, then enter this code.' });
  }));

  api.post('/whatsapp/disconnect', wrap(async (req, res) => {
    const s = sessions.get(req.userId);
    if (s) await s.logout();
    else { try { (await import('node:fs')).rmSync(sessions.dirFor(req.userId), { recursive: true, force: true }); } catch { /* none */ } }
    await cpanel.whatsappStatus(req.userId, 'LOGGED_OUT').catch(() => {});
    res.json({ success: true, message: 'WhatsApp disconnected and its stored session was deleted.' });
  }));

  // ---------- Automation ----------
  api.get('/automation/status', wrap(async (req, res) => {
    const settings = await cpanel.getSettings(req.userId);
    res.json({ success: true, automation: settings, whatsapp: waStatus(req.userId), runningNow: scheduler.inFlight.has(req.userId), queuedForRetry: outbox.list(req.userId).length, serverTime: new Date().toISOString() });
  }));

  api.post('/automation/start', wrap(async (req, res) => {
    const s = sessions.get(req.userId);
    if (!s?.hasCredentials()) return res.status(409).json({ success: false, code: 'WHATSAPP_NOT_LINKED', message: 'Link WhatsApp first.' });
    const changes = { isEnabled: true };
    if (req.body?.intervalMinutes !== undefined) changes.intervalMinutes = Number(req.body.intervalMinutes);
    if (req.body?.importInitialEntries !== undefined) changes.importInitialEntries = !!req.body.importInitialEntries;
    res.json({ success: true, automation: await cpanel.setSettings(req.userId, changes), message: 'Automation started. First fetch runs within seconds.' });
  }));

  api.post('/automation/stop', wrap(async (req, res) => {
    res.json({ success: true, automation: await cpanel.setSettings(req.userId, { isEnabled: false }), message: 'Automation stopped.' });
  }));

  api.put('/automation/interval', wrap(async (req, res) => {
    let minutes = Number(req.body?.intervalMinutes);
    if (req.body?.value !== undefined) minutes = Number(req.body.value) * (req.body.unit === 'hours' ? 60 : 1);
    if (!Number.isFinite(minutes) || minutes < 5 || minutes > 1440) return res.status(400).json({ success: false, code: 'BAD_INTERVAL', message: 'Interval must be between 5 minutes and 24 hours.' });
    res.json({ success: true, automation: await cpanel.setSettings(req.userId, { intervalMinutes: Math.round(minutes) }), message: 'Interval updated.' });
  }));

  api.put('/automation/settings', wrap(async (req, res) => {
    const changes = {};
    if (req.body?.importInitialEntries !== undefined) changes.importInitialEntries = !!req.body.importInitialEntries;
    res.json({ success: true, automation: await cpanel.setSettings(req.userId, changes) });
  }));

  api.post('/automation/run-now', wrap(async (req, res) => {
    const r = await scheduler.runNow(req.userId);
    if (!r.accepted) {
      const status = r.reason === 'RATE_LIMITED' ? 429 : 409;
      return res.status(status).json({ success: false, code: r.reason, message: { RATE_LIMITED: `Please wait ${r.retryAfterSeconds}s before fetching again.`, ALREADY_RUNNING: 'A fetch is already running.', WHATSAPP_NOT_CONNECTED: 'WhatsApp is not connected.' }[r.reason], retryAfterSeconds: r.retryAfterSeconds });
    }
    res.status(202).json({ success: true, message: 'Fetch started. New entries will appear shortly.' });
  }));

  api.get('/automation/logs', wrap(async (req, res) => {
    res.json({ success: true, logs: await cpanel.logs(req.userId, Math.min(200, Number(req.query.limit) || 50)) });
  }));

  app.use('/api', api);
  app.use((req, res) => res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Not found' }));
  return app;
}
