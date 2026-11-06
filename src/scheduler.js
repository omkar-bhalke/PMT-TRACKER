import crypto from 'node:crypto';

/**
 * DB-driven scheduler. The schedule, the lock and the retry counter live in cPanel MySQL
 * (automation_settings), so a Railway restart loses nothing: on boot this loop simply asks
 * "which users are due?" again. A per-user DB lock (with expiry) prevents two cycles for one user,
 * even across two Railway instances or a crash in the middle of a cycle.
 */
export class Scheduler {
  constructor({ cfg, cpanel, sessions, outbox, log }) {
    Object.assign(this, { cfg, cpanel, sessions, outbox, log });
    this.inFlight = new Map();       // userId -> startedAt
    this.lastRunNow = new Map();     // userId -> ms
    this.timer = null; this.ticking = false; this.lastTickError = null;
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), this.cfg.tickMs);
  }
  stop() { clearInterval(this.timer); }

  async tick() {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const userId of this.outbox.users()) await this.outbox.flushUser(userId).catch(() => {});
      const free = this.cfg.maxConcurrentCycles - this.inFlight.size;
      if (free > 0) {
        const jobs = await this.cpanel.dueJobs(free + 5);
        for (const j of jobs) {
          if (this.inFlight.size >= this.cfg.maxConcurrentCycles) break;
          if (this.inFlight.has(j.userId)) continue;
          await this.launch(j.userId, false).catch(e => this.log.warn(`launch failed: ${e.message}`));
        }
      }
      this.lastTickError = null;
    } catch (e) {
      this.lastTickError = e.message;
      this.log.warn(`tick failed (will retry): ${e.message}`);       // e.g. cPanel/DB down: nothing is lost, jobs stay due
    } finally { this.ticking = false; }
  }

  /** Manual "run now". Returns {accepted, reason?}. */
  async runNow(userId) {
    const last = this.lastRunNow.get(userId) || 0;
    const wait = this.cfg.runNowMinGapMs - (Date.now() - last);
    if (wait > 0) return { accepted: false, reason: 'RATE_LIMITED', retryAfterSeconds: Math.ceil(wait / 1000) };
    if (this.inFlight.has(userId)) return { accepted: false, reason: 'ALREADY_RUNNING' };
    const s = this.sessions.get(userId);
    if (!s || s.state !== 'CONNECTED') return { accepted: false, reason: 'WHATSAPP_NOT_CONNECTED' };
    const r = await this.launch(userId, true);
    if (r) this.lastRunNow.set(userId, Date.now());
    return r ? { accepted: true } : { accepted: false, reason: 'ALREADY_RUNNING' };
  }

  async launch(userId, manual) {
    if (this.inFlight.has(userId)) return false;
    const lockSeconds = Math.ceil(this.cfg.cycleTimeoutMs / 1000) + 60;
    const claim = await this.cpanel.claim(userId, lockSeconds, manual);
    if (!claim.claimed) return false;
    this.inFlight.set(userId, Date.now());
    this.runClaimed(userId, claim).finally(() => this.inFlight.delete(userId));
    return true;
  }

  async finish(userId, claim, status, { error, message, retryInSeconds, details } = {}) {
    try {
      await this.cpanel.complete({ userId, lockToken: claim.lockToken, status, error, message, retryInSeconds, details });
    } catch (e) {
      // lock simply expires; the job becomes due again. Never lose the cycle silently:
      this.log.error(`could not save job result for ${userId}: ${e.message}`);
    }
  }

  async runClaimed(userId, claim) {
    const session = this.sessions.get(userId);
    const retry = 120 * (1 + (claim.retryCount || 0));
    if (!session || session.state !== 'CONNECTED') {
      return this.finish(userId, claim, 'PAUSED_DISCONNECTED', { error: 'WhatsApp is not connected. Automation paused; it resumes automatically after you link again.', message: 'Paused: WhatsApp disconnected' });
    }

    let result;
    session.setTarget(claim.targetNumber);
    try {
      result = await session.runStatementCycle({ targetNumber: claim.targetNumber, timeoutMs: this.cfg.cycleTimeoutMs });
    } catch (e) {
      const details = { stage: e.stage, events: e.events, reason: e.reason, excerpt: e.excerpt, unparsed: e.unparsed };
      switch (e.code) {
        case 'DISCONNECTED': case 'NOT_CONNECTED':
          return this.finish(userId, claim, 'PAUSED_DISCONNECTED', { error: e.message, message: 'Paused: WhatsApp disconnected', details });
        case 'TIMEOUT': case 'NO_MENU':
          return this.finish(userId, claim, 'NO_RESPONSE', { error: `SBI did not respond in time: ${e.message}`, message: 'SBI did not respond', retryInSeconds: retry, details });
        case 'PARSE_FAILED':
          return this.finish(userId, claim, 'PARSE_ERROR', { error: 'Statement format changed; the parser could not read it. No data was saved.', message: e.message, details });
        default:
          return this.finish(userId, claim, 'ERROR', { error: e.message, message: e.message, retryInSeconds: retry, details });
      }
    }

    // Statement received -> durable queue first, then deliver (idempotent by fetchId).
    const s = result.parsed;
    const payload = {
      userId, fetchId: crypto.randomUUID(), accountMasked: s.accountMasked, balance: s.balance, balanceType: s.balanceType,
      statementAt: s.statementAt, statementRaw: s.statementRaw, capturedAt: new Date().toISOString(),
      entries: s.entries.map(e => ({ date: e.date, amount: e.amount, type: e.type, description: e.description, suggestedCategory: e.suggestedCategory })),
    };
    this.outbox.enqueue(payload);
    const flush = await this.outbox.flushUser(userId);
    const delivered = flush.delivered.find(d => d.fetchId === payload.fetchId);
    if (!delivered) {
      return this.finish(userId, claim, 'DB_ERROR', { error: 'Statement received but could not be saved to the database yet. It is queued and will be retried automatically.', message: 'Queued for retry', retryInSeconds: 120 });
    }
    const r = delivered.result;
    return this.finish(userId, claim, 'SUCCESS', { message: r.message, details: { newEntries: r.newEntries, balance: r.balance, duplicate: r.duplicate, warnings: result.warnings } });
  }

  /** Called when a user's WhatsApp (re)connects: un-pause the job. */
  async onWhatsappConnected(userId) {
    try { await this.cpanel.resume(userId); } catch (e) { this.log.warn(`resume failed: ${e.message}`); }
  }
}
