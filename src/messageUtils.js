/** Helpers to read WhatsApp message structures (menus / buttons / lists) in a version-tolerant way. */

export const MENU_HINT_RE = /please choose from any of the options|select an option|choose one of the options|how can i help|main menu/i;
export const OPTION_RE = /get\s*mini\s*statement/i;

const WRAPPERS = ['ephemeralMessage', 'viewOnceMessage', 'viewOnceMessageV2', 'viewOnceMessageV2Extension', 'documentWithCaptionMessage', 'editedMessage'];

export function unwrap(message) {
  let m = message;
  for (let i = 0; m && i < 5; i++) {
    const w = WRAPPERS.find(k => m[k]?.message);
    if (!w) break;
    m = m[w].message;
  }
  return m || {};
}

function nativeParams(b) {
  try { return JSON.parse(b.buttonParamsJson || '{}'); } catch { return {}; }
}

/** All human-readable text in a message, including button / list-row titles. */
export function extractText(c) {
  if (!c) return '';
  const t = [];
  const add = (x) => { if (x && typeof x === 'string') t.push(x); };
  add(c.conversation); add(c.extendedTextMessage?.text);
  add(c.imageMessage?.caption); add(c.documentMessage?.caption); add(c.videoMessage?.caption);
  add(c.buttonsMessage?.contentText); add(c.buttonsMessage?.footerText);
  (c.buttonsMessage?.buttons || []).forEach(b => add(b.buttonText?.displayText));
  add(c.listMessage?.title); add(c.listMessage?.description);
  (c.listMessage?.sections || []).forEach(s => { add(s.title); (s.rows || []).forEach(r => { add(r.title); add(r.description); }); });
  const tp = c.templateMessage?.hydratedTemplate || c.templateMessage?.hydratedFourRowTemplate;
  add(tp?.hydratedTitleText); add(tp?.hydratedContentText);
  (tp?.hydratedButtons || []).forEach(b => add(b.quickReplyButton?.displayText));
  const im = c.interactiveMessage;
  add(im?.header?.title); add(im?.body?.text); add(im?.footer?.text);
  (im?.nativeFlowMessage?.buttons || []).forEach(b => {
    const p = nativeParams(b);
    add(p.display_text);
    (p.sections || []).forEach(s => { add(s.title); (s.rows || []).forEach(r => { add(r.title); add(r.description); }); });
  });
  return t.join('\n');
}

/** Finds the "Get Mini Statement" choice in any supported interactive structure. */
export function findMiniStatementOption(c) {
  for (const s of c.listMessage?.sections || [])
    for (const r of s.rows || [])
      if (OPTION_RE.test(r.title || '')) return { kind: 'list', id: r.rowId, title: r.title };
  for (const b of c.buttonsMessage?.buttons || []) {
    const text = b.buttonText?.displayText || '';
    if (OPTION_RE.test(text)) return { kind: 'button', id: b.buttonId, title: text };
  }
  const tp = c.templateMessage?.hydratedTemplate || c.templateMessage?.hydratedFourRowTemplate;
  for (const b of tp?.hydratedButtons || []) {
    const text = b.quickReplyButton?.displayText || '';
    if (OPTION_RE.test(text)) return { kind: 'template', id: b.quickReplyButton.id, title: text, index: b.index ?? 0 };
  }
  for (const b of c.interactiveMessage?.nativeFlowMessage?.buttons || []) {
    const p = nativeParams(b);
    for (const s of p.sections || [])
      for (const r of s.rows || [])
        if (OPTION_RE.test(r.title || '')) return { kind: 'native', name: b.name, id: r.id, title: r.title };
    if (OPTION_RE.test(p.display_text || '')) return { kind: 'native', name: b.name, id: p.id, title: p.display_text };
  }
  return null;
}

/** Short structural fingerprint for diagnostics (no user data), e.g. "listMessage(sections=1,rows=4)". */
export function describeShape(c) {
  const k = Object.keys(c || {}).filter(x => c[x] != null && x !== 'messageContextInfo');
  return k.map(key => {
    if (key === 'listMessage') return `listMessage(sections=${c.listMessage.sections?.length || 0},rows=${(c.listMessage.sections || []).reduce((n, s) => n + (s.rows?.length || 0), 0)})`;
    if (key === 'buttonsMessage') return `buttonsMessage(buttons=${c.buttonsMessage.buttons?.length || 0})`;
    if (key === 'interactiveMessage') return `interactiveMessage(native=${c.interactiveMessage.nativeFlowMessage?.buttons?.map(b => b.name).join('|') || 0})`;
    return key;
  }).join(',');
}

export const numberOf = (jid) => (jid || '').split('@')[0].split(':')[0];
