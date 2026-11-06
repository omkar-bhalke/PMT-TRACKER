import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import { parseStatement, isIntermediateMessage, looksLikeStatement } from './statementParser.js';
import { unwrap, extractText, findMiniStatementOption, describeShape, MENU_HINT_RE, OPTION_RE, numberOf } from './messageUtils.js';

export class WaError extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

// Baileys DisconnectReason values (kept local so tests do not need to import Baileys)
const CODE = { loggedOut: 401, forbidden: 403, connectionReplaced: 440, restartRequired: 515, badSession: 500 };

/**
 * One WhatsApp session for ONE user. Credentials live in `dir` (Railway volume, mode 0700) and
 * are never returned by any API. The socket is created by an injectable factory so the real
 * Baileys client (src/baileysFactory.js) can be swapped for a test double in automated tests.
 *
 * Public state (what the Android app sees):
 *   DISCONNECTED | CONNECTING | QR_READY | PAIRING_CODE_READY | CONNECTED | RECONNECTING
 */
export class WhatsAppSession extends EventEmitter {
  constructor({ userId, dir, socketFactory, log, linkWindowMs = 180000, menuTimeoutMs = 45000, clickFallbackMs = 25000 }) {
    super();
    Object.assign(this, { userId, dir, socketFactory, log, linkWindowMs, menuTimeoutMs, clickFallbackMs });
    this.state = 'DISCONNECTED';
    this.sock = null; this.sendOptionReply = null; this.registered = false;
    this.qrDataUrl = null; this.pairingCode = null; this.phoneMasked = null; this.lastError = null;
    this.backoff = 0; this.reconnectTimer = null; this.stopping = false; this.linkDeadline = 0;
    this.job = null; this.seen = new Set(); this.lidMap = this.loadLidMap();
  }

  // ---------- persistence ----------
  hasCredentials() { return fs.existsSync(path.join(this.dir, 'creds.json')); }
  loadLidMap() { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'lid-map.json'), 'utf8')); } catch { return {}; } }
  saveLidMap() { try { fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(this.dir, 'lid-map.json'), JSON.stringify(this.lidMap), { mode: 0o600 }); } catch { /* ignore */ } }
  wipe() { try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ } this.lidMap = {}; }

  setState(s, err) {
    if (err !== undefined) this.lastError = err;
    if (this.state !== s) { this.state = s; this.emit('state', s); }
  }

  getPublicStatus() {
    return {
      state: this.state,
      connected: this.state === 'CONNECTED',
      hasSession: this.hasCredentials(),
      qrDataUrl: this.state === 'QR_READY' ? this.qrDataUrl : null,
      pairingCode: this.state === 'PAIRING_CODE_READY' ? this.pairingCode : null,
      phoneMasked: this.phoneMasked,
      lastError: this.lastError,
    };
  }

  // ---------- connection ----------
  /** Start (or resume) the socket. With stored credentials this reconnects silently. */
  async start() {
    if (this.sock) return;
    this.stopping = false;
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.setState(this.hasCredentials() ? 'RECONNECTING' : 'CONNECTING');
    const { sock, saveCreds, registered, sendOptionReply } = await this.socketFactory({ dir: this.dir });
    this.sock = sock; this.sendOptionReply = sendOptionReply; this.registered = !!registered;

    sock.ev.on('creds.update', async () => { try { await saveCreds(); } catch (e) { this.log.error(`saveCreds failed: ${e.message}`); } });
    sock.ev.on('connection.update', (u) => this.onConnection(u, sock));
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type && type !== 'notify') return;                       // ignore history sync / appended messages
      for (const m of messages || []) this.onMessage(m).catch(e => this.log.error(`message handler: ${e.message}`));
    });
  }

  async onConnection({ connection, lastDisconnect, qr }, sock) {
    if (sock !== this.sock) return;                                // event from a replaced socket
    if (qr && !this.registered && this.state !== 'PAIRING_CODE_READY') {
      try { this.qrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 300 }); this.setState('QR_READY'); }
      catch (e) { this.log.error(`QR render failed: ${e.message}`); }
    }
    if (connection === 'open') {
      this.backoff = 0; this.qrDataUrl = null; this.pairingCode = null; this.registered = true; this.lastError = null;
      const num = numberOf(sock.user?.id);
      this.phoneMasked = num ? '•'.repeat(Math.max(0, num.length - 4)) + num.slice(-4) : null;
      this.setState('CONNECTED');
      this.emit('connected');
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      await this.onClosed(code, lastDisconnect?.error?.message);
    }
  }

  async onClosed(code, msg) {
    this.sock = null; this.sendOptionReply = null;
    if (this.job) this.failJob(new WaError('DISCONNECTED', 'WhatsApp connection dropped during the fetch'));
    if (this.stopping) return;

    if (code === CODE.loggedOut || code === CODE.forbidden || code === CODE.badSession) {
      this.log.warn(`session ended by WhatsApp (code ${code}); credentials removed, re-link required`);
      this.wipe(); this.phoneMasked = null; this.qrDataUrl = null; this.pairingCode = null; this.registered = false;
      this.setState('DISCONNECTED', 'WhatsApp logged this device out. Please link again.');
      this.emit('loggedOut');
      return;
    }
    if (code === CODE.connectionReplaced) {
      this.setState('DISCONNECTED', 'This session was replaced by another login.');
      this.emit('disconnected');
      return;
    }
    if (code === CODE.restartRequired) { this.setState('CONNECTING'); return this.start().catch(e => this.scheduleReconnect(e.message)); }

    if (!this.registered && !this.hasCredentials()) {               // still linking: QR/code expired -> refresh until window ends
      if (Date.now() < this.linkDeadline) { this.reconnectTimer = setTimeout(() => this.start().catch(() => {}), 1000); return; }
      this.qrDataUrl = null; this.pairingCode = null;
      this.setState('DISCONNECTED', 'Linking timed out. Tap "Link WhatsApp" to try again.');
      return;
    }
    this.scheduleReconnect(msg);
  }

  scheduleReconnect(reason) {
    this.backoff = Math.min(60000, this.backoff ? this.backoff * 2 : 2000);
    this.log.warn(`reconnecting in ${this.backoff}ms (${reason || 'closed'})`);
    this.setState('RECONNECTING', reason ? `Connection lost: ${reason}` : this.lastError);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start().catch(e => this.scheduleReconnect(e.message)), this.backoff);
  }

  async stopSocket() {
    this.stopping = true; clearTimeout(this.reconnectTimer);
    const s = this.sock; this.sock = null;
    try { s?.end?.(undefined); } catch { /* ignore */ }
  }

  /** Begin linking a NEW account (QR). Existing unfinished attempts are reset. */
  async startLinking() {
    if (this.state === 'CONNECTED') throw new WaError('ALREADY_LINKED', 'WhatsApp is already linked. Disconnect first.');
    await this.stopSocket();
    if (!this.registered) this.wipe();
    this.linkDeadline = Date.now() + this.linkWindowMs;
    this.qrDataUrl = null; this.pairingCode = null; this.lastError = null;
    await this.start();
  }

  /** Link with an 8-character pairing code instead of a QR. */
  async requestPairingCode(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (digits.length < 10 || digits.length > 15) throw new WaError('BAD_PHONE', 'Enter your WhatsApp number with country code, e.g. 919876543210');
    if (this.state === 'CONNECTED') throw new WaError('ALREADY_LINKED', 'WhatsApp is already linked.');
    if (!this.sock) await this.startLinking();
    for (let i = 0; i < 30 && !this.sock?.requestPairingCode; i++) await new Promise(r => setTimeout(r, 500));
    // WhatsApp only accepts the request once the socket has started its handshake
    await new Promise(r => setTimeout(r, 1500));
    const code = await this.sock.requestPairingCode(digits);
    this.pairingCode = code; this.setState('PAIRING_CODE_READY');
    return code;
  }

  async logout() {
    this.stopping = true; clearTimeout(this.reconnectTimer);
    if (this.job) this.failJob(new WaError('DISCONNECTED', 'Session disconnected by user'));
    const s = this.sock; this.sock = null;
    try { await s?.logout?.(); } catch { /* may already be closed */ }
    try { s?.end?.(undefined); } catch { /* ignore */ }
    this.wipe();
    this.qrDataUrl = null; this.pairingCode = null; this.phoneMasked = null; this.registered = false;
    this.setState('DISCONNECTED', null);
  }

  // ---------- SBI statement cycle ----------
  /**
   * STEP 1 send "Hi" -> STEP 2/3 find and pick "Get Mini Statement" -> STEP 4 ignore the "please wait" message
   * -> STEP 5 resolve with the real statement. Rejects with WaError(code) on timeout / disconnect / format change.
   */
  runStatementCycle({ targetNumber, timeoutMs = 120000 }) {
    if (this.state !== 'CONNECTED' || !this.sock) return Promise.reject(new WaError('NOT_CONNECTED', 'WhatsApp is not connected'));
    if (this.job) return Promise.reject(new WaError('BUSY', 'A fetch is already in progress for this user'));
    const target = String(targetNumber).replace(/\D/g, '');
    const job = { target, jid: `${target}@s.whatsapp.net`, stage: 'sending_hi', startedAt: Date.now(), clicks: 0, events: [], timers: [] };
    this.job = job;

    return new Promise((resolve, reject) => {
      job.resolve = resolve; job.reject = reject;
      job.timers.push(setTimeout(() => this.failJob(new WaError('TIMEOUT', `No complete statement within ${Math.round(timeoutMs / 1000)}s (stage: ${job.stage})`, { stage: job.stage, events: job.events })), timeoutMs));
      job.timers.push(setTimeout(() => { if (job.stage === 'waiting_menu') this.failJob(new WaError('NO_MENU', 'SBI did not show the menu after "Hi"', { stage: job.stage, events: job.events })); }, this.menuTimeoutMs));
      this.sock.sendMessage(job.jid, { text: 'Hi' })
        .then(() => { if (this.job === job) { job.stage = 'waiting_menu'; job.sentHiAt = Date.now(); job.events.push('sent:Hi'); } })
        .catch(e => this.failJob(new WaError('SEND_FAILED', `Could not send "Hi": ${e.message}`)));
    });
  }

  finishJob() { const j = this.job; if (!j) return null; j.timers.forEach(clearTimeout); this.job = null; return j; }
  failJob(err) { const j = this.finishJob(); if (j) j.reject(err); }

  isFromTarget(msg, content, job) {
    const k = msg.key || {};
    const cands = [k.remoteJid, k.remoteJidAlt, k.senderPn, k.participantPn, k.participant, k.participantAlt];
    if (cands.some(j => j && j.endsWith('@s.whatsapp.net') && numberOf(j) === job.target)) return true;
    if (k.remoteJid?.endsWith('@lid')) {
      const learned = this.lidMap[job.target];
      if (learned) return learned === k.remoteJid;
      // First ever contact: WhatsApp hides the number behind a LID. Trust it ONLY if it answers our "Hi"
      // with the SBI menu, then remember it so later messages are matched strictly.
      const text = extractText(content);
      if (job.stage === 'waiting_menu' && (findMiniStatementOption(content) || OPTION_RE.test(text) || MENU_HINT_RE.test(text))) {
        this.lidMap[job.target] = k.remoteJid; this.saveLidMap();
        this.log.info('learned SBI LID mapping');
        return true;
      }
    }
    return false;
  }

  async onMessage(msg) {
    const job = this.job;
    if (!job || !msg?.message || msg.key?.fromMe) return;
    if (msg.key.remoteJid === 'status@broadcast' || msg.key.remoteJid?.endsWith('@g.us')) return;
    const id = msg.key.id; if (id) { if (this.seen.has(id)) return; this.seen.add(id); if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value); }
    const ts = Number(msg.messageTimestamp?.low ?? msg.messageTimestamp ?? 0) * 1000;
    if (ts && job.sentHiAt && ts < job.startedAt - 5000) return;       // older than this cycle

    const content = unwrap(msg.message);
    if (!this.isFromTarget(msg, content, job)) return;
    const text = extractText(content);
    job.events.push(`recv:${describeShape(content)}`);

    if (job.stage === 'waiting_menu' || job.stage === 'waiting_statement') {
      if (isIntermediateMessage(text)) { job.events.push('intermediate'); job.stage = 'waiting_statement'; return; }
    }

    if (job.stage === 'waiting_menu') {
      const option = findMiniStatementOption(content);
      if (option || OPTION_RE.test(text) || MENU_HINT_RE.test(text)) {
        await this.chooseOption(job, msg, content, option);
      }
      return;
    }

    if (job.stage === 'waiting_statement') {
      const parsed = parseStatement(text);
      if (parsed.ok) {
        const j = this.finishJob();
        j.resolve({ text, parsed: parsed.statement, warnings: parsed.warnings, events: j.events });
        return;
      }
      if (looksLikeStatement(text)) {                                  // balance line present but unreadable => format changed
        this.failJob(new WaError('PARSE_FAILED', `Statement format not understood (${parsed.reason})`, { reason: parsed.reason, excerpt: text.slice(0, 300), unparsed: parsed.unparsed }));
        return;
      }
      const option = findMiniStatementOption(content);
      if (option && job.clicks < 2) { await this.chooseOption(job, msg, content, option); return; }   // menu shown again
      job.events.push('unexpected-reply');
      job.lastUnexpected = text.slice(0, 200);
      this.emit('unexpected', { text: text.slice(0, 200) });
    }
  }

  async chooseOption(job, msg, content, option) {
    job.clicks++;
    try {
      if (option && this.sendOptionReply) {
        job.events.push(`click:${option.kind}`);
        await this.sendOptionReply(job.jid, msg, option);
      } else {
        job.events.push('text:Get Mini Statement');
        await this.sock.sendMessage(job.jid, { text: 'Get Mini Statement' });
      }
      job.stage = 'waiting_statement';
      // If a structural click is silently ignored, fall back once to a plain text reply.
      if (option && this.sendOptionReply && job.clicks === 1) {
        job.timers.push(setTimeout(async () => {
          if (this.job === job && job.stage === 'waiting_statement' && !job.events.includes('intermediate')) {
            try { job.events.push('fallback-text'); await this.sock?.sendMessage(job.jid, { text: 'Get Mini Statement' }); } catch { /* ignore */ }
          }
        }, this.clickFallbackMs));
      }
    } catch (e) {
      this.failJob(new WaError('SEND_FAILED', `Could not select the menu option: ${e.message}`));
    }
  }
}
