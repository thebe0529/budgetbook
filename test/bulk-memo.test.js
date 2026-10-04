import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual, accountRegister } from '../src/manual.js';
import { recordSplitManual } from '../src/split-manual.js';
import { manualEditPreview, updateManualTransaction } from '../src/manual-edit.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { updateSelectedMemos } from '../src/bulk-memo.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { transactionHistory } from '../src/transaction-history.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['private', 'asset'], ['expense', 'expense']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, overrides = {}, sub = 'editor') => recordManual(book, sub, { requestId: randomUUID(),
  date: '2026-10-01', kind: 'expense', accountId: 'bank', counterId: 'expense', categoryId: 'food',
  amountExpression: '500', memo: 'before', ...overrides }).entry;
const split = book => recordSplitManual(book, 'editor', { requestId: randomUUID(), date: '2026-10-02', kind: 'expense',
  accountId: 'bank', memo: 'before split', lines: [{ counterId: 'expense', amountExpression: '100', categoryId: 'food' },
    { counterId: 'expense', amountExpression: '200', categoryId: 'food' }] }).entry;
const selection = entry => ({ entryId: entry.id, expectedHash: entryFingerprint(entry) });
const input = entries => ({ accountId: 'bank', selections: entries.map(selection), memo: '새 메모', requestId: randomUUID() });
const count = (book, table) => book.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
function confirm(book, accountId, throughDate = '2026-10-31') {
  const register = accountRegister(book, 'owner', accountId, throughDate);
  for (const row of register.rows) setTransactionChecked(book, 'owner', accountId, row.id, true, row.confirmationHash);
  return register;
}

test('bulk memo updates preserve simple and split accounting, authors and budget while auditing and invalidating checks', () => {
  const book = setup();
  try {
    const originals = [create(book), split(book)]; confirm(book, 'bank');
    const budget = book.budget('2026-10'); const reports = book.reports('2026-10-01', '2026-10-31');
    assert.deepEqual(updateSelectedMemos(book, 'editor', { ...input(originals), memo: '  공통 메모  ' }), { count: 2, duplicate: false });
    for (const original of originals) {
      const next = book.entries().find(entry => entry.id === original.id);
      assert.equal(next.memo, '공통 메모'); assert.equal(next.revision, 2); assert.equal(next.createdBy, original.createdBy);
      assert.equal(next.date, original.date); assert.deepEqual(next.postings, original.postings);
      assert.deepEqual(next.budgetAllocations, original.budgetAllocations);
      const history = transactionHistory(book, 'viewer', 'bank', original.id);
      assert.equal(history.versions[0].memo, original.memo); assert.equal(history.versions[1].actor, 'editor');
    }
    assert.deepEqual(book.budget('2026-10'), budget); assert.deepEqual(book.reports('2026-10-01', '2026-10-31'), reports);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-10-31').uncheckedCount, 2);
    assert.equal(count(book, 'entry_revisions'), 2); assert.equal(count(book, 'bulk_memo_requests'), 1);
    const current = book.entries();
    updateSelectedMemos(book, 'editor', { ...input(current), memo: '' });
    assert.ok(book.entries().every(entry => entry.memo === ''));
  } finally { book.close(); }
});

test('bulk memo receipts canonicalize selection order and never overwrite later updates on retry', () => {
  const book = setup();
  try {
    const entries = [create(book), split(book)]; const request = input(entries);
    updateSelectedMemos(book, 'editor', request);
    assert.equal(updateSelectedMemos(book, 'editor', { ...request, selections: [...request.selections].reverse() }).duplicate, true);
    const preview = manualEditPreview(book, 'editor', entries[0].id);
    updateManualTransaction(book, 'editor', { ...preview.input, entryId: entries[0].id, expectedHash: preview.expectedHash,
      updateRequestId: randomUUID(), memo: '나중에 수정' });
    assert.equal(updateSelectedMemos(book, 'editor', request).duplicate, true);
    assert.equal(book.entries().find(entry => entry.id === entries[0].id).memo, '나중에 수정');
    assert.equal(count(book, 'entry_revisions'), 3); assert.equal(count(book, 'bulk_memo_requests'), 1);
    assert.throws(() => updateSelectedMemos(book, 'editor', { ...request, memo: '다른 내용' }), /reused/);
    assert.throws(() => updateSelectedMemos(book, 'owner', request), /reused/);
    const before = book.entries();
    assert.throws(() => updateSelectedMemos(book, 'editor', { ...request, requestId: randomUUID() }), /changed/);
    assert.deepEqual(book.entries(), before); assert.equal(count(book, 'entry_revisions'), 3);
  } finally { book.close(); }
});

test('bulk memo rejects unsupported, canceled, foreign, out-of-account and inaccessible transfer selections atomically', () => {
  const book = setup();
  try {
    const good = create(book); const foreign = create(book, {}, 'owner');
    const transfer = create(book, { kind: 'transfer', counterId: 'other', categoryId: null });
    const canceled = create(book);
    reverseManualTransaction(book, 'owner', { entryId: canceled.id, date: '2026-10-02', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'owner', canceled.id).expectedHash, requestId: randomUUID() });
    book.record({ id: 'import', date: '2026-10-01', kind: 'import', postings: good.postings });
    const outside = create(book, { accountId: 'private', categoryId: null }, 'owner');
    setMember(book, 'owner', 'editor', 'editor', ['bank']);
    const before = book.entries();
    for (const bad of [foreign, transfer, canceled, outside, book.entries().find(entry => entry.id === 'import')]) {
      assert.throws(() => updateSelectedMemos(book, 'editor', input([good, bad])));
      assert.deepEqual(book.entries(), before);
    }
    assert.throws(() => updateSelectedMemos(book, 'viewer', input([good])), /write access/);
    for (const bad of [{ selections: [] }, { selections: [selection(good), selection(good)] },
      { selections: Array.from({ length: 201 }, () => selection(good)) }, { selections: [null] },
      { memo: null }, { memo: 'x'.repeat(501) }, { requestId: 'bad' }]) {
      assert.throws(() => updateSelectedMemos(book, 'editor', { ...input([good]), ...bad }));
    }
    assert.equal(count(book, 'entry_revisions'), 0); assert.equal(count(book, 'bulk_memo_requests'), 0);
  } finally { book.close(); }
});

test('a later locked transfer rolls back earlier memo writes, revisions and the batch receipt', () => {
  const book = setup();
  try {
    const first = create(book, { requestId: '00000000-0000-4000-8000-000000000001' });
    const locked = create(book, { requestId: '00000000-0000-4000-8000-000000000002', kind: 'transfer', counterId: 'other', categoryId: null });
    const register = confirm(book, 'other');
    const compared = compareStatement(book, 'owner', 'other', '2026-10-31', String(register.balance));
    const saved = saveStatementComparison(book, 'owner', { accountId: 'other', throughDate: '2026-10-31',
      statementExpression: String(register.balance), expectedHash: compared.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    const before = book.entries();
    assert.throws(() => updateSelectedMemos(book, 'editor', input([first, locked])), /period is locked/);
    assert.deepEqual(book.entries(), before);
    assert.equal(count(book, 'entry_revisions'), 0); assert.equal(count(book, 'bulk_memo_requests'), 0);
  } finally { book.close(); }
});

test('HTTP bulk memo supports checked selections, enforces CSRF and access and retains search and sort', async () => {
  const book = setup(); const first = create(book); split(book); confirm(book, 'bank');
  let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/register`;
  try {
    const params = new URLSearchParams({ accountId: 'bank', status: 'checked', memo: 'before', sort: 'memo-asc', fromDate: '2026-10-01' });
    const html = await (await fetch(`${base}?${params}`)).text();
    assert.equal((html.match(/name="selection"/g) || []).length, 2);
    assert.match(html, /formaction="\/admin\/register\/memo-selected"/);
    const values = new URLSearchParams(params); values.set('csrf', 'bad'); values.set('newMemo', '<새 메모 & 확인>');
    values.set('requestId', html.match(/name="requestId" value="([^"]+)"/g).at(-1).match(/value="([^"]+)"/)[1]);
    values.append('selection', JSON.stringify(selection(first)));
    const send = () => fetch(`${base}/memo-selected`, { method: 'POST', body: values });
    assert.equal((await send()).status, 403);
    values.set('csrf', 'token'); sub = 'viewer'; assert.equal((await send()).status, 400);
    sub = 'editor'; const response = await send(); assert.equal(response.status, 200);
    const after = await response.text();
    assert.match(after, /value="memo-asc" selected/); assert.match(after, /value="checked" selected/);
    assert.match(after, /name="memo" maxlength="200" value="before"/);
    assert.match(after, /조건에 맞는 1건/);
    assert.equal(book.entries().find(entry => entry.id === first.id).memo, '<새 메모 & 확인>');
    assert.equal((await send()).status, 200); assert.equal(count(book, 'entry_revisions'), 1);
    const all = await (await fetch(`${base}?accountId=bank`)).text();
    assert.match(all, /&lt;새 메모 &amp; 확인&gt;/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('bulk memo audit and duplicate detection survive a database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budgetbook-memo-'));
  let book;
  try {
    const filename = join(dir, 'book.sqlite'); book = setup(filename);
    const entry = create(book); const request = input([entry]);
    updateSelectedMemos(book, 'editor', request); book.close(); book = new Book(filename);
    assert.equal(updateSelectedMemos(book, 'editor', request).duplicate, true);
    assert.equal(book.entries()[0].memo, '새 메모'); assert.equal(count(book, 'entry_revisions'), 1);
    assert.equal(transactionHistory(book, 'viewer', 'bank', entry.id).versions[0].memo, 'before');
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});
