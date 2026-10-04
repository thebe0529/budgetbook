import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual } from '../src/manual.js';
import { recordSplitManual, updateSplitManual } from '../src/split-manual.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { transactionHistory } from '../src/transaction-history.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['private', 'asset'], ['expense', 'expense']]) {
    book.createAccount({ id, name: `<${id}>`, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '<식비>' });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other', 'private']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank', 'other']);
  return book;
}
const splitInput = () => ({ requestId: randomUUID(), date: '2026-10-01', kind: 'expense', accountId: 'bank',
  memo: '<첫 메모>', lines: [{ counterId: 'expense', amountExpression: '100', categoryId: 'food' },
    { counterId: 'expense', amountExpression: '200', categoryId: 'food' }] });
const cancel = (book, entry) => reverseManualTransaction(book, 'owner', { entryId: entry.id,
  date: '2026-11-01', reason: '<취소 사유>', requestId: randomUUID(),
  expectedHash: manualReversalPreview(book, 'owner', entry.id).expectedHash });

test('history shows each saved version with its own editor and budget, without altering the ledger', () => {
  const book = setup();
  try {
    const input = splitInput();
    const first = recordSplitManual(book, 'editor', input).entry;
    updateSplitManual(book, 'owner', first.id, 1, { ...input, date: '2026-10-02', memo: '수정1',
      lines: input.lines.map(line => ({ ...line, amountExpression: '400' })) });
    updateSplitManual(book, 'editor', first.id, 2, { ...input, memo: '수정2' });
    const before = book.entries();
    const history = transactionHistory(book, 'viewer', 'bank', first.id);
    assert.deepEqual(history.versions.map(v => [v.revision, v.actor, v.memo]),
      [[1, 'editor', '<첫 메모>'], [2, 'owner', '수정1'], [3, 'editor', '수정2']]);
    assert.equal(history.versions[0].changedAt, null);
    assert.match(history.versions[1].changedAt, /^\d{4}-\d\d-\d\dT/);
    assert.equal(history.versions[1].date, '2026-10-02');
    assert.equal(history.versions[1].postings.at(-1).amount, 800);
    assert.equal(history.versions[1].budgetAllocations[0].categoryName, '<식비>');
    assert.equal(history.reversal, null);
    assert.deepEqual(book.entries(), before);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 2);
  } finally { book.close(); }
});

test('history protects old transfer destinations even when the latest version is readable', () => {
  const book = setup();
  try {
    const input = { ...splitInput(), kind: 'transfer', lines: [
      { counterId: 'private', amountExpression: '100' }, { counterId: 'other', amountExpression: '200' }] };
    const entry = recordSplitManual(book, 'editor', input).entry;
    updateSplitManual(book, 'editor', entry.id, 1, { ...input,
      lines: input.lines.map(line => ({ ...line, counterId: 'other' })) });
    assert.throws(() => transactionHistory(book, 'viewer', 'bank', entry.id), /history read access/);
    assert.throws(() => transactionHistory(book, 'viewer', 'other', entry.id), /history read access/);
    assert.equal(transactionHistory(book, 'owner', 'bank', entry.id).versions.length, 2);
    setMember(book, 'owner', 'viewer', 'viewer', ['bank', 'other', 'private']);
    assert.equal(transactionHistory(book, 'viewer', 'bank', entry.id).versions.length, 2);
    assert.throws(() => transactionHistory(book, 'viewer', 'expense', entry.id), /history read access/);
    assert.throws(() => transactionHistory(book, 'unknown', 'bank', entry.id), /history read access/);
    assert.throws(() => transactionHistory(book, 'owner', 'bank', 'missing'), /history read access/);
  } finally { book.close(); }
});

test('original and reversal history resolve to the same preserved audit and require account membership', () => {
  const book = setup();
  try {
    const entry = recordManual(book, 'editor', { requestId: randomUUID(), date: '2026-10-01',
      kind: 'expense', accountId: 'bank', counterId: 'expense', amountExpression: '500', categoryId: 'food' }).entry;
    const reversal = cancel(book, entry).entry;
    const before = book.entries();
    const originalHistory = transactionHistory(book, 'viewer', 'bank', entry.id);
    assert.deepEqual(transactionHistory(book, 'viewer', 'bank', reversal.id), originalHistory);
    assert.equal(originalHistory.reversal.actor, 'owner');
    assert.equal(originalHistory.reversal.reason, '<취소 사유>');
    assert.equal(originalHistory.reversal.entry.budgetAllocations[0].amount, -500);
    assert.equal(originalHistory.reversal.entry.id, reversal.id);
    assert.equal(originalHistory.versions.length, 1);
    assert.deepEqual(book.entries(), before);
    assert.throws(() => transactionHistory(book, 'owner', 'other', entry.id), /history read access/);
    book.record({ id: 'import', date: '2026-10-01', kind: 'import', postings: entry.postings });
    assert.throws(() => transactionHistory(book, 'owner', 'bank', 'import'), /history read access/);
  } finally { book.close(); }
});

test('HTTP history is authenticated, read-only, escaped and linked from original and reversal rows', async () => {
  const book = setup();
  const input = splitInput(); const entry = recordSplitManual(book, 'editor', input).entry;
  updateSplitManual(book, 'owner', entry.id, 1, { ...input, memo: '<수정>' });
  const reversal = cancel(book, entry).entry;
  let session = { sub: 'viewer', role: 'viewer', csrf: 'token' };
  const server = createImportApi(book, { auth: { session: () => session } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const historyUrl = id => `${base}/admin/transactions/history?${new URLSearchParams({ accountId: 'bank', entryId: id })}`;
  try {
    const response = await fetch(historyUrl(reversal.id));
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /버전 1/); assert.match(html, /버전 2/);
    assert.match(html, /수정자: owner/); assert.match(html, /취소자: owner/);
    assert.match(html, /&lt;첫 메모&gt;/); assert.match(html, /&lt;bank&gt;/);
    assert.match(html, /&lt;식비&gt;/); assert.match(html, /&lt;취소 사유&gt;/);
    assert.ok(!html.includes('<form')); assert.ok(!html.includes('<첫 메모>'));
    const register = await (await fetch(`${base}/admin/register?accountId=bank`)).text();
    assert.ok(register.includes(`entryId=${encodeURIComponent(entry.id)}">변경 이력`));
    assert.ok(register.includes(`entryId=${encodeURIComponent(reversal.id)}">변경 이력`));
    assert.equal((await fetch(`${base}/admin/transactions/history?accountId=private&entryId=${encodeURIComponent(entry.id)}`)).status, 400);
    const transfer = { ...splitInput(), kind: 'transfer', lines: [
      { counterId: 'private', amountExpression: '100' }, { counterId: 'other', amountExpression: '200' }] };
    const hidden = recordSplitManual(book, 'editor', transfer).entry;
    updateSplitManual(book, 'editor', hidden.id, 1, { ...transfer,
      lines: transfer.lines.map(line => ({ ...line, counterId: 'other' })) });
    const denied = await fetch(historyUrl(hidden.id));
    assert.equal(denied.status, 400);
    assert.ok(!(await denied.text()).includes('&lt;private&gt;'));
    session = null;
    const unauthenticated = await fetch(historyUrl(entry.id), { redirect: 'manual' });
    assert.equal(unauthenticated.status, 302); assert.equal(unauthenticated.headers.get('location'), '/auth/login');
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
