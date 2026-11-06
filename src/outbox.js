import fs from 'node:fs';
import path from 'node:path';

/**
 * Durable queue (on the Railway volume) for parsed statements that could not be delivered to cPanel
 * (database down, network error, Railway restart in the middle). Delivery is idempotent on the cPanel
 * side (fetchId), and per-user ORDER is preserved so alignment against the previous statement stays valid.
 */
export class Outbox {
  constructor({ dir, cpanel, log }) {
    this.dir = path.join(dir, 'outbox'); this.cpanel = cpanel; this.log = log;
    this.busy = new Set();
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  enqueue(payload) {
    const name = `${String(Date.now()).padStart(15, '0')}_${payload.userId}_${payload.fetchId}.json`;
    const tmp = path.join(this.dir, name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
    fs.renameSync(tmp, path.join(this.dir, name));      // atomic
    return name;
  }

  list(userId = null) {
    return fs.readdirSync(this.dir).filter(f => f.endsWith('.json') && (!userId || f.includes(`_${userId}_`))).sort();
  }

  users() {
    return [...new Set(this.list().map(f => f.split('_')[1]))];
  }

  /** Deliver queued statements for one user, oldest first. Stops at the first retryable failure. */
  async flushUser(userId) {
    if (this.busy.has(userId)) return { delivered: [], pending: this.list(userId).length };
    this.busy.add(userId);
    const delivered = [];
    try {
      for (const f of this.list(userId)) {
        const full = path.join(this.dir, f);
        let payload;
        try { payload = JSON.parse(fs.readFileSync(full, 'utf8')); }
        catch { this.quarantine(f, 'unreadable'); continue; }
        try {
          const res = await this.cpanel.ingest(payload);
          fs.unlinkSync(full);
          delivered.push({ fetchId: payload.fetchId, result: res });
        } catch (e) {
          if (e.retryable) { this.log.warn(`outbox: cPanel not reachable, will retry (${e.message})`); break; }
          this.log.error(`outbox: permanent rejection, quarantined ${f}: ${e.message}`);
          this.quarantine(f, e.message);
        }
      }
    } finally { this.busy.delete(userId); }
    return { delivered, pending: this.list(userId).length };
  }

  quarantine(file, reason) {
    const dead = path.join(this.dir, 'dead'); fs.mkdirSync(dead, { recursive: true, mode: 0o700 });
    try { fs.renameSync(path.join(this.dir, file), path.join(dead, file)); fs.writeFileSync(path.join(dead, file + '.reason'), String(reason)); } catch { /* ignore */ }
  }
}
