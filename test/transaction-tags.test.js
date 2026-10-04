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
import { tagEditPreview, transactionTags, normalizeTags, updateTransactionTags } from '../src/transaction-tags.js';
import { manualEditPreview, updateManualTransaction } from '../src/manual-edit.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { transactionHistory } from '../src/transaction-history.js';
import { registerFilters, registerPage } from '../src/register-view.js';
import { registerTransactionsCsv } from '../src/register-export.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['private', 'asset'], ['expense', 'expense']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, overrides = {}, sub = 'editor') => recordManual(book, sub, { requestId: randomUUID(),
  date: '2026-10-01', kind: 'expense', accountId: 'bank', counterId: 'expense', categoryId: 'food',
  amountExpression: '500', memo: '점심', ...overrides }).entry;
const input = (book, entry, tags, sub = 'editor') => ({ accountId: 'bank', entryId: entry.id,
  ...tagEditPreview(book, sub, 'bank', entry.id), requestId: randomUUID(), tags });
const auditCount = book => book.db.prepare('SELECT COUNT(*) AS n FROM transaction_tag_changes').get().n;

test('tag normalization deduplicates, trims and rejects excessive or invisible tags', () => {
  assert.deepEqual(normalizeTags(' 여행, 점심,여행,, '), ['여행', '점심']);
  assert.deepEqual(normalizeTags('e\u0301,é'), ['é']);
  for (const value of [null, 'x'.repeat(31), 'x'.repeat(501), 'a\nb', 'a\u200bb',
    Array.from({ length: 11 }, (_, i) => `tag${i}`).join(',')]) assert.throws(() => normalizeTags(value));
  assert.deepEqual(normalizeTags(' , '), []);
});

test('tags preserve financial entry, checks and budget through later transaction edits and clear with audit', () => {
  const book = setup();
  try {
    const entry = create(book); const beforeBudget = book.budget('2026-10');
    setTransactionChecked(book, 'editor', 'bank', entry.id, true, entryFingerprint(entry));
    updateTransactionTags(book, 'editor', input(book, entry, '여행, 점심'));
    assert.deepEqual(book.entries()[0], entry); assert.deepEqual(book.budget('2026-10'), beforeBudget);
    assert.equal(accountRegister(book, 'viewer', 'bank', '2026-10-31').rows[0].checked, true);
    const edit = manualEditPreview(book, 'editor', entry.id);
    updateManualTransaction(book, 'editor', { ...edit.input, entryId: entry.id, expectedHash: edit.expectedHash,
      updateRequestId: randomUUID(), memo: '저녁' });
    assert.deepEqual(transactionTags(book, entry.id).tags, ['여행', '점심']);
    updateTransactionTags(book, 'editor', input(book, entry, ''));
    const history = transactionHistory(book, 'viewer', 'bank', entry.id);
    assert.deepEqual(history.tags, []); assert.deepEqual(history.tagChanges[1].before, ['여행', '점심']);
    assert.equal(history.tagChanges[1].actor, 'editor'); assert.match(history.tagChanges[1].changedAt, /Z$/);
  } finally { book.close(); }
});

test('tag optimistic concurrency covers tags and ledger; retries do not overwrite later changes', () => {
  const book = setup();
  try {
    const entry = create(book); const first = input(book, entry, '여행');
    const stale = input(book, entry, '점심'); updateTransactionTags(book, 'editor', first);
    assert.throws(() => updateTransactionTags(book, 'editor', stale), /changed/);
    updateTransactionTags(book, 'editor', input(book, entry, '저녁'));
    assert.equal(updateTransactionTags(book, 'editor', first).duplicate, true);
    assert.deepEqual(transactionTags(book, entry.id).tags, ['저녁']);
    assert.throws(() => updateTransactionTags(book, 'editor', { ...first, tags: '다른 태그' }), /reused/);
    const ledgerStale = input(book, entry, '점심');
    const edit = manualEditPreview(book, 'editor', entry.id);
    updateManualTransaction(book, 'editor', { ...edit.input, entryId: entry.id, expectedHash: edit.expectedHash,
      updateRequestId: randomUUID(), amountExpression: '600' });
    assert.throws(() => updateTransactionTags(book, 'editor', ledgerStale), /changed/);
    assert.equal(auditCount(book), 2);
  } finally { book.close(); }
});

test('tag writes require author or owner, all financial rights and uncanceled manual source', () => {
  const book = setup();
  try {
    const entry = create(book); const own = create(book, {}, 'owner');
    const transfer = create(book, { kind: 'transfer', counterId: 'private', categoryId: null }, 'owner');
    for (const [sub, target] of [['viewer', entry], ['editor', own], ['editor', transfer]]) {
      assert.throws(() => tagEditPreview(book, sub, 'bank', target.id), /write access/);
    }
    const ownerInput = input(book, transfer, '이체', 'owner');
    updateTransactionTags(book, 'owner', ownerInput);
    const split = recordSplitManual(book, 'editor', { requestId: randomUUID(), date: '2026-10-02', kind: 'expense',
      accountId: 'bank', lines: [100, 200].map(amount => ({ counterId: 'expense', amountExpression: String(amount), categoryId: 'food' })) }).entry;
    updateTransactionTags(book, 'editor', input(book, split, '분할'));
    const canceledInput = input(book, entry, '취소');
    reverseManualTransaction(book, 'editor', { entryId: entry.id, date: '2026-10-02', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'editor', entry.id).expectedHash, requestId: randomUUID() });
    assert.throws(() => updateTransactionTags(book, 'editor', canceledInput), /write access/);
    book.record({ id: 'import', date: '2026-10-01', kind: 'import', postings: entry.postings });
    assert.throws(() => tagEditPreview(book, 'owner', 'bank', 'import'), /write access/);
    assert.throws(() => tagEditPreview(book, 'owner', 'private', own.id), /write access/);
    assert.equal(auditCount(book), 2);
  } finally { book.close(); }
});

test('tag search and CSV use exact current tags while locked review and checks stay intact', () => {
  const book = setup();
  try {
    const entry = create(book);
    setTransactionChecked(book, 'owner', 'bank', entry.id, true, entryFingerprint(entry));
    const preview = compareStatement(book, 'owner', 'bank', '2026-10-31', '-500');
    const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-31',
      statementExpression: '-500', expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    updateTransactionTags(book, 'editor', input(book, entry, '=SUM(1), 여행'));
    assert.equal(compareStatement(book, 'owner', 'bank', '2026-10-31', '-500').stateHash, preview.stateHash);
    const register = accountRegister(book, 'viewer', 'bank', '2026-10-31');
    const filter = tag => registerFilters(new URLSearchParams({ tag }));
    assert.equal(registerPage(register, filter('여행')).total, 1); assert.equal(registerPage(register, filter('여')).total, 0);
    const csv = registerTransactionsCsv(book, 'viewer', 'bank', new URLSearchParams({ tag: '여행' }));
    assert.match(csv, /태그\(현재\)/); assert.ok(csv.includes("'=SUM(1), 여행")); assert.match(csv, /확인 완료/);
    assert.throws(() => filter('a,b'), /tag search/);
  } finally { book.close(); }
});

test('tag receipts persist across database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budgetbook-tags-')); let book;
  try {
    const filename = join(dir, 'book.sqlite'); book = setup(filename);
    const entry = create(book); const request = input(book, entry, '여행');
    updateTransactionTags(book, 'editor', request); book.close(); book = new Book(filename);
    assert.equal(updateTransactionTags(book, 'editor', request).duplicate, true);
    assert.deepEqual(transactionTags(book, entry.id).tags, ['여행']); assert.equal(auditCount(book), 1);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('failed tag audit rolls back metadata and leaves the request retryable', () => {
  const book = setup();
  try {
    const entry = create(book); const request = input(book, entry, '여행');
    book.db.exec(`CREATE TRIGGER reject_tag_audit BEFORE INSERT ON transaction_tag_changes
      BEGIN SELECT RAISE(ABORT, 'Audit unavailable'); END;`);
    assert.throws(() => updateTransactionTags(book, 'editor', request), /Audit unavailable/);
    assert.deepEqual(transactionTags(book, entry.id).tags, []); assert.equal(auditCount(book), 0);
    book.db.exec('DROP TRIGGER reject_tag_audit');
    assert.equal(updateTransactionTags(book, 'editor', request).duplicate, false);
    assert.deepEqual(transactionTags(book, entry.id).tags, ['여행']);
  } finally { book.close(); }
});

test('HTTP tag editor enforces CSRF and permissions, escapes tags and retains search filters', async () => {
  const book = setup(); const entry = create(book); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin`;
  try {
    const url = `${base}/transactions/tags?accountId=bank&entryId=${encodeURIComponent(entry.id)}&sort=memo-desc&memo=점심`;
    const response = await fetch(url); assert.equal(response.status, 200);
    const html = await response.text(); const form = new URLSearchParams();
    for (const [, name, value] of html.matchAll(/type="hidden" name="([^"]+)" value="([^"]*)"/g)) form.set(name, value);
    form.set('tags', '<여행 & 식비>'); form.set('csrf', 'bad');
    const send = () => fetch(`${base}/transactions/tags`, { method: 'POST', body: form });
    assert.equal((await send()).status, 403); form.set('csrf', 'token'); sub = 'viewer';
    assert.equal((await fetch(url)).status, 400); assert.equal((await send()).status, 400);
    sub = 'editor'; const saved = await send(); assert.equal(saved.status, 200);
    const after = await saved.text(); assert.match(after, /&lt;여행 &amp; 식비&gt;/); assert.match(after, /value="memo-desc" selected/);
    const filtered = await (await fetch(`${base}/register?accountId=bank&tag=${encodeURIComponent('<여행 & 식비>')}`)).text();
    assert.match(filtered, /조건에 맞는 1건/);
    const history = await (await fetch(`${base}/transactions/history?accountId=bank&entryId=${encodeURIComponent(entry.id)}`)).text();
    assert.match(history, /태그 이력/); assert.match(history, /&lt;여행 &amp; 식비&gt;/);
    assert.equal((await send()).status, 200); assert.equal(auditCount(book), 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
