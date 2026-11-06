/**
 * TEST DOUBLE - lives only in /test, never imported by production code.
 * It replaces ONLY the WhatsApp socket so the rest of the system (state machine, scheduler, HTTP API,
 * cPanel PHP + MySQL) can be exercised for real. It does NOT prove that SBI's live bot behaves this way.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

export const SBI_JID = '919022690226@s.whatsapp.net';

export function makeFakeWhatsApp() {
  const script = { statements: [], respond: true, sent: [], clicks: [], sockets: [] };
  let n = 0;

  const factory = async ({ dir }) => {
    const ev = new EventEmitter();
    const sock = {
      ev, user: { id: '919800001234:7@s.whatsapp.net' },
      end() {}, async logout() {},
      async requestPairingCode(p) { return 'ABCD-EFGH'; },
      async sendMessage(jid, content) {
        script.sent.push(content.text);
        if (!script.respond) return;
        if (content.text === 'Hi') setTimeout(() => deliver(menuMessage()), 15);
        if (content.text === 'Get Mini Statement') setTimeout(() => statementFlow(), 15);
      },
    };
    const deliver = (message, jid = SBI_JID) => ev.emit('messages.upsert', { type: 'notify', messages: [{ key: { remoteJid: jid, fromMe: false, id: `M${++n}` }, messageTimestamp: Math.floor(Date.now() / 1000), message }] });
    const menuMessage = () => ({ listMessage: { title: 'Welcome to SBI WhatsApp Banking', description: 'Please choose from any of the options', sections: [{ title: 'Menu', rows: [{ title: 'Account Balance', rowId: 'r1' }, { title: 'Get Mini Statement📑', rowId: 'r2' }] }] } });
    const statementFlow = () => {
      deliver({ conversation: 'Please wait while we fetch your mini statement.... ⏳' });
      const next = script.statements.shift();
      if (next !== undefined && next !== null) setTimeout(() => deliver({ conversation: next }), 30);
    };
    // real Baileys writes creds.json when linked
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'creds.json'), '{"fake":"test-creds"}');
    sock.__deliver = deliver;
    script.sockets.push(sock);
    setTimeout(() => ev.emit('connection.update', { connection: 'open' }), 10);
    return {
      sock, registered: true, saveCreds: async () => {},
      sendOptionReply: async (jid, msg, opt) => { script.clicks.push(opt); setTimeout(() => statementFlow(), 15); },
    };
  };
  return { factory, script };
}

export const statement = ({ at = '05/11/2026, 10:21', bal, lines }) => `${at}\n\nAvailable Balance in A/c xxx188: Rs. ${bal} CR\n\n${lines.join('\n')}`;
