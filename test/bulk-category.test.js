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
import { updateSelectedCategories } from '../src/bulk-memo.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { manualEditPreview, updateManualTransaction } from '../src/manual-edit.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['outside', 'asset'], ['expense', 'expense'], ['income', 'income']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  }
  for (const id of ['food', 'travel']) book.createBudgetCategory({ id, name: id });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'outside']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, overrides = {}, sub = 'editor') => recordManual(book, sub, {
  requestId: randomUUID(), date: '2026-10-01', kind: 'expense', accountId: 'bank', counterId: 'expense',
  categoryId: 'food', amountExpression: '500', memo: '원래 메모', ...overrides }).entry;
const select = entry => ({ entryId: entry.id, expectedHash: entryFingerprint(entry) });
const request = entries => ({ accountId: 'bank', categoryId: 'travel', requestId: randomUUID(), selections: entries.map(select) });
const count = (book, table) => book.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('bulk categories reallocate original months and every split row, preserving accounting and audit', () => {
  const book = setup();
  try {
    const first = create(book);
    const split = recordSplitManual(book, 'editor', { requestId: randomUUID(), date: '2026-11-01', kind: 'expense',
      accountId: 'bank', memo: '분할 메모', lines: [
        { counterId: 'expense', amountExpression: '100', categoryId: 'food' },
        { counterId: 'expense', amountExpression: '200', categoryId: 'travel' }] }).entry;
    for (const entry of [first, split]) setTransactionChecked(book, 'editor', 'bank', entry.id, true, entryFingerprint(entry));
    const beforeOct = book.budget('2026-10'); const beforeNov = book.budget('2026-11');
    assert.deepEqual(updateSelectedCategories(book, 'editor', request([first, split])), { count: 2, duplicate: false });
    for (const old of [first, split]) {
      const next = book.entries().find(e => e.id === old.id);
      for (const key of ['date', 'memo', 'postings', 'createdBy']) assert.deepEqual(next[key], old[key]);
      assert.equal(next.revision, 2);
      assert.ok(next.budgetAllocations.every(a => a.categoryId === 'travel'));
      assert.deepEqual(JSON.parse(book.db.prepare('SELECT data FROM entry_revisions WHERE entry_id = ?').get(old.id).data), old);
    }
    assert.notDeepEqual(book.budget('2026-10'), beforeOct); assert.notDeepEqual(book.budget('2026-11'), beforeNov);
    assert.equal(book.budget('2026-10').categories.food.spent, 0);
    assert.equal(book.budget('2026-10').categories.travel.spent, 500);
    assert.equal(book.budget('2026-11').categories.food.spent, 0);
    assert.equal(book.budget('2026-11').categories.travel.spent, 300);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-11-30').uncheckedCount, 2);
    updateSelectedCategories(book, 'editor', { ...request(book.entries()), categoryId: '' });
    assert.ok(book.entries().every(e => !e.budgetAllocations?.length));
  } finally { book.close(); }
});

test('bulk category receipt and audit survive database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budgetbook-category-')); let book;
  try {
    const filename = join(dir, 'book.sqlite'); book = setup(filename);
    const entry = create(book); const input = request([entry]);
    updateSelectedCategories(book, 'editor', input); book.close(); book = new Book(filename);
    assert.equal(updateSelectedCategories(book, 'editor', input).duplicate, true);
    assert.equal(book.entries()[0].budgetAllocations[0].categoryId, 'travel');
    assert.equal(count(book, 'entry_revisions'), 1); assert.equal(count(book, 'bulk_category_requests'), 1);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('bulk category retries preserve later edits and reject mismatched or stale requests', () => {
  const book = setup();
  try {
    const entries = [create(book), create(book)]; const input = request(entries);
    updateSelectedCategories(book, 'editor', input);
    const preview = manualEditPreview(book, 'editor', entries[0].id);
    updateManualTransaction(book, 'editor', { ...preview.input, categoryId: 'food', entryId: entries[0].id,
      expectedHash: preview.expectedHash, updateRequestId: randomUUID() });
    assert.equal(updateSelectedCategories(book, 'editor', { ...input, selections: [...input.selections].reverse() }).duplicate, true);
    assert.equal(book.entries().find(e => e.id === entries[0].id).budgetAllocations[0].categoryId, 'food');
    assert.throws(() => updateSelectedCategories(book, 'editor', { ...input, categoryId: '' }), /reused/);
    assert.throws(() => updateSelectedCategories(book, 'editor', { ...input, requestId: randomUUID() }), /changed/);
    assert.equal(count(book, 'bulk_category_requests'), 1); assert.equal(count(book, 'entry_revisions'), 3);
  } finally { book.close(); }
});

test('bulk categories reject nonexpense, off-budget, foreign and invalid targets without partial edits', () => {
  const book = setup();
  try {
    const good = create(book); const foreign = create(book, {}, 'owner');
    const income = create(book, { kind: 'income', counterId: 'income', categoryId: null });
    const outside = create(book, { accountId: 'outside', categoryId: null });
    const before = book.entries();
    for (const bad of [foreign, income, outside]) assert.throws(() => updateSelectedCategories(book, 'editor', request([good, bad])));
    for (const categoryId of [null, 'missing', 5]) assert.throws(() => updateSelectedCategories(book, 'editor', { ...request([good]), categoryId }));
    assert.throws(() => updateSelectedCategories(book, 'editor', { ...request([outside]), accountId: 'outside' }), /off-budget/);
    assert.throws(() => updateSelectedCategories(book, 'viewer', request([good])), /write access/);
    assert.deepEqual(book.entries(), before); assert.equal(count(book, 'entry_revisions'), 0);
  } finally { book.close(); }
});

test('a later locked expense rolls back category changes, budget, audit and receipt', () => {
  const book = setup();
  try {
    const first = create(book, { requestId: '00000000-0000-4000-8000-000000000001', date: '2026-11-01' });
    const locked = create(book, { requestId: '00000000-0000-4000-8000-000000000002' });
    setTransactionChecked(book, 'owner', 'bank', locked.id, true, entryFingerprint(locked));
    const compared = compareStatement(book, 'owner', 'bank', '2026-10-31', '-500');
    const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-31',
      statementExpression: '-500', expectedHash: compared.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    const before = book.entries(); const budget = book.budget('2026-11');
    assert.throws(() => updateSelectedCategories(book, 'editor', request([first, locked])), /period is locked/);
    assert.deepEqual(book.entries(), before); assert.deepEqual(book.budget('2026-11'), budget);
    assert.equal(count(book, 'entry_revisions'), 0); assert.equal(count(book, 'bulk_category_requests'), 0);
  } finally { book.close(); }
});

test('HTTP category action enforces CSRF, supports checked rows and retains filters', async () => {
  const book = setup(); const entry = create(book);
  setTransactionChecked(book, 'editor', 'bank', entry.id, true, entryFingerprint(entry));
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/register`;
  try {
    const html = await (await fetch(`${url}?accountId=bank`)).text();
    assert.match(html, /name="newCategoryId"/); assert.match(html, /모든 행에 같은 카테고리/);
    const form = new URLSearchParams({ accountId: 'bank', csrf: 'bad', newCategoryId: 'travel', requestId: randomUUID(),
      sort: 'memo-asc', memo: '원래', selection: JSON.stringify(select(entry)) });
    const send = () => fetch(`${url}/category-selected`, { method: 'POST', body: form });
    assert.equal((await send()).status, 403); form.set('csrf', 'token');
    const response = await send(); assert.equal(response.status, 200);
    const after = await response.text(); assert.match(after, /value="memo-asc" selected/); assert.match(after, /value="원래"/);
    assert.equal(book.entries()[0].memo, entry.memo); assert.equal((await send()).status, 200);
    assert.equal(count(book, 'entry_revisions'), 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
