import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { actualCsvPreview, importActualCsv } from '../src/actual-csv.js';
import { listReviewEvents, approveEvent } from '../src/review.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const account of [{ id: 'bank', name: '<은행 & 생활>', type: 'asset', onBudget: true }, { id: 'other', name: '비공개 계좌', type: 'asset' },
    { id: 'card', name: '카드', type: 'liability', card: true }, { id: 'expense', name: '지출', type: 'expense' }, { id: 'income', name: '수입', type: 'income' }]) book.createAccount(account);
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank']); setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const header = 'Account,Date,Payee,Notes,Category,Amount,Cleared,Reconciled';
const text = `${header}\r\nChecking,2026-10-01,급여,,Income,30000.00,true,false\r\nChecking,2026-10-02,"가게, 식당","메모 ""확인""\n두 줄",Food,-1500.00,false,false\r\n`;
const preview = (book, csvText = text, accountId = 'bank') => actualCsvPreview(book, 'editor', { accountId, csvText });
const inputFor = (book, csvText = text, patch = {}) => ({ accountId: 'bank', csvText, requestId: randomUUID(), expectedHash: preview(book, csvText).expectedHash, confirmSimple: true, ...patch });
const count = book => book.db.prepare('SELECT COUNT(*) AS n FROM import_events').get().n;

test('Actual CSV parses BOM, quoted commas, quotes, multiline notes and whole-won amounts without writes', () => {
  const book = setup();
  try {
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const result = preview(book, `\uFEFF${text}`);
    assert.equal(result.rows.length, 2); assert.equal(result.inflow, 30000); assert.equal(result.outflow, 1500); assert.equal(result.sourceAccount, 'Checking');
    assert.equal(result.rows.find(row => row.amount < 0).payee, '가게, 식당'); assert.equal(result.rows.find(row => row.amount < 0).notes, '메모 "확인"\n두 줄');
    assert.equal(result.duplicate, false); assert.equal(count(book), 0); assert.equal(book.entries().length, 0);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    const grouped = preview(book, 'Date,Amount,Payee\n2026-10-01,"-1,500",=1+1\n');
    assert.equal(grouped.rows[0].amount, -1500); assert.equal(grouped.rows[0].payee, '=1+1');
  } finally { book.close(); }
});

test('CSV import enters review only and approval enforces existing accounting and category rules', () => {
  const book = setup();
  try {
    const input = inputFor(book); const batch = importActualCsv(book, 'editor', input);
    assert.equal(batch.count, 2); assert.equal(batch.duplicate, false); assert.equal(count(book), 2); assert.equal(book.entries().length, 0);
    const events = listReviewEvents(book, 'editor'); assert.equal(events.length, 2); assert.equal(listReviewEvents(book, 'viewer').length, 2);
    const expense = events.find(event => event.parsed.amount < 0); const income = events.find(event => event.parsed.amount > 0);
    assert.equal(expense.csvRow.category, 'Food'); assert.equal(expense.csvRow.cleared, 'false'); assert.equal(expense.importedBy, 'editor');
    assert.throws(() => approveEvent(book, 'viewer', { eventId: expense.id }), /write access/);
    const expenseInput = { eventId: expense.id, kind: 'expense', counterAccountId: 'expense', categoryId: 'food', amount: 1500, date: expense.parsed.date, payee: expense.parsed.payee };
    approveEvent(book, 'editor', expenseInput); approveEvent(book, 'editor', { eventId: income.id, kind: 'income', counterAccountId: 'income', amount: 30000, date: income.parsed.date, payee: income.parsed.payee });
    assert.equal(book.entries().length, 2); assert.equal(book.budget('2026-10').categories.food.spent, 1500);
    assert.equal(approveEvent(book, 'editor', expenseInput).duplicate, true);
    assert.equal(importActualCsv(book, 'editor', input).duplicate, true); assert.equal(book.entries().length, 2);
  } finally { book.close(); }
});

test('CSV file deduplication ignores row and column order, formatting and retains identical legitimate rows', () => {
  const book = setup();
  try {
    const csvText = 'Date,Amount,Payee\n2026-10-01,-1000,가게\n2026-10-01,-1000,가게\n2026-10-02,2000,입금\n';
    const input = inputFor(book, csvText); importActualCsv(book, 'editor', input); assert.equal(count(book), 3);
    const reordered = '\uFEFFPayee,Amount,Date\r\n입금,2000.00,2026-10-02\r\n가게,-1000.00,2026-10-01\r\n가게,-1000,2026-10-01\r\n';
    assert.equal(preview(book, reordered).batchId, preview(book, csvText).batchId);
    assert.equal(importActualCsv(book, 'editor', inputFor(book, reordered)).duplicate, true); assert.equal(count(book), 3);
    assert.throws(() => importActualCsv(book, 'editor', { ...input, csvText: 'Date,Amount\n2026-10-05,-100\n' }), /reused/);
    assert.throws(() => importActualCsv(book, 'editor', { ...input, expectedHash: 'a'.repeat(64) }), /reused/);
  } finally { book.close(); }
});

test('overlapping CSVs require explicit confirmation and do not silently discard identical transactions', () => {
  const book = setup();
  try {
    const first = 'Date,Amount,Payee\n2026-10-01,-1000,가게\n'; const second = `${first}2026-10-02,-2000,다른 가게\n`;
    const stale = inputFor(book, second); importActualCsv(book, 'editor', inputFor(book, first));
    assert.throws(() => importActualCsv(book, 'editor', stale), /changed/);
    const fresh = inputFor(book, second); assert.equal(preview(book, second).possibleDuplicateCount, 1);
    assert.throws(() => importActualCsv(book, 'editor', fresh), /possible duplicate/); assert.equal(count(book), 1);
    const batch = importActualCsv(book, 'editor', { ...fresh, confirmDuplicates: true }); assert.equal(batch.possibleDuplicateCount, 1); assert.equal(batch.confirmedDuplicates, true); assert.equal(count(book), 3);
    assert.equal(importActualCsv(book, 'editor', { ...fresh, confirmDuplicates: true }).duplicate, true);
  } finally { book.close(); }
});

test('CSV rejects malformed, mixed-account, split, transfer, fractional, oversized and invalid-date inputs atomically', () => {
  const book = setup();
  try {
    for (const csvText of ['', 'Date,Date,Amount\n2026-10-01,2026-10-01,10', 'Date,Payee\n2026-10-01,a', 'Date,Amount\n2026-10-01',
      'Date,Amount\n2026-02-30,10', 'Date,Amount\n2026-10-01,0', 'Date,Amount\n2026-10-01,1.50', 'Date,Amount\n2026-10-01,1+2',
      'Date,Amount\n2026-10-01,9007199254740992', 'Date,Amount\n2026-10-01,"100', 'Date,Amount\n2026-10-01,"100"x',
      'Account,Date,Amount\nA,2026-10-01,10\nB,2026-10-02,20', 'Account,Date,Amount\n,2026-10-01,10',
      'Date,Amount,Notes\n2026-10-01,-100,(SPLIT 1 OF 2) x', 'Date,Amount,Split_Amount\n2026-10-01,100,100',
      'Date,Amount,Payee\n2026-10-01,-100,Transfer: Bank', `Date,Amount,Payee\n2026-10-01,-100,${'x'.repeat(501)}`,
      `Date,Amount\n${'2026-10-01,-1\n'.repeat(201)}`, 'x'.repeat(100001), 'Date,Amount\n2026-10-01,1\0']) assert.throws(() => preview(book, csvText));
    assert.equal(count(book), 0); assert.equal(book.entries().length, 0);
    assert.throws(() => importActualCsv(book, 'editor', inputFor(book, text, { confirmSimple: false })), /Confirm/);
    assert.throws(() => importActualCsv(book, 'editor', inputFor(book, text, { requestId: 'bad' })), /request ID/);
  } finally { book.close(); }
});

test('CSV permissions are current, account metadata changes invalidate previews and positive liability amounts are refused', () => {
  const book = setup();
  try {
    for (const [sub, accountId] of [['viewer', 'bank'], ['editor', 'other'], ['owner', 'expense'], ['missing', 'bank']]) assert.throws(() => actualCsvPreview(book, sub, { accountId, csvText: text }), /write access/);
    assert.throws(() => actualCsvPreview(book, 'owner', { accountId: 'card', csvText: text }), /payment or refund/);
    assert.equal(actualCsvPreview(book, 'owner', { accountId: 'card', csvText: 'Date,Amount\n2026-10-01,-100' }).rows.length, 1);
    const input = inputFor(book); const account = book.accounts().get('bank');
    book.db.prepare('UPDATE accounts SET data = ? WHERE id = ?').run(JSON.stringify({ ...account, name: '다른 이름' }), 'bank');
    assert.throws(() => importActualCsv(book, 'editor', input), /changed/);
    const fresh = inputFor(book); importActualCsv(book, 'editor', fresh);
    setMember(book, 'owner', 'editor', 'editor', []); assert.throws(() => importActualCsv(book, 'editor', fresh), /write access/); assert.equal(listReviewEvents(book, 'editor').length, 0);
  } finally { book.close(); }
});

test('CSV import failure rolls back all events and receipts and retries survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'actual-csv-')); let book;
  try {
    const file = join(dir, 'book.sqlite'); book = setup(file); const input = inputFor(book);
    book.db.exec("CREATE TRIGGER fail_csv BEFORE INSERT ON actual_csv_batches BEGIN SELECT RAISE(ABORT, 'csv failure'); END");
    assert.throws(() => importActualCsv(book, 'editor', input), /csv failure/); assert.equal(count(book), 0);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM actual_csv_requests').get().n, 0);
    book.db.exec('DROP TRIGGER fail_csv'); const batch = importActualCsv(book, 'editor', input);
    book.close(); book = new Book(file); assert.equal(importActualCsv(book, 'editor', input).duplicate, true);
    assert.equal(preview(book).duplicate, true); assert.equal(count(book), 2); assert.deepEqual(listReviewEvents(book, 'editor').map(event => event.id).sort(), [...batch.eventIds].sort());
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP CSV preview and import enforce CSRF and permissions, escape text, preserve sign and allow larger bounded CSV forms', async () => {
  const book = setup(); let sub = 'editor'; const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin`;
  const input = { accountId: 'bank', csvText: `${header}\nChecking,2026-10-01,<거래처 & 확인>,메모,Food,-1000,false,false\nChecking,2026-10-02,급여,,Income,10000,true,false`, requestId: randomUUID(), csrf: 'token', confirmSimple: 'true' };
  const post = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body) });
  try {
    const form = await (await fetch(`${base}/actual-csv`)).text(); assert.match(form, /Actual CSV 가져오기/); assert.doesNotMatch(form, /비공개 계좌/);
    for (const path of ['/actual-csv/preview', '/actual-csv']) assert.equal((await post(path, { ...input, csrf: 'bad' })).status, 403);
    sub = 'viewer'; assert.equal((await fetch(`${base}/actual-csv`)).status, 400); assert.equal((await post('/actual-csv/preview', input)).status, 400); sub = 'editor';
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n; const response = await post('/actual-csv/preview', input); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /&lt;거래처 &amp; 확인&gt;/); assert.match(html, /&lt;은행 &amp; 생활&gt;/);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    const final = { ...input, expectedHash: html.match(/name="expectedHash" value="([^\"]+)"/)[1] };
    const imported = await post('/actual-csv', final); assert.equal(imported.status, 200); const review = await imported.text(); assert.match(review, /아직 원장에 승인하지 않았습니다/); assert.match(review, /value="income" selected/);
    assert.equal((await post('/actual-csv', final)).status, 200); assert.equal(count(book), 2); assert.equal(book.entries().length, 0);
    const big = 'Date,Amount,Notes\n' + Array.from({ length: 60 }, (_, index) => `2026-10-01,-${index + 1},${'가'.repeat(100)}`).join('\n');
    assert.ok(new URLSearchParams({ ...input, csvText: big }).toString().length > 16384);
    assert.equal((await post('/actual-csv/preview', { ...input, csvText: big })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
