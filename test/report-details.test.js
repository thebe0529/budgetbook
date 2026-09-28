import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount, recordManual } from '../src/manual.js';
import { accountActivity, detailedReports } from '../src/report-details.js';
import { cashMovementsCsv } from '../src/report-export.js';
import { createImportApi } from '../src/import-api.js';

test('detailed statements reconcile account balances and cash movements including transfers', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const savings = createLedgerAccount(book, 'owner', { name: '저축', type: 'asset', cash: true });
    const equity = createLedgerAccount(book, 'owner', { name: '자본', type: 'equity' });
    const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
    const salary = createLedgerAccount(book, 'owner', { name: '급여', type: 'income' });
    setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
    const record = (kind, date, counterId, amountExpression, accountId = bank.id) =>
      recordManual(book, 'owner', { requestId: randomUUID(), kind, date, accountId,
        counterId, amountExpression });
    record('opening', '2026-09-30', equity.id, '100000');
    record('income', '2026-10-02', salary.id, '50000');
    record('expense', '2026-10-03', food.id, '12000');
    record('transfer', '2026-10-04', savings.id, '20000');
    const detail = detailedReports(book, 'owner', '2026-10-01', '2026-10-31');
    assert.equal(detail.summary.balanceSheet.netWorth, 138000);
    assert.equal(detail.summary.incomeStatement.result, 38000);
    assert.equal(detail.cashTotals.opening, 100000);
    assert.equal(detail.cashTotals.receipts, 70000);
    assert.equal(detail.cashTotals.payments, 32000);
    assert.equal(detail.cashTotals.closing, 138000);
    assert.equal(detail.summary.cashFlow.netChange, 38000);
    assert.equal(detail.cashMovements.length, 4);
    assert.deepEqual(detail.cashFlowActivities.totals,
      { operating: 38000, investing: 0, financing: 0 });
    assert.equal(detail.cashFlowActivities.rows.operating.length, 2);
    assert.equal(accountActivity(book, 'owner', food.id, '2026-10-01', '2026-10-31').total, 12000);
    assert.equal(accountActivity(book, 'owner', bank.id, '0001-01-01', '2026-10-31').total, 118000);
    assert.throws(() => detailedReports(book, 'viewer', '2026-10-01', '2026-10-31'), /Owner/);
    assert.throws(() => accountActivity(book, 'viewer', bank.id, '2026-10-01', '2026-10-31'), /Owner/);
  } finally { book.close(); }
});

test('report drilldown hides consolidated entries from family viewers', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
  const privateAccount = createLedgerAccount(book, 'owner', { name: '비공개 급여', type: 'income' });
  setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
  const auth = { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner',
    role: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const report = await fetch(`${url}/admin/reports?fromDate=2026-10-01&throughDate=2026-10-31`);
    assert.equal(report.status, 200);
    assert.match(await report.text(), /재무상태표/);
    const viewer = await fetch(`${url}/admin/reports?fromDate=2026-10-01&throughDate=2026-10-31`,
      { headers: { Cookie: 'viewer=1' } });
    assert.doesNotMatch(await viewer.text(), /비공개 급여/);
    const denied = await fetch(`${url}/admin/reports/account?accountId=${privateAccount.id}&fromDate=2026-10-01&throughDate=2026-10-31`,
      { headers: { Cookie: 'viewer=1' } });
    assert.equal(denied.status, 400);
    assert.doesNotMatch(await denied.text(), /비공개 급여/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('cash CSV exports signed movements and protects spreadsheet cells', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '은행, 주계좌', type: 'asset', cash: true });
  const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
  recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-03', kind: 'expense',
    accountId: bank.id, counterId: food.id, amountExpression: '12000', memo: '=HYPERLINK("x")' });
  const auth = { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner',
    role: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/reports/cash.csv?fromDate=2026-10-01&throughDate=2026-10-31`;
  try {
    const csv = cashMovementsCsv(book, 'owner', '2026-10-01', '2026-10-31');
    assert.match(csv, /"'\=HYPERLINK\(""x""\)"/);
    assert.match(csv, /,-12000,/);
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition'), /attachment/);
    assert.equal(await response.text(), csv.slice(1)); // fetch text decoding strips the UTF-8 BOM.
    const denied = await fetch(url, { headers: { Cookie: 'viewer=1' } });
    assert.equal(denied.status, 400);
    assert.doesNotMatch(await denied.text(), /HYPERLINK/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
