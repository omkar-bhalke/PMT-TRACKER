import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStatement, isIntermediateMessage, looksLikeStatement } from '../src/statementParser.js';

// Fixture text taken from the requirements document. Used ONLY by this unit test; it is never written to any database.
const SPEC_SAMPLE = `05/11/2026, 10:21

Available Balance in A/c xxx188: Rs. 433.77 CR

04/11/2026: 20.00 DR,BY TRFR
04/11/2026: 41.00 DR,BY TRFR
04/11/2026: 5.00 DR,BY TRFR
04/11/2026: 25.00 DR,BY TRFR
03/11/2026: 100.00 DR,BY TRFR`;

test('parses the documented SBI format', () => {
  const r = parseStatement(SPEC_SAMPLE);
  assert.equal(r.ok, true);
  const s = r.statement;
  assert.equal(s.accountMasked, 'xxx188');
  assert.equal(s.balance, 433.77);
  assert.equal(s.balanceType, 'CR');
  assert.equal(s.statementAt, '2026-11-05T10:21:00+05:30');
  assert.equal(s.entries.length, 5);
  assert.deepEqual(s.entries.map(e => [e.date, e.amount, e.type, e.description]), [
    ['2026-11-04', 20, 'DEBIT', 'BY TRFR'],
    ['2026-11-04', 41, 'DEBIT', 'BY TRFR'],
    ['2026-11-04', 5, 'DEBIT', 'BY TRFR'],
    ['2026-11-04', 25, 'DEBIT', 'BY TRFR'],
    ['2026-11-03', 100, 'DEBIT', 'BY TRFR'],
  ]);
});

test('credits, commas and rupee variants', () => {
  const r = parseStatement(`06/11/2026, 09:05\nAvailable Balance in A/c XXXXXXX9188: Rs 1,433.77 CR\n05/11/2026: 1,500.00 CR,BY SALARY\n05/11/2026: 0.50 CR,INT`);
  assert.equal(r.ok, true);
  assert.equal(r.statement.balance, 1433.77);
  assert.equal(r.statement.entries[0].type, 'CREDIT');
  assert.equal(r.statement.entries[0].amount, 1500);
  assert.equal(r.statement.entries[0].suggestedCategory, 'Salary & Allowance');
  assert.equal(r.statement.entries[1].amount, 0.5);
});

test('identical lines are kept (two real 20.00 DR entries must not collapse)', () => {
  const r = parseStatement(`05/11/2026, 10:21\nAvailable Balance in A/c xxx188: Rs. 10.00 CR\n05/11/2026: 20.00 DR,BY TRFR\n05/11/2026: 20.00 DR,BY TRFR`);
  assert.equal(r.statement.entries.length, 2);
});

test('statement with zero entries is valid', () => {
  const r = parseStatement(`05/11/2026, 10:21\nAvailable Balance in A/c xxx188: Rs. 10.00 CR`);
  assert.equal(r.ok, true);
  assert.equal(r.statement.entries.length, 0);
});

test('never fabricates: no balance -> failure, no account -> failure', () => {
  assert.equal(parseStatement('Hello from SBI').ok, false);
  assert.equal(parseStatement('04/11/2026: 20.00 DR,BY TRFR').reason, 'NO_BALANCE_LINE');
});

test('missing header time stays null (not replaced by "now")', () => {
  const r = parseStatement(`Available Balance in A/c xxx188: Rs. 10.00 CR\n04/11/2026: 5.00 DR,BY TRFR`);
  assert.equal(r.ok, true);
  assert.equal(r.statement.statementAt, null);
  assert.deepEqual(r.warnings, ['STATEMENT_TIME_MISSING']);
});

test('a changed/unknown entry line is reported, not silently skipped', () => {
  const r = parseStatement(`05/11/2026, 10:21\nAvailable Balance in A/c xxx188: Rs. 10.00 CR\n04/11/2026: Rs twenty DR BY TRFR`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'UNPARSEABLE_ENTRY_LINES');
});

test('impossible dates are rejected', () => {
  const r = parseStatement(`Available Balance in A/c xxx188: Rs. 10.00 CR\n31/02/2026: 5.00 DR,BY TRFR`);
  assert.equal(r.ok, false);
});

test('intermediate "please wait" message is not a statement', () => {
  const t = 'Please wait while we fetch your mini statement.... ⏳';
  assert.equal(isIntermediateMessage(t), true);
  assert.equal(parseStatement(t).ok, false);
  assert.equal(looksLikeStatement(t), false);
  assert.equal(looksLikeStatement(SPEC_SAMPLE), true);
});

test('suggested category is null when nothing meaningful (BY TRFR)', () => {
  const r = parseStatement(SPEC_SAMPLE);
  assert.ok(r.statement.entries.every(e => e.suggestedCategory === null));
});
