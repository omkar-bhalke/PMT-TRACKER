import fs from 'node:fs';
import path from 'node:path';
import { WhatsAppSession } from './whatsappSession.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Holds one WhatsAppSession per user. Sessions are restored from the Railway volume on boot. */
export class SessionManager {
  constructor({ cfg, cpanel, socketFactory, makeLog, onConnected }) {
    this.cfg = cfg; this.cpanel = cpanel; this.socketFactory = socketFactory; this.makeLog = makeLog;
    this.onConnected = onConnected || (() => {});
    this.sessions = new Map();
    this.root = path.join(cfg.dataDir, 'sessions');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  dirFor(userId) {
    if (!SAFE_ID.test(userId)) throw new Error('invalid user id');
    return path.join(this.root, userId);
  }

  get(userId) { return this.sessions.get(userId) || null; }

  getOrCreate(userId) {
    let s = this.sessions.get(userId);
    if (s) return s;
    s = new WhatsAppSession({
      userId, dir: this.dirFor(userId), socketFactory: this.socketFactory, log: this.makeLog(`wa:${userId.slice(-6)}`),
      linkWindowMs: this.cfg.linkWindowMs, menuTimeoutMs: this.cfg.menuTimeoutMs,
    });
    s.on('state', (st) => this.report(userId, s, st));
    s.on('connected', () => this.onConnected(userId));
    s.on('loggedOut', () => this.cpanel.whatsappStatus(userId, 'LOGGED_OUT', { error: s.lastError }).catch(() => {}));
    this.sessions.set(userId, s);
    return s;
  }

  report(userId, s, st) {
    const map = { CONNECTED: 'CONNECTED', RECONNECTING: 'RECONNECTING', CONNECTING: 'LINKING', QR_READY: 'LINKING', PAIRING_CODE_READY: 'LINKING', DISCONNECTED: 'DISCONNECTED' };
    this.cpanel.whatsappStatus(userId, map[st] || 'DISCONNECTED', { phoneMasked: s.phoneMasked, error: s.lastError || undefined }).catch(() => { /* cPanel may be down; status is re-sent on next change */ });
  }

  /** Reconnect every user that still has credentials on the volume (called at boot, staggered). */
  async restoreAll() {
    const dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter(d => d.isDirectory() && SAFE_ID.test(d.name));
    let n = 0;
    for (const d of dirs) {
      if (!fs.existsSync(path.join(this.root, d.name, 'creds.json'))) continue;
      const s = this.getOrCreate(d.name);
      s.start().catch(e => s.scheduleReconnect(e.message));
      n++;
      await new Promise(r => setTimeout(r, 1500));
    }
    return n;
  }

  async shutdown() {
    for (const s of this.sessions.values()) await s.stopSocket();
  }
}
