import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual } from '../src/manual.js';
import { monthlyComparison, monthlyComparisonCsv } from '../src/monthly-comparison.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['card', 'liability'], ['expense', 'expense'],
    ['salary', 'income'], ['unused', 'expense']]) book.createAccount({ id, name: id === 'expense' ? '<식비 & 생활>' : id,
    type, ...(id === 'card' ? { card: true } : {}) });
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, date, amount, overrides = {}) => recordManual(book, 'owner', { requestId: randomUUID(),
  date, kind: 'expense', accountId: 'bank', counterId: 'expense', amountExpression: String(amount), ...overrides }).entry;

test('monthly comparison reconciles income, expenses and result without treating transfers or card payments as expenses', () => {
  const book = setup();
  try {
    create(book, '2026-09-01', 1000, { kind: 'income', counterId: 'salary' });
    create(book, '2026-09-30', 2000); create(book, '2026-10-01', 1000, { kind: 'income', counterId: 'salary' });
    create(book, '2026-10-31', 500); create(book, '2026-10-03', 999, { kind: 'transfer', counterId: 'other' });
    create(book, '2026-10-04', 888, { kind: 'transfer', counterId: 'card' });
    create(book, '2026-08-31', 8000); create(book, '2026-11-01', 7000);
    const before = book.entries(); const report = monthlyComparison(book, 'owner', '2026-10');
    assert.deepEqual(report.totals, [
      { key: 'income', previous: 1000, current: 1000, delta: 0, percent: 0 },
      { key: 'expenses', previous: 2000, current: 500, delta: -1500, percent: -75 },
      { key: 'result', previous: -1000, current: 500, delta: 1500, percent: 150 }]);
    for (const [period, field] of [[report.previousPeriod, 'previous'], [report.currentPeriod, 'current']]) {
      const summary = book.reports(period.fromDate, period.throughDate).incomeStatement;
      for (const total of report.totals) assert.equal(total[field], summary[total.key]);
    }
    assert.equal(report.rows.find(row => row.id === 'unused').percent, 0);
    assert.ok(report.rows.every(row => ['income', 'expense'].includes(row.type))); assert.deepEqual(book.entries(), before);
  } finally { book.close(); }
});

test('monthly periods cover year rollover, leap days and supported year limits exactly', () => {
  const book = setup();
  try {
    create(book, '2023-12-31', 100); create(book, '2024-01-01', 200); create(book, '2024-02-29', 300);
    const january = monthlyComparison(book, 'owner', '2024-01');
    assert.deepEqual(january.previousPeriod, { month: '2023-12', fromDate: '2023-12-01', throughDate: '2023-12-31' });
    assert.equal(january.totals[1].previous, 100); assert.equal(january.totals[1].current, 200);
    assert.equal(monthlyComparison(book, 'owner', '2024-02').currentPeriod.throughDate, '2024-02-29');
    assert.equal(monthlyComparison(book, 'owner', '2025-03').previousPeriod.throughDate, '2025-02-28');
    assert.equal(monthlyComparison(book, 'owner', '0001-02').previousPeriod.month, '0001-01');
    assert.equal(monthlyComparison(book, 'owner', '0096-02').currentPeriod.throughDate, '0096-02-29');
    assert.equal(monthlyComparison(book, 'owner', '9999-12').currentPeriod.throughDate, '9999-12-31');
    for (const month of [null, '0000-01', '0001-01', '2026-13', '2026-1', '10000-01', 'bad']) {
      assert.throws(() => monthlyComparison(book, 'owner', month));
    }
  } finally { book.close(); }
});

test('card purchases and cancellations use their posting months, with zero and negative baseline rates', () => {
  const book = setup();
  try {
    book.cardPurchase({ date: '2026-09-30', cardId: 'card', expenseId: 'expense', amount: 600, count: 3, firstDueDate: '2026-10-15' });
    const entry = create(book, '2026-08-01', 200);
    reverseManualTransaction(book, 'owner', { entryId: entry.id, date: '2026-09-01', reason: '취소',
      expectedHash: manualReversalPreview(book, 'owner', entry.id).expectedHash, requestId: randomUUID() });
    create(book, '2026-10-02', 1000, { kind: 'income', counterId: 'salary' });
    const report = monthlyComparison(book, 'owner', '2026-10');
    assert.equal(report.totals[1].previous, 400); assert.equal(report.totals[1].current, 0);
    assert.equal(report.totals[0].percent, null); assert.equal(report.rows.find(row => row.id === 'salary').percent, null);
    const earlier = monthlyComparison(book, 'owner', '2026-09');
    assert.equal(earlier.totals[2].previous, -200); assert.equal(earlier.totals[2].current, -400);
    assert.equal(earlier.totals[2].percent, -100);
  } finally { book.close(); }
});

test('monthly CSV exports numeric differences and empty undefined rates with spreadsheet-safe names and owner-only access', () => {
  const book = setup();
  try {
    book.createAccount({ id: 'formula', name: '=SUM(1,2)', type: 'income' });
    create(book, '2026-10-01', 200, { kind: 'income', counterId: 'formula' });
    const csv = monthlyComparisonCsv(book, 'owner', '2026-10');
    assert.equal(csv.charCodeAt(0), 0xFEFF); assert.ok(csv.endsWith('\r\n')); assert.ok(csv.includes("'=SUM(1,2)"));
    assert.ok(csv.includes('"2026-09","2026-10",0,200,200,""'));
    assert.throws(() => monthlyComparisonCsv(book, 'viewer', '2026-10'), /Owner/);
    assert.throws(() => monthlyComparison(book, 'missing', '2026-10'), /Owner/);
  } finally { book.close(); }
});

test('HTTP monthly report and CSV enforce owner access and provide escaped account drilldowns', async () => {
  const book = setup(); create(book, '2026-09-01', 100); create(book, '2026-10-01', 200);
  let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/reports`;
  try {
    const home = await (await fetch(`${base}?fromDate=2026-10-01&throughDate=2026-10-31`)).text();
    assert.match(home, /\/admin\/reports\/monthly\?month=2026-10/);
    const response = await fetch(`${base}/monthly?month=2026-10`); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /&lt;식비 &amp; 생활&gt;/);
    assert.match(html, /fromDate=2026-09-01&amp;throughDate=2026-09-30/);
    assert.match(html, /fromDate=2026-10-01&amp;throughDate=2026-10-31/);
    assert.match(html, /\/admin\/reports\/monthly.csv\?month=2026-10/);
    const csv = await fetch(`${base}/monthly.csv?month=2026-10`); assert.equal(csv.status, 200);
    assert.match(csv.headers.get('content-disposition'), /budgetbook-monthly-2026-10.csv/);
    assert.equal(csv.headers.get('cache-control'), 'no-store'); assert.equal(csv.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await csv.text()).replace(/^\uFEFF/, ''), monthlyComparisonCsv(book, 'owner', '2026-10').replace(/^\uFEFF/, ''));
    assert.equal((await fetch(`${base}/monthly?month=2026-13`)).status, 400);
    assert.equal((await fetch(`${base}/monthly`)).status, 200);
    sub = 'viewer';
    for (const endpoint of ['monthly', 'monthly.csv']) {
      const denied = await fetch(`${base}/${endpoint}?month=2026-10`); assert.equal(denied.status, 400);
      assert.doesNotMatch(await denied.text(), /식비/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
