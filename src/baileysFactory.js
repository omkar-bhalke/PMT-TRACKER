/**
 * The ONLY file that imports Baileys.
 * Baileys is an UNOFFICIAL, reverse-engineered WhatsApp Web client. It is not an official WhatsApp or SBI API;
 * it can break when WhatsApp changes its protocol and WhatsApp may restrict accounts that automate messages.
 * Version is pinned to 6.7.24 (older 6.x releases, e.g. 6.17.16, carry a published message-spoofing advisory).
 */
import pino from 'pino';

export async function baileysSocketFactory({ dir, shouldIgnoreJid }) {
  const baileys = await import('@whiskeysockets/baileys');
  const makeWASocket = baileys.default?.default || baileys.default || baileys.makeWASocket;
  const { useMultiFileAuthState, fetchLatestBaileysVersion, generateWAMessageFromContent, proto, Browsers } = baileys;

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion().catch(() => ({ version: undefined }));

  const sock = makeWASocket({
    ...(version ? { version } : {}),
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
    // Standard browser identity: required for pairing-code login to work reliably.
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,        // never download the chat history
    emitOwnEvents: false,
    generateHighQualityLinkPreview: false,
    // Only the SBI chat is read; all other chats are acknowledged without being decrypted.
    shouldIgnoreJid: shouldIgnoreJid || (() => false),
    getMessage: async () => undefined,
    keepAliveIntervalMs: 25000,
    connectTimeoutMs: 60000,
    defaultQueryTimeoutMs: 60000,
  });

  /** Replies to an interactive menu option (list row / quick-reply / native flow). Unverified against live SBI. */
  async function sendOptionReply(jid, msg, opt) {
    const ctx = { stanzaId: msg.key.id, participant: msg.key.participant || msg.key.remoteJid, quotedMessage: msg.message };
    let content;
    if (opt.kind === 'list') {
      content = { listResponseMessage: { title: opt.title, listType: 1, singleSelectReply: { selectedRowId: opt.id }, contextInfo: ctx } };
    } else if (opt.kind === 'button') {
      content = { buttonsResponseMessage: { selectedButtonId: opt.id, selectedDisplayText: opt.title, type: 1, contextInfo: ctx } };
    } else if (opt.kind === 'template') {
      content = { templateButtonReplyMessage: { selectedId: opt.id, selectedDisplayText: opt.title, selectedIndex: opt.index ?? 0, contextInfo: ctx } };
    } else {
      content = { interactiveResponseMessage: { body: { text: opt.title, format: 0 },
        nativeFlowResponseMessage: { name: opt.name === 'single_select' ? 'single_select' : 'quick_reply', paramsJson: JSON.stringify({ id: opt.id, display_text: opt.title }), version: 3 },
        contextInfo: ctx } };
    }
    const m = generateWAMessageFromContent(jid, proto.Message.fromObject(content), { userJid: sock.user.id });
    await sock.relayMessage(jid, m.message, { messageId: m.key.id });
  }

  return { sock, saveCreds, registered: !!state.creds?.registered, sendOptionReply };
}
