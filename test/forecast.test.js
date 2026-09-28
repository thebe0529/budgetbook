import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount, recordManual } from '../src/manual.js';
import { autoLinkMatches, disableSchedule, forecast, linkOccurrence, linkedOccurrences, matchingEntries,
  saveSchedule, unlinkOccurrence } from '../src/forecast.js';
import { recordCardPurchase } from '../src/card-manual.js';
import { createImportApi } from '../src/import-api.js';
import { randomUUID } from 'node:crypto';

test('cash forecast combines monthly schedules, unpaid cards and posted future cash without changing ledger', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const equity = createLedgerAccount(book, 'owner', { name: '자본', type: 'equity' });
    const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true });
    const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
    setMember(book, 'owner', 'viewer', 'viewer', [cash.id]);
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01',
      kind: 'opening', accountId: cash.id, counterId: equity.id, amountExpression: '100000' });
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-03',
      kind: 'expense', accountId: cash.id, counterId: expense.id, amountExpression: '3000' });
    const plan = recordCardPurchase(book, 'owner', { requestId: randomUUID(), date: '2026-10-05',
      cardId: card.id, expenseId: expense.id, amountExpression: '30000', count: 3,
      firstDueDate: '2026-11-25' });
    const schedule = saveSchedule(book, 'owner', { accountId: cash.id, name: '월급',
      amountExpression: '20000', startDate: '2026-10-31', frequency: 'monthly' });
    const args = { asOf: '2026-10-10', throughDate: '2026-12-31', cardCashId: cash.id };
    const result = forecast(book, 'owner', args);
    assert.equal(result.openingTotal, 100000);
    assert.deepEqual(result.events.map(e => [e.date, e.type, e.amount]), [
      ['2026-10-31', 'schedule', 20000], ['2026-11-03', 'booked', -3000],
      ['2026-11-25', 'card', -10000], ['2026-11-30', 'schedule', 20000],
      ['2026-12-25', 'card', -10000], ['2026-12-31', 'schedule', 20000],
    ]);
    assert.equal(result.projectedTotal, 137000);
    assert.equal(forecast(book, 'owner', { ...args, overrides: { [schedule.id]: '25000+5000' } }).projectedTotal,
      167000);
    assert.equal(book.entries().length, 3);
    assert.throws(() => forecast(book, 'viewer', args), /Owner/);
    assert.throws(() => forecast(book, 'owner', { ...args, overrides: { fake: '1' } }), /Unknown/);
    assert.throws(() => saveSchedule(book, 'viewer', { accountId: cash.id, name: '몰래',
      amountExpression: '1', startDate: '2026-11-01', frequency: 'once' }), /Owner/);
    disableSchedule(book, 'owner', schedule.id);
    assert.equal(forecast(book, 'owner', args).projectedTotal, 77000);
    assert.ok(book.cardPlan(plan.plan.id));
  } finally { book.close(); }
});

test('linked actual cash movement replaces only its schedule occurrence', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const otherCash = createLedgerAccount(book, 'owner', { name: '다른 은행', type: 'asset', cash: true });
    const income = createLedgerAccount(book, 'owner', { name: '급여', type: 'income' });
    const schedule = saveSchedule(book, 'owner', { accountId: cash.id, name: '급여',
      amountExpression: '20000', startDate: '2026-11-25', frequency: 'monthly' });
    const entry = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-26',
      kind: 'income', accountId: cash.id, counterId: income.id, amountExpression: '20000' }).entry;
    const wrong = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-26',
      kind: 'income', accountId: otherCash.id, counterId: income.id, amountExpression: '20000' }).entry;
    const args = { asOf: '2026-11-01', throughDate: '2026-12-31' };
    assert.equal(forecast(book, 'owner', args).projectedTotal, 80000);
    assert.throws(() => linkOccurrence(book, 'owner', { scheduleId: schedule.id,
      date: '2026-11-25', entryId: wrong.id }), /does not match/);
    assert.deepEqual(matchingEntries(book, 'owner', schedule.id, '2026-11-25').map(e => e.id), [entry.id]);
    linkOccurrence(book, 'owner', { scheduleId: schedule.id, date: '2026-11-25', entryId: entry.id });
    assert.equal(forecast(book, 'owner', args).projectedTotal, 60000);
    assert.equal(forecast(book, 'owner', args).events.filter(e => e.type === 'schedule').length, 1);
    assert.equal(linkedOccurrences(book, 'owner').length, 1);
    assert.throws(() => linkOccurrence(book, 'owner', { scheduleId: schedule.id,
      date: '2026-12-25', entryId: entry.id }), /UNIQUE/);
    const changed = saveSchedule(book, 'owner', { id: schedule.id, accountId: cash.id,
      name: '급여 인상', amountExpression: '25000', startDate: '2026-11-25', frequency: 'monthly' });
    assert.equal(changed.id, schedule.id);
    assert.equal(forecast(book, 'owner', args).projectedTotal, 90000);
    unlinkOccurrence(book, 'owner', { scheduleId: schedule.id, date: '2026-11-25' });
    assert.equal(linkedOccurrences(book, 'owner').length, 0);
  } finally { book.close(); }
});

test('forecast page respects owner role and CSRF', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
  const income = createLedgerAccount(book, 'owner', { name: '급여', type: 'income' });
  const actual = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-26',
    kind: 'income', accountId: cash.id, counterId: income.id, amountExpression: '20000' }).entry;
  const schedule = saveSchedule(book, 'owner', { accountId: cash.id, name: '월급',
    amountExpression: '20000', startDate: '2026-11-25', frequency: 'monthly' });
  setMember(book, 'owner', 'viewer', 'viewer', [cash.id]);
  const auth = { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner',
    role: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${url}/admin/forecast?asOf=2026-10-01&throughDate=2026-12-31`);
    assert.equal(page.status, 200);
    const pageText = await page.text();
    assert.match(pageText, /예상 상세/);
    assert.match(pageText, /자동 매칭/);
    const denied = await fetch(`${url}/admin/forecast?asOf=2026-10-01&throughDate=2026-12-31`,
      { headers: { Cookie: 'viewer=1' } });
    assert.equal(denied.status, 400);
    const invalid = await fetch(`${url}/admin/forecast/schedules`, { method: 'POST',
      body: new URLSearchParams({ csrf: 'wrong' }) });
    assert.equal(invalid.status, 403);
    const body = new URLSearchParams({ csrf: 'token', scheduleId: schedule.id,
      date: '2026-11-25', entryId: actual.id, asOf: '2026-11-01',
      throughDate: '2026-12-31' });
    const linked = await fetch(`${url}/admin/forecast/link`, { method: 'POST', body });
    assert.equal(linked.status, 200);
    assert.match(await linked.text(), /연결 해제/);
    assert.equal(linkedOccurrences(book, 'owner').length, 1);
    const unlinked = await fetch(`${url}/admin/forecast/unlink`, { method: 'POST',
      body: new URLSearchParams({ csrf: 'token', scheduleId: schedule.id, date: '2026-11-25' }) });
    assert.equal(unlinked.status, 200);
    assert.equal(linkedOccurrences(book, 'owner').length, 0);
} finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('automatic matching links only an unambiguous candidate', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
    const schedule = saveSchedule(book, 'owner', { accountId: bank.id, name: '월세',
      startDate: '2026-10-25', frequency: 'once', amountExpression: '-50000' });
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-25', kind: 'expense',
      accountId: bank.id, counterId: expense.id, amountExpression: '50000' });
    assert.equal(autoLinkMatches(book, 'owner', { scheduleId: schedule.id, dates: ['2026-10-25'] }).length, 1);
  } finally { book.close(); }
});

test('automatic matching leaves overlapping monthly candidates for manual review', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
    const schedule = saveSchedule(book, 'owner', { accountId: bank.id, name: '월 지출',
      startDate: '2026-10-25', frequency: 'monthly', amountExpression: '-50000' });
    const actual = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-10',
      kind: 'expense', accountId: bank.id, counterId: expense.id, amountExpression: '50000' }).entry;
    const dates = ['2026-10-25', '2026-11-25'];
    assert.deepEqual(autoLinkMatches(book, 'owner', { scheduleId: schedule.id, dates }), []);
    assert.equal(linkedOccurrences(book, 'owner').length, 0);
    assert.throws(() => autoLinkMatches(book, 'owner', { scheduleId: schedule.id,
      dates: [...dates, dates[0]] }), /Invalid matching dates/);
    assert.deepEqual(autoLinkMatches(book, 'owner', { scheduleId: schedule.id,
      dates: ['2026-11-25'] }), [{ date: '2026-11-25', entryId: actual.id }]);
    assert.deepEqual(autoLinkMatches(book, 'owner', { scheduleId: schedule.id,
      dates: ['2026-11-25'] }), []);
  } finally { book.close(); }
});
