/**
 * SBI WhatsApp mini-statement parser.
 *
 * Never invents data: if the account, balance or an entry line cannot be read the result is
 * { ok:false, reason } so the caller can report "statement format changed" instead of
 * storing guesses.
 *
 * Expected shape (example only - this file never stores or emits sample data):
 *
 *   05/11/2026, 10:21
 *   Available Balance in A/c xxx188: Rs. 433.77 CR
 *   04/11/2026: 20.00 DR,BY TRFR
 */

const HEADER_RE = /^\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4}),?\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/m;
const BALANCE_RE = /Available\s+Balance(?:\s+in)?\s+(?:A\/c|Account|A\/C)\s*(?:No\.?)?\s*([xX*•.\d]*\d[xX*•.\d]*)\s*[:\-]?\s*(?:Rs\.?|INR|₹)?\s*([\d,]+(?:\.\d{1,2})?)\s*(CR|DR)?/i;
const ENTRY_RE = /^\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})\s*[:\-]\s*(?:Rs\.?\s*|INR\s*|₹\s*)?([\d,]+(?:\.\d{1,2})?)\s*(CR|DR)\b\s*[,:\-]?\s*(.*)$/i;
// a line that starts like an entry (date + colon) - used to detect lines we failed to understand
const ENTRY_LIKE_RE = /^\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\s*[:\-]\s*\S/;

export const INTERMEDIATE_RE = /please\s+wait\s+while\s+we\s+fetch/i;

export function isIntermediateMessage(text) {
  return INTERMEDIATE_RE.test(text || '');
}

/** Does this text look like it is trying to be a statement (so a parse failure means "format changed")? */
export function looksLikeStatement(text) {
  return /Available\s+Balance/i.test(text || '');
}

function validDate(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

const pad = (n) => String(n).padStart(2, '0');
const money = (s) => Math.round(parseFloat(String(s).replace(/,/g, '')) * 100) / 100;

export function parseStatement(text) {
  if (!text || typeof text !== 'string') return { ok: false, reason: 'EMPTY' };
  const clean = text.replace(/\u200e|\u200f/g, '').trim();

  // --- balance + masked account (both mandatory)
  const bal = clean.match(BALANCE_RE);
  if (!bal) return { ok: false, reason: 'NO_BALANCE_LINE' };
  const accountMasked = bal[1].trim();
  const balance = money(bal[2]);
  if (!Number.isFinite(balance)) return { ok: false, reason: 'BAD_BALANCE' };
  const balanceType = (bal[3] || 'CR').toUpperCase();

  // --- statement generation time (IST). Optional; never fabricated.
  let statementAt = null;
  let statementRaw = null;
  const h = clean.match(HEADER_RE);
  if (h) {
    const [, dd, mm, yyyy, hh, mi, ss] = h;
    const y = +yyyy, mo = +mm, d = +dd;
    if (validDate(y, mo, d) && +hh < 24 && +mi < 60) {
      statementAt = `${y}-${pad(mo)}-${pad(d)}T${pad(+hh)}:${mi}:${pad(+(ss || 0))}+05:30`;
      statementRaw = h[0].trim();
    }
  }

  // --- entries (statement order preserved)
  const entries = [];
  const unparsed = [];
  for (const raw of clean.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(ENTRY_RE);
    if (!m) {
      if (ENTRY_LIKE_RE.test(line)) unparsed.push(line);
      continue;
    }
    let [, dd, mm, yy, amt, ind, desc] = m;
    let y = +yy;
    if (yy.length === 2) y += 2000;
    if (!validDate(y, +mm, +dd)) { unparsed.push(line); continue; }
    const amount = money(amt);
    if (!(amount > 0)) { unparsed.push(line); continue; }
    const type = ind.toUpperCase() === 'CR' ? 'CREDIT' : 'DEBIT';
    const description = (desc || '').replace(/\s+/g, ' ').trim();
    entries.push({
      date: `${y}-${pad(+mm)}-${pad(+dd)}`,
      amount,
      type,
      indicator: ind.toUpperCase(),
      description,
      suggestedCategory: suggestCategory(description, type),
    });
  }

  if (unparsed.length > 0) {
    return { ok: false, reason: 'UNPARSEABLE_ENTRY_LINES', unparsed: unparsed.slice(0, 5) };
  }

  return {
    ok: true,
    statement: { accountMasked, balance, balanceType, statementAt, statementRaw, entries },
    warnings: statementAt ? [] : ['STATEMENT_TIME_MISSING'],
  };
}

/**
 * Optional hint only. The user must still confirm; returns null when there is nothing meaningful to suggest.
 * Names match the default categories created in database.sql.
 */
export function suggestCategory(description, type) {
  const d = description || '';
  if (type === 'CREDIT') {
    if (/\bsalary\b|\bsal\b/i.test(d)) return 'Salary & Allowance';
    if (/refund|reversal/i.test(d)) return 'Refunds';
    if (/\bint(erest)?\b/i.test(d)) return 'Investments & Gifts';
    return null;
  }
  if (/swiggy|zomato|restaurant|cafe|hotel|bakery/i.test(d)) return 'Food & Dining';
  if (/dmart|blinkit|zepto|grocery|bigbasket/i.test(d)) return 'Groceries';
  if (/uber|ola\b|rapido|metro|irctc|petrol|fuel/i.test(d)) return 'Transportation';
  if (/electricity|bescom|recharge|broadband|\bgas\b/i.test(d)) return 'Utilities & Bills';
  if (/pharmacy|hospital|clinic|apollo/i.test(d)) return 'Healthcare';
  return null;
}
