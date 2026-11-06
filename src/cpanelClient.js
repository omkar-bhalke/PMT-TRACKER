import crypto from 'node:crypto';

export class CpanelError extends Error {
  constructor(message, { status = 0, code = 'CPANEL_ERROR', retryable = false } = {}) {
    super(message);
    this.status = status; this.code = code; this.retryable = retryable;
  }
}

/**
 * HMAC-signed client for the cPanel API (see CPANEL_BACKEND/middleware/ServiceAuth.php).
 * The shared secret never leaves this process; every call names its user explicitly.
 */
export class CpanelClient {
  constructor({ baseUrl, secret, timeoutMs = 20000, fetchImpl = fetch }) {
    this.baseUrl = baseUrl; this.secret = secret; this.timeoutMs = timeoutMs; this.fetch = fetchImpl;
  }

  sign(method, route, query, body) {
    const ts = String(Math.floor(Date.now() / 1000));
    const msg = `${ts}\n${method}\n${route}?${query}\n${crypto.createHash('sha256').update(body).digest('hex')}`;
    return { ts, sig: crypto.createHmac('sha256', this.secret).update(msg).digest('hex') };
  }

  async call(method, route, { query = {}, body } = {}) {
    const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString();
    const bodyStr = body === undefined ? '' : JSON.stringify(body);
    const { ts, sig } = this.sign(method, route, qs, bodyStr);
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/api/${route}${qs ? '?' + qs : ''}`, {
        method,
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Service-Timestamp': ts, 'X-Service-Signature': sig },
        body: bodyStr || undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new CpanelError(`cPanel unreachable: ${e.message}`, { code: 'UNREACHABLE', retryable: true });
    }
    let data = null;
    try { data = await res.json(); } catch { /* non-JSON */ }
    if (!res.ok || !data || data.success === false) {
      throw new CpanelError(data?.message || `HTTP ${res.status}`, {
        status: res.status, code: data?.code || `HTTP_${res.status}`, retryable: res.status >= 500 || res.status === 0,
      });
    }
    return data;
  }

  /** Validates an Android user token WITHOUT sharing the JWT secret: cPanel decides. */
  async verifyUserToken(authorization, deviceId) {
    let res;
    try {
      res = await this.fetch(`${this.baseUrl}/api/auth/verify`, {
        headers: { Authorization: authorization, ...(deviceId ? { 'X-Device-Id': deviceId } : {}), Accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) { throw new CpanelError('cPanel unreachable', { code: 'UNREACHABLE', retryable: true }); }
    const data = await res.json().catch(() => null);
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok || !data?.success) throw new CpanelError(data?.message || `HTTP ${res.status}`, { status: res.status, retryable: res.status >= 500 });
    return data.userId;
  }

  dueJobs(limit) { return this.call('GET', 'internal/jobs/due', { query: { limit } }).then(d => d.jobs); }
  claim(userId, lockSeconds, manual = false) { return this.call('POST', 'internal/jobs/claim', { body: { userId, lockSeconds, manual } }); }
  complete(p) { return this.call('POST', 'internal/jobs/complete', { body: p }); }
  resume(userId) { return this.call('POST', 'internal/jobs/resume', { body: { userId } }); }
  getSettings(userId) { return this.call('GET', 'internal/automation/settings', { query: { userId } }).then(d => d.settings); }
  setSettings(userId, changes) { return this.call('POST', 'internal/automation/settings', { body: { userId, ...changes } }).then(d => d.settings); }
  whatsappStatus(userId, status, extra = {}) { return this.call('POST', 'internal/whatsapp/status', { body: { userId, status, ...extra } }); }
  log(userId, eventType, message, details) { return this.call('POST', 'internal/automation/log', { body: { userId, eventType, message, details } }); }
  logs(userId, limit) { return this.call('GET', 'internal/automation/logs', { query: { userId, limit } }).then(d => d.logs); }
  ingest(payload) { return this.call('POST', 'internal/statements/ingest', { body: payload }); }
}
