/**
 * End-to-end test against REAL components: PHP cPanel API + MariaDB + this Railway code.
 * Only the WhatsApp socket is a test double (see helpers/fakeWhatsapp.js).
 * Requires:  CPANEL_TEST_URL (e.g. http://127.0.0.1:8081)  SERVICE_SECRET  and `mysql` CLI access to DB fp_test.
 * Skipped automatically when CPANEL_TEST_URL is not set.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadConfig } from '../src/config.js';
import { makeLogger } from '../src/logger.js';
import { CpanelClient } from '../src/cpanelClient.js';
import { Outbox } from '../src/outbox.js';
import { SessionManager } from '../src/sessionManager.js';
import { Scheduler } from '../src/scheduler.js';
import { createApp } from '../src/app.js';
import { makeFakeWhatsApp, statement } from './helpers/fakeWhatsapp.js';

const BASE = process.env.CPANEL_TEST_URL;
const SECRET = process.env.SERVICE_SECRET;
const skip = !BASE || !SECRET;
const sql = (q) => execSync(`mysql -N -B fp_test -e ${JSON.stringify(q)}`).toString().trim();

const api = async (url, { method = 'GET', token, body, headers = {} } = {}) => {
  const r = await fetch(url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const until = async (fn, ms = 8000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await new Promise(r => setTimeout(r, 25)); } return false; };

async function boot(dataDir, fake, overrides = {}) {
  const cfg = { ...loadConfig({ CPANEL_API_URL: BASE, SERVICE_SECRET: SECRET, DATA_DIR: dataDir }), cycleTimeoutMs: 2500, menuTimeoutMs: 1000, runNowMinGapMs: 0, ...overrides };
  const makeLog = makeLogger('error');
  const cpanel = new CpanelClient({ baseUrl: BASE, secret: SECRET, timeoutMs: 5000 });
  const outbox = new Outbox({ dir: dataDir, cpanel, log: makeLog('outbox') });
  let scheduler;
  const sessions = new SessionManager({ cfg, cpanel, makeLog, socketFactory: fake.factory, onConnected: (u) => scheduler.onWhatsappConnected(u) });
  scheduler = new Scheduler({ cfg, cpanel, sessions, outbox, log: makeLog('scheduler') });
  const app = createApp({ cfg, cpanel, sessions, scheduler, outbox, log: makeLog('app') });
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  return { cfg, cpanel, outbox, sessions, scheduler, server, url: `http://127.0.0.1:${server.address().port}` };
}

async function register(name) {
  const email = `${name}_${crypto.randomBytes(3).toString('hex')}@test.com`;
  const r = await api(`${BASE}/api/auth/register`, { method: 'POST', body: { name, email, password: 'Passw0rd!xyz', confirmPassword: 'Passw0rd!xyz', deviceId: `dev-${crypto.randomUUID()}` } });
  assert.equal(r.body.success, true, JSON.stringify(r.body));
  return { token: r.body.token, id: r.body.user.id };
}

const cycle = async (R, uid) => {                       // make the user's job due, tick, wait for completion
  sql(`UPDATE automation_settings SET next_run_at = NOW(), lock_until = NULL, lock_token = NULL WHERE user_id='${uid}'`);
  await R.scheduler.tick();
  await until(() => R.scheduler.inFlight.size === 0);
  return sql(`SELECT last_status FROM automation_settings WHERE user_id='${uid}'`);
};
const pendingOf = (token) => api(`${BASE}/api/pending-transactions`, { token });

test('full flow against real PHP + MySQL', { skip, timeout: 120000 }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fp-'));
  const fake = makeFakeWhatsApp();
  let R = await boot(dir, fake);
  const A = await register('alice'), B = await register('bob');
  const RA = (p, o = {}) => api(`${R.url}/api${p}`, { token: A.token, ...o });

  await t.test('Railway API needs a valid per-user token', async () => {
    assert.equal((await api(`${R.url}/api/whatsapp/status`)).status, 401);
    assert.equal((await api(`${R.url}/api/whatsapp/status`, { token: 'garbage' })).status, 401);
    const s = await RA('/whatsapp/status');
    assert.equal(s.body.whatsapp.state, 'DISCONNECTED');
    assert.equal((await RA('/automation/start', { method: 'POST', body: {} })).status, 409);   // not linked yet
  });

  await t.test('link WhatsApp -> CONNECTED, status mirrored in MySQL', async () => {
    await R.sessions.getOrCreate(A.id).start();
    assert.ok(await until(() => R.sessions.get(A.id).state === 'CONNECTED'));
    const s = await RA('/whatsapp/status');
    assert.equal(s.body.whatsapp.state, 'CONNECTED');
    assert.ok(!JSON.stringify(s.body).includes('fake'), 'credentials must never be exposed');
    assert.ok(await until(() => sql(`SELECT status FROM whatsapp_sessions WHERE user_id='${A.id}'`) === 'CONNECTED'));
  });

  await t.test('interval validation + start', async () => {
    assert.equal((await RA('/automation/interval', { method: 'PUT', body: { intervalMinutes: 1 } })).status, 400);
    const st = await RA('/automation/start', { method: 'POST', body: { intervalMinutes: 30 } });
    assert.equal(st.status, 200); assert.equal(st.body.automation.isEnabled, true); assert.equal(st.body.automation.intervalMinutes, 30);
    assert.equal((await RA('/automation/interval', { method: 'PUT', body: { value: 2, unit: 'hours' } })).body.automation.intervalMinutes, 120);
  });

  const S1 = statement({ bal: '433.77', lines: ['04/11/2026: 20.00 DR,BY TRFR', '04/11/2026: 41.00 DR,BY TRFR', '04/11/2026: 5.00 DR,BY TRFR', '04/11/2026: 25.00 DR,BY TRFR', '03/11/2026: 100.00 DR,BY TRFR'] });

  await t.test('Hi -> menu -> Get Mini Statement -> wait msg ignored -> statement stored as BASELINE (no flood)', async () => {
    fake.script.statements.push(S1);
    assert.equal(await cycle(R, A.id), 'SUCCESS');
    assert.deepEqual(fake.script.sent.slice(0, 1), ['Hi']);
    assert.equal(fake.script.clicks[0].title, 'Get Mini Statement📑');
    const bal = (await api(`${BASE}/api/balance/current`, { token: A.token })).body;
    assert.equal(bal.currentBalance, 433.77); assert.equal(bal.accountNumber, 'xxx188');
    assert.equal((await pendingOf(A.token)).body.count, 0);          // baseline: nothing imported
    assert.match(sql(`SELECT message FROM automation_logs WHERE user_id='${A.id}' AND event_type='CYCLE_SUCCESS' ORDER BY created_at DESC LIMIT 1`), /baseline/);
  });

  await t.test('balance 433.77 -> 333.77: ONE new entry found, difference -100 explained by it', async () => {
    fake.script.statements.push(statement({ at: '05/11/2026, 11:00', bal: '333.77', lines: ['05/11/2026: 100.00 DR,BY TRFR', '04/11/2026: 20.00 DR,BY TRFR', '04/11/2026: 41.00 DR,BY TRFR', '04/11/2026: 5.00 DR,BY TRFR', '04/11/2026: 25.00 DR,BY TRFR'] }));
    assert.equal(await cycle(R, A.id), 'SUCCESS');
    const bal = (await api(`${BASE}/api/balance/current`, { token: A.token })).body;
    assert.equal(bal.currentBalance, 333.77); assert.equal(bal.previousBalance, 433.77); assert.equal(bal.balanceDifference, -100);
    const p = (await pendingOf(A.token)).body;
    assert.equal(p.count, 1); assert.equal(p.items[0].amount, 100); assert.equal(p.items[0].type, 'DEBIT'); assert.equal(p.items[0].status, 'PENDING');
    assert.equal(sql(`SELECT discrepancy IS NULL FROM balance_history WHERE user_id='${A.id}' ORDER BY seq DESC LIMIT 1`), '1');
    assert.equal(sql(`SELECT COUNT(*) FROM transactions WHERE user_id='${A.id}'`), '0');   // never auto-confirmed / balance diff not turned into a txn
  });

  await t.test('phone OFF for hours: 3 entries queue as PENDING (20 DR, 41 DR, 500 CR)', async () => {
    fake.script.statements.push(statement({ at: '05/11/2026, 16:00', bal: '772.77', lines: ['05/11/2026: 500.00 CR,BY TRFR', '05/11/2026: 41.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 100.00 DR,BY TRFR', '04/11/2026: 20.00 DR,BY TRFR'] }));
    assert.equal(await cycle(R, A.id), 'SUCCESS');
    const p = (await pendingOf(A.token)).body;
    assert.equal(p.count, 4);
    const sig = p.items.map(i => `${i.type}${i.amount}`).sort();
    assert.deepEqual(sig, ['CREDIT500', 'DEBIT100', 'DEBIT20', 'DEBIT41']);
  });

  await t.test('duplicate statement -> nothing new', async () => {
    fake.script.statements.push(statement({ at: '05/11/2026, 16:00', bal: '772.77', lines: ['05/11/2026: 500.00 CR,BY TRFR', '05/11/2026: 41.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 100.00 DR,BY TRFR', '04/11/2026: 20.00 DR,BY TRFR'] }));
    assert.equal(await cycle(R, A.id), 'SUCCESS');
    assert.equal((await pendingOf(A.token)).body.count, 4);
  });

  await t.test('two IDENTICAL new lines are both kept', async () => {
    fake.script.statements.push(statement({ at: '05/11/2026, 17:00', bal: '732.77', lines: ['05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 500.00 CR,BY TRFR', '05/11/2026: 41.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR'] }));
    assert.equal(await cycle(R, A.id), 'SUCCESS');
    assert.equal((await pendingOf(A.token)).body.count, 6);
  });

  await t.test('phone back online: sync answers idempotently, ledger gets user-confirmed rows only', async () => {
    const items = (await pendingOf(A.token)).body.items;
    assert.equal(items[0].transactionDate <= items[items.length - 1].transactionDate, true, 'oldest first');
    const chosen = [...items.filter(i => i.type === 'DEBIT').slice(0, 2), items.find(i => i.type === 'CREDIT')];
    const confs = chosen.map((i, k) => ({ pendingTransactionId: i.id, categoryName: i.type === 'CREDIT' ? 'Pocket Money' : 'Food & Dining', purpose: `Purpose ${k}` }));
    const s1 = await api(`${BASE}/api/pending-transactions/sync`, { method: 'POST', token: A.token, body: { confirmations: confs } });
    assert.deepEqual(s1.body.results.map(r => r.status), ['CONFIRMED', 'CONFIRMED', 'CONFIRMED']);
    assert.equal(s1.body.count, 3);
    const s2 = await api(`${BASE}/api/pending-transactions/sync`, { method: 'POST', token: A.token, body: { confirmations: confs } });       // retry after a network drop
    assert.deepEqual(s2.body.results.map(r => r.status), ['ALREADY_CONFIRMED', 'ALREADY_CONFIRMED', 'ALREADY_CONFIRMED']);
    assert.equal(sql(`SELECT COUNT(*) FROM transactions WHERE user_id='${A.id}'`), '3');
    assert.equal(sql(`SELECT current_balance FROM accounts WHERE user_id='${A.id}' AND is_primary=1`), '732.77');   // bank balance not double-adjusted
    assert.equal(sql(`SELECT COUNT(*) FROM categories WHERE user_id='${A.id}' AND category_name='Pocket Money' AND category_type='INCOME'`), '1');
    const bad = await api(`${BASE}/api/pending-transactions/confirm`, { method: 'POST', token: A.token, body: { pendingTransactionId: s1.body.items[0].id, categoryName: 'Other', purpose: '' } });
    assert.equal(bad.status, 422);                               // purpose is mandatory: never auto-guessed
  });

  await t.test('snooze keeps it pending; another user cannot see or confirm it', async () => {
    const it = (await pendingOf(A.token)).body.items[0];
    const sn = await api(`${BASE}/api/pending-transactions/snooze`, { method: 'POST', token: A.token, body: { pendingTransactionId: it.id, minutes: 30 } });
    assert.equal(sn.body.updated, true);
    const again = (await pendingOf(A.token)).body.items.find(i => i.id === it.id);
    assert.equal(again.status, 'PENDING'); assert.equal(again.isSnoozed, true);
    assert.equal((await pendingOf(B.token)).body.count, 0);
    const steal = await api(`${BASE}/api/pending-transactions/confirm`, { method: 'POST', token: B.token, body: { pendingTransactionId: it.id, categoryName: 'X', purpose: 'steal' } });
    assert.equal(steal.status, 404);
    assert.equal((await api(`${R.url}/api/automation/logs`, { token: B.token })).body.logs.length, 0);   // B sees none of A's logs
  });

  await t.test('SBI silent -> NO_RESPONSE, retry scheduled, lock released (not stuck RUNNING)', async () => {
    fake.script.respond = false;
    assert.equal(await cycle(R, A.id), 'NO_RESPONSE');
    assert.equal(sql(`SELECT retry_count FROM automation_settings WHERE user_id='${A.id}'`), '1');
    assert.equal(sql(`SELECT lock_token IS NULL FROM automation_settings WHERE user_id='${A.id}'`), '1');
    assert.equal(sql(`SELECT next_run_at > NOW() FROM automation_settings WHERE user_id='${A.id}'`), '1');
    fake.script.respond = true;
  });

  await t.test('statement format change -> PARSE_ERROR, nothing stored, balance untouched', async () => {
    fake.script.statements.push('05/11/2026, 18:00\nAvailable Balance in A/c xxx188: Rs. 999.00 CR\n05/11/2026: Rs twenty DR BY TRFR');
    assert.equal(await cycle(R, A.id), 'PARSE_ERROR');
    assert.equal((await api(`${BASE}/api/balance/current`, { token: A.token })).body.currentBalance, 732.77);
  });

  await t.test('cPanel/DB failure after statement received -> queued on volume, delivered once later', async () => {
    const realIngest = R.cpanel.ingest.bind(R.cpanel);
    R.cpanel.ingest = async () => { const { CpanelError } = await import('../src/cpanelClient.js'); throw new CpanelError('db down', { retryable: true, code: 'UNREACHABLE' }); };
    fake.script.statements.push(statement({ at: '05/11/2026, 19:00', bal: '700.77', lines: ['05/11/2026: 32.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 500.00 CR,BY TRFR', '05/11/2026: 41.00 DR,BY TRFR'] }));
    assert.equal(await cycle(R, A.id), 'DB_ERROR');
    assert.equal(R.outbox.list(A.id).length, 1);
    R.cpanel.ingest = realIngest;
    const before = (await pendingOf(A.token)).body.count;
    await R.outbox.flushUser(A.id);
    assert.equal(R.outbox.list(A.id).length, 0);
    assert.equal((await pendingOf(A.token)).body.count, before + 1);
    await R.outbox.flushUser(A.id);                                    // nothing left -> no duplicate
    assert.equal((await pendingOf(A.token)).body.count, before + 1);
  });

  await t.test('WhatsApp drops -> job PAUSED_DISCONNECTED with error; reconnect resumes it', async () => {
    const sock = fake.script.sockets.at(-1);
    sock.ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 428 }, message: 'closed' } } });
    assert.equal(R.sessions.get(A.id).state, 'RECONNECTING');
    assert.equal(await cycle(R, A.id), 'PAUSED_DISCONNECTED');
    assert.ok(sql(`SELECT last_error FROM automation_settings WHERE user_id='${A.id}'`).length > 5);
    assert.equal(sql(`SELECT next_run_at IS NULL FROM automation_settings WHERE user_id='${A.id}'`), '1');
    assert.ok(await until(() => R.sessions.get(A.id).state === 'CONNECTED', 10000), 'auto-reconnect');
    assert.ok(await until(() => sql(`SELECT last_status FROM automation_settings WHERE user_id='${A.id}'`) === 'IDLE'));
    assert.equal(sql(`SELECT next_run_at IS NOT NULL FROM automation_settings WHERE user_id='${A.id}'`), '1');
  });

  await t.test('no double cycle: concurrent claims -> exactly one wins', async () => {
    sql(`UPDATE automation_settings SET lock_until=NULL, lock_token=NULL WHERE user_id='${A.id}'`);
    const rs = await Promise.all([R.cpanel.claim(A.id, 60, true), R.cpanel.claim(A.id, 60, true), R.cpanel.claim(A.id, 60, true)]);
    assert.equal(rs.filter(r => r.claimed).length, 1);
    sql(`UPDATE automation_settings SET lock_until=NULL, lock_token=NULL WHERE user_id='${A.id}'`);
  });

  await t.test('Railway restart: schedule + WhatsApp session survive (DB-backed job, session on volume)', async () => {
    R.server.close(); await R.sessions.shutdown(); R.scheduler.stop();
    const fake2 = makeFakeWhatsApp();
    R = await boot(dir, fake2);
    assert.equal(await R.sessions.restoreAll(), 1);
    assert.ok(await until(() => R.sessions.get(A.id)?.state === 'CONNECTED'));
    fake2.script.statements.push(statement({ at: '05/11/2026, 20:00', bal: '690.77', lines: ['05/11/2026: 10.00 DR,BY TRFR', '05/11/2026: 32.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 20.00 DR,BY TRFR', '05/11/2026: 500.00 CR,BY TRFR'] }));
    assert.equal(await cycle(R, A.id), 'SUCCESS');
    const bal = (await api(`${BASE}/api/balance/current`, { token: A.token })).body;
    assert.equal(bal.currentBalance, 690.77);
  });

  await t.test('disconnect deletes the stored session and reports it', async () => {
    const r = await api(`${R.url}/api/whatsapp/disconnect`, { method: 'POST', token: A.token });
    assert.equal(r.status, 200);
    assert.equal(fs.existsSync(path.join(dir, 'sessions', A.id)), false);
    assert.equal((await RA('/whatsapp/status')).body.whatsapp.state, 'DISCONNECTED');
  });

  R.server.close(); await R.sessions.shutdown(); R.scheduler.stop();
});

test('cPanel rejects unsigned / forged / stale service calls', { skip }, async () => {
  const bad = await api(`${BASE}/api/internal/jobs/due`);
  assert.equal(bad.status, 401);
  const forged = await api(`${BASE}/api/internal/jobs/due`, { headers: { 'X-Service-Timestamp': String(Math.floor(Date.now() / 1000)), 'X-Service-Signature': 'deadbeef' } });
  assert.equal(forged.status, 401);
  const c = new CpanelClient({ baseUrl: BASE, secret: SECRET });
  const origNow = Date.now; Date.now = () => origNow() - 3600_000;           // signed an hour ago -> replay window
  try { await assert.rejects(c.dueJobs(5), /expired|clock/i); } finally { Date.now = origNow; }
  const wrong = new CpanelClient({ baseUrl: BASE, secret: 'x'.repeat(40) });
  await assert.rejects(wrong.dueJobs(5), /signature/i);
  await assert.rejects(c.claim('usr_does_not_exist', 60), /Unknown user/);
});
