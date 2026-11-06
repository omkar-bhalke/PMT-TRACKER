import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { WhatsAppSession } from '../src/whatsappSession.js';
import { loadConfig } from '../src/config.js';

const log = { debug() {}, info() {}, warn() {}, error() {} };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wa-'));

function slowFactory() {
  const state = { created: 0, sockets: [] };
  const factory = async ({ dir }) => {
    state.created++;
    await new Promise(r => setTimeout(r, 60));                         // like fetchLatestBaileysVersion()
    const ev = new EventEmitter();
    const sock = { ev, user: { id: '919800001234:1@s.whatsapp.net' }, end() { sock.ended = true; }, async logout() {}, async sendMessage() {} };
    state.sockets.push(sock);
    fs.mkdirSync(dir, { recursive: true });
    return { sock, saveCreds: async () => {}, registered: false, sendOptionReply: async () => {} };
  };
  return { factory, state };
}

test('start() is single-flight: 5 concurrent calls create ONE socket', async () => {
  const { factory, state } = slowFactory();
  const s = new WhatsAppSession({ userId: 'u1', dir: path.join(tmp(), 'u1'), socketFactory: factory, log });
  await Promise.all([s.start(), s.start(), s.start(), s.start(), s.start()]);
  assert.equal(state.created, 1);
});

test('tapping "Show QR" again while linking does not restart the socket', async () => {
  const { factory, state } = slowFactory();
  const s = new WhatsAppSession({ userId: 'u1', dir: path.join(tmp(), 'u1'), socketFactory: factory, log });
  await s.startLinking();
  s.setState('QR_READY');
  await s.startLinking(); await s.startLinking();
  assert.equal(state.created, 1);
});

test('only the SBI chat is decrypted; groups, status, other contacts are ignored', () => {
  const s = new WhatsAppSession({ userId: 'u1', dir: path.join(tmp(), 'u1'), socketFactory: async () => ({}), log, defaultTarget: '919022690226' });
  assert.equal(s.shouldIgnoreJid('919022690226@s.whatsapp.net'), false);
  assert.equal(s.shouldIgnoreJid('919999999999@s.whatsapp.net'), true);
  assert.equal(s.shouldIgnoreJid('12036302@g.us'), true);
  assert.equal(s.shouldIgnoreJid('status@broadcast'), true);
  assert.equal(s.shouldIgnoreJid('120363@newsletter'), true);
  assert.equal(s.shouldIgnoreJid('@s.whatsapp.net'), false);           // server notifications must pass
  assert.equal(s.shouldIgnoreJid('555@lid'), false);                    // unknown LID allowed until SBI's is learned
  s.lidMap = { '919022690226': '111@lid' };
  assert.equal(s.shouldIgnoreJid('111@lid'), false);
  assert.equal(s.shouldIgnoreJid('555@lid'), true);
  s.setTarget('911234567890');                                         // admin changed target in DB
  assert.equal(s.shouldIgnoreJid('911234567890@s.whatsapp.net'), false);
});

test('401 = logged out: credentials removed and the reason is shown', async () => {
  const { factory, state } = slowFactory();
  const dir = path.join(tmp(), 'u1');
  const s = new WhatsAppSession({ userId: 'u1', dir, socketFactory: factory, log });
  await s.start();
  fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
  state.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 401 }, message: 'logged out' } } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(s.state, 'DISCONNECTED');
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), false);
  assert.match(s.lastError, /401/);
});

test('500 bad session is retried before the session is thrown away', async () => {
  const { factory, state } = slowFactory();
  const dir = path.join(tmp(), 'u1');
  const s = new WhatsAppSession({ userId: 'u1', dir, socketFactory: factory, log });
  await s.start();
  fs.writeFileSync(path.join(dir, 'creds.json'), '{}');
  state.sockets[0].ev.emit('connection.update', { connection: 'close', lastDisconnect: { error: { output: { statusCode: 500 }, message: 'bad' } } });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(s.state, 'RECONNECTING');
  assert.equal(fs.existsSync(path.join(dir, 'creds.json')), true);
  clearTimeout(s.reconnectTimer);
});

test('Railway without a Volume is detected; with a Volume the volume path is used', () => {
  const base = { CPANEL_API_URL: 'https://x.test', SERVICE_SECRET: 'a'.repeat(40) };
  assert.equal(loadConfig({ ...base, RAILWAY_ENVIRONMENT: 'production', DATA_DIR: '/data' }).persistentStorage, false);
  const withVol = loadConfig({ ...base, RAILWAY_ENVIRONMENT: 'production', RAILWAY_VOLUME_MOUNT_PATH: '/vol', DATA_DIR: '/wrong' });
  assert.equal(withVol.persistentStorage, true);
  assert.equal(withVol.dataDir, '/vol');
  assert.equal(loadConfig({ ...base, DATA_DIR: './d' }).persistentStorage, true);                 // not on Railway (local dev)
  assert.equal(loadConfig({ ...base, RAILWAY_ENVIRONMENT: 'production', ALLOW_EPHEMERAL_STORAGE: 'true' }).persistentStorage, true);
});
