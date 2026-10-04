import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual } from '../src/manual.js';
import { monthlyComparison, monthlyComparisonCsv, monthlyComparisonFilters } from '../src/monthly-comparison.js';
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

test('year and custom reference modes select exact full months and reconcile shared account comparisons', () => {
  const book = setup();
  try {
    create(book, '2023-02-28', 100); create(book, '2023-03-01', 9000);
    create(book, '2024-01-31', 500); create(book, '2024-02-29', 300);
    const yearly = monthlyComparison(book, 'owner', '2024-02', { comparison: 'year' });
    assert.equal(yearly.comparison, 'year'); assert.deepEqual(yearly.previousPeriod,
      { month: '2023-02', fromDate: '2023-02-01', throughDate: '2023-02-28' });
    assert.equal(yearly.currentPeriod.throughDate, '2024-02-29');
    assert.deepEqual(yearly.totals[1], { key: 'expenses', previous: 100, current: 300, delta: 200, percent: 200 });
    const custom = monthlyComparison(book, 'owner', '2024-02', { comparison: 'custom', referenceMonth: '2024-01' });
    const previous = monthlyComparison(book, 'owner', '2024-02');
    assert.deepEqual(custom.rows, previous.rows); assert.deepEqual(custom.totals, previous.totals);
    assert.equal(custom.totals[1].delta, -200);
    assert.equal(monthlyComparison(book, 'owner', '0001-01', { comparison: 'custom', referenceMonth: '9999-12' }).previousPeriod.throughDate, '9999-12-31');
    assert.equal(monthlyComparison(book, 'owner', '0100-02', { comparison: 'year' }).previousPeriod.month, '0099-02');
    const csv = monthlyComparisonCsv(book, 'owner', '2024-02', { comparison: 'year' });
    assert.match(csv, /비교 월/); assert.ok(csv.includes('"2023-02","2024-02",100,300,200,200'));
  } finally { book.close(); }
});

test('reference modes reject unsupported, missing, identical and out-of-range months before returning data', () => {
  const book = setup();
  try {
    for (const options of [{ comparison: 'unknown' }, { comparison: 'custom' },
      { comparison: 'custom', referenceMonth: '' }, { comparison: 'custom', referenceMonth: '0000-01' },
      { comparison: 'custom', referenceMonth: '2026-10' }, { comparison: 'custom', referenceMonth: '2026-13' },
      { comparison: 'custom', referenceMonth: '2026-1' }, { comparison: 'custom', referenceMonth: '<bad>' }]) {
      assert.throws(() => monthlyComparison(book, 'owner', '2026-10', options));
      assert.throws(() => monthlyComparisonCsv(book, 'owner', '2026-10', options));
    }
    assert.throws(() => monthlyComparison(book, 'owner', '0001-12', { comparison: 'year' }), /supported year/);
    assert.throws(() => monthlyComparison(book, 'viewer', '2026-10', { comparison: 'year' }), /Owner/);
    assert.throws(() => monthlyComparisonCsv(book, 'viewer', '2026-10', { comparison: 'custom', referenceMonth: '2025-10' }), /Owner/);
  } finally { book.close(); }
});

test('account filters combine type, normalized case-insensitive names and zero amounts while preserving full totals', () => {
  const book = setup();
  try {
    book.createAccount({ id: 'cafe', name: 'Café 비용', type: 'expense' });
    create(book, '2026-09-01', 100); create(book, '2026-10-01', 200);
    create(book, '2026-10-02', 300, { counterId: 'cafe' });
    create(book, '2026-10-02', 1000, { kind: 'income', counterId: 'salary' });
    const full = monthlyComparison(book, 'owner', '2026-10'); const before = book.entries();
    const filtered = monthlyComparison(book, 'owner', '2026-10', { accountType: 'expense', accountQuery: ' CAFE\u0301 ', hideZero: true });
    assert.deepEqual(filtered.rows.map(row => row.id), ['cafe']); assert.equal(filtered.filters.accountQuery, 'CAFÉ');
    assert.deepEqual(filtered.totals, full.totals); assert.equal(filtered.totalAccounts, 4);
    assert.deepEqual(monthlyComparison(book, 'owner', '2026-10', { accountType: 'income' }).rows.map(row => row.id), ['salary']);
    assert.equal(monthlyComparison(book, 'owner', '2026-10', { hideZero: true }).rows.length, 3);
    assert.equal(monthlyComparison(book, 'owner', '2026-10', { accountQuery: '없음' }).rows.length, 0);
    assert.deepEqual(book.entries(), before);
    const csv = monthlyComparisonCsv(book, 'owner', '2026-10', { accountType: 'expense', accountQuery: 'CAFÉ', hideZero: true });
    assert.match(csv, /전체 합계 \(계정 필터 미적용\)/); assert.match(csv, /Café 비용/); assert.doesNotMatch(csv, /식비/);
    assert.match(csv, /계정 유형 조건/); assert.match(csv, /"지출","CAFÉ","예"/);
    assert.equal(monthlyComparison(book, 'owner', '2026-09', { hideZero: true }).rows[0].id, 'expense');
  } finally { book.close(); }
});

test('invalid account filters are rejected and CSV filter metadata remains spreadsheet safe', () => {
  const book = setup();
  try {
    for (const options of [{ accountType: 'asset' }, { hideZero: 'true' }, { accountQuery: null },
      { accountQuery: 'x'.repeat(101) }, { accountQuery: 'a\nb' }, { accountQuery: 'a\u200bb' }]) {
      assert.throws(() => monthlyComparison(book, 'owner', '2026-10', options));
      assert.throws(() => monthlyComparisonCsv(book, 'owner', '2026-10', options));
    }
    assert.throws(() => monthlyComparisonFilters(new URLSearchParams({ hideZero: 'yes' })), /zero amount/);
    assert.equal(monthlyComparisonFilters(new URLSearchParams()).hideZero, false);
    assert.equal(monthlyComparisonFilters(new URLSearchParams({ hideZero: 'true' })).hideZero, true);
    const csv = monthlyComparisonCsv(book, 'owner', '2026-10', { accountQuery: '=SUM(1,2)' });
    assert.ok(csv.includes("'=SUM(1,2)")); assert.match(csv, /전체 합계/);
  } finally { book.close(); }
});

test('HTTP account filters persist with custom periods and CSV while empty results retain complete totals', async () => {
  const book = setup(); create(book, '2026-06-01', 100); create(book, '2026-10-01', 200);
  create(book, '2026-10-01', 1000, { kind: 'income', counterId: 'salary' });
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'owner', role: 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/reports`;
  try {
    const params = new URLSearchParams({ month: '2026-10', comparison: 'custom', referenceMonth: '2026-06',
      accountType: 'expense', accountQuery: '<식비 & 생활>', hideZero: 'true' });
    const response = await fetch(`${base}/monthly?${params}`); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /value="expense" selected/);
    assert.match(html, /name="accountQuery" maxlength="100" value="&lt;식비 &amp; 생활&gt;"/);
    assert.match(html, /name="hideZero" value="true" checked/); assert.match(html, /전체 3개 중 1개 계정 표시/);
    const download = html.match(/href="([^\"]*\/monthly.csv\?[^\"]*)"/)[1].replaceAll('&amp;', '&');
    const csv = await fetch(new URL(download, base)); assert.equal(csv.status, 200);
    assert.equal((await csv.text()).replace(/^\uFEFF/, ''), monthlyComparisonCsv(book, 'owner', '2026-10', monthlyComparisonFilters(params)).replace(/^\uFEFF/, ''));
    params.set('accountQuery', '검색 없음');
    const empty = await (await fetch(`${base}/monthly?${params}`)).text();
    assert.match(empty, /조건에 맞는 계정이 없습니다/); assert.match(empty, /월별 전체 합계/); assert.match(empty, /1,000/);
    for (const bad of ['accountType=asset', 'hideZero=unknown', `accountQuery=${'x'.repeat(101)}`]) {
      for (const suffix of ['', '.csv']) assert.equal((await fetch(`${base}/monthly${suffix}?month=2026-10&${bad}`)).status, 400);
    }
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('HTTP comparison selection persists in controls, drilldowns and matching CSV downloads', async () => {
  const book = setup(); create(book, '2025-10-31', 100); create(book, '2026-06-30', 200); create(book, '2026-10-01', 300);
  let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/reports`;
  try {
    for (const options of [{ comparison: 'year', referenceMonth: '2025-10' }, { comparison: 'custom', referenceMonth: '2026-06' }]) {
      const query = new URLSearchParams({ month: '2026-10', ...options });
      const response = await fetch(`${base}/monthly?${query}`); assert.equal(response.status, 200);
      const html = await response.text(); assert.ok(html.includes(`value="${options.comparison}" selected`));
      assert.ok(html.includes(`value="${options.referenceMonth}"`)); assert.ok(html.includes(`fromDate=${options.referenceMonth}-01`));
      const download = html.match(/href="([^\"]*\/monthly.csv\?[^\"]*)"/)[1].replaceAll('&amp;', '&');
      const csv = await fetch(new URL(download, base)); assert.equal(csv.status, 200);
      assert.equal((await csv.text()).replace(/^\uFEFF/, ''), monthlyComparisonCsv(book, 'owner', '2026-10', options).replace(/^\uFEFF/, ''));
    }
    for (const query of ['comparison=unknown', 'comparison=custom', 'comparison=custom&referenceMonth=2026-10']) {
      for (const suffix of ['', '.csv']) assert.equal((await fetch(`${base}/monthly${suffix}?month=2026-10&${query}`)).status, 400);
    }
    sub = 'viewer';
    assert.equal((await fetch(`${base}/monthly.csv?month=2026-10&comparison=year`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
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
