import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountRegister, recordManual } from '../src/manual.js';
import { recordSplitManual, updateSplitManual, editableManual } from '../src/split-manual.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { localSnapshot } from '../src/local-sync.js';
import { compareStatement, completeStatementReview, saveStatementComparison } from '../src/statement-comparison.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';
import { saveSchedule, linkOccurrence, matchingEntries, linkedOccurrences } from '../src/forecast.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['expense', 'expense'], ['income', 'income']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank', cash: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'category', name: '생활비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
function expense(book) {
  return recordManual(book, 'editor', { requestId: randomUUID(), date: '2026-10-01', kind: 'expense',
    accountId: 'bank', counterId: 'expense', categoryId: 'category', amountExpression: '500', memo: '점심' }).entry;
}
function cancellation(book, entry, date = '2026-10-01') {
  return { entryId: entry.id, date, reason: '잘못 입력', requestId: randomUUID(),
    expectedHash: manualReversalPreview(book, 'owner', entry.id).expectedHash };
}

test('manual cancellation preserves original and restores ledger and budget once with strict retry matching', () => {
  const book = setup();
  try {
    const original = expense(book);
    const input = cancellation(book, original);
    const first = reverseManualTransaction(book, 'editor', input);
    assert.equal(first.duplicate, false);
    assert.equal(reverseManualTransaction(book, 'editor', input).duplicate, true);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-10-31').balance, 0);
    assert.equal(book.budget('2026-10').categories.category.spent, 0);
    assert.deepEqual(book.entries().find(e => e.id === original.id), original);
    assert.equal(book.entries().length, 2);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-10-31').rows.find(row => row.id === original.id).reversalId, first.entry.id);
    assert.throws(() => reverseManualTransaction(book, 'editor', { ...input, reason: '다른 이유' }), /reused/);
    assert.throws(() => reverseManualTransaction(book, 'editor', { ...input, requestId: randomUUID() }), /already reversed/);
    assert.throws(() => book.db.prepare('UPDATE entries SET data = data WHERE id = ?').run(original.id), /cannot be changed/);
    assert.throws(() => book.db.prepare('DELETE FROM entries WHERE id = ?').run(first.entry.id), /cannot be changed/);
  } finally { book.close(); }
});

test('split cancellation reverses latest amounts and prevents future edits and offline editing', () => {
  const book = setup();
  try {
    const input = { requestId: randomUUID(), date: '2026-10-01', kind: 'expense', accountId: 'bank', lines: [
      { counterId: 'expense', amountExpression: '100', categoryId: 'category' },
      { counterId: 'expense', amountExpression: '200', categoryId: 'category' }] };
    const original = recordSplitManual(book, 'editor', input).entry;
    const stale = cancellation(book, original);
    updateSplitManual(book, 'editor', original.id, 1, { ...input, lines: [
      { ...input.lines[0], amountExpression: '400' }, { ...input.lines[1], amountExpression: '600' }] });
    assert.throws(() => reverseManualTransaction(book, 'editor', stale), /changed/);
    reverseManualTransaction(book, 'editor', cancellation(book, original, '2026-11-01'));
    assert.equal(book.budget('2026-10').categories.category.spent, 1000);
    assert.equal(book.budget('2026-11').categories.category.spent, -1000);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-11-30').balance, 0);
    assert.equal(editableManual(book, 'editor', original.id), null);
    assert.throws(() => updateSplitManual(book, 'editor', original.id, 2, input), /cannot be edited/);
    const row = localSnapshot(book, 'editor').accounts.find(a => a.id === 'bank').rows.find(r => r.id === original.id);
    assert.ok(row.reversalId);
    assert.equal(row.split, undefined);
  } finally { book.close(); }
});

test('cancellation validates author, all affected accounts, type, date and reason', () => {
  const book = setup();
  try {
    const original = expense(book);
    const input = cancellation(book, original);
    assert.throws(() => reverseManualTransaction(book, 'viewer', input), /cannot be reversed/);
    assert.throws(() => reverseManualTransaction(book, 'editor', { ...input, date: '2026-09-30' }), /precedes/);
    assert.throws(() => reverseManualTransaction(book, 'editor', { ...input, reason: ' ' }), /reason/);
    assert.throws(() => reverseManualTransaction(book, 'editor', { ...input, requestId: 'bad' }), /request ID/);
    const transfer = recordManual(book, 'editor', { requestId: randomUUID(), date: '2026-10-01', kind: 'transfer',
      accountId: 'bank', counterId: 'other', amountExpression: '100' }).entry;
    setMember(book, 'owner', 'editor', 'editor', ['bank']);
    assert.throws(() => manualReversalPreview(book, 'editor', transfer.id), /cannot be reversed/);
    reverseManualTransaction(book, 'owner', cancellation(book, transfer));
    const ownerEntry = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'income',
      accountId: 'bank', counterId: 'income', amountExpression: '100' }).entry;
    assert.throws(() => manualReversalPreview(book, 'editor', ownerEntry.id), /cannot be reversed/);
    book.record({ id: 'imported', date: '2026-10-01', kind: 'import', postings: original.postings });
    assert.throws(() => manualReversalPreview(book, 'owner', 'imported'), /cannot be reversed/);
  } finally { book.close(); }
});

test('locked cancellation dates are rejected but later reversal preserves the locked original period', () => {
  const book = setup();
  try {
    const original = expense(book);
    const row = accountRegister(book, 'owner', 'bank', '2026-10-01').rows[0];
    setTransactionChecked(book, 'owner', 'bank', original.id, true, row.confirmationHash);
    const preview = compareStatement(book, 'owner', 'bank', '2026-10-01', '-500');
    const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-01',
      statementExpression: '-500', expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    assert.throws(() => reverseManualTransaction(book, 'editor', cancellation(book, original)), /period is locked/);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM transaction_reversals').get().count, 0);
    reverseManualTransaction(book, 'editor', cancellation(book, original, '2026-10-02'));
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-10-01').balance, -500);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-10-02').balance, 0);
  } finally { book.close(); }
});

test('failure writing cancellation audit rolls back the reversal and budget effect', () => {
  const book = setup();
  try {
    const original = expense(book); const input = cancellation(book, original);
    book.db.exec(`CREATE TRIGGER fail_reversal BEFORE INSERT ON transaction_reversals BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
    assert.throws(() => reverseManualTransaction(book, 'editor', input), /audit failure/);
    assert.equal(book.entries().length, 1);
    assert.equal(book.budget('2026-10').categories.category.spent, 500);
    book.db.exec('DROP TRIGGER fail_reversal');
    assert.equal(reverseManualTransaction(book, 'editor', input).duplicate, false);
  } finally { book.close(); }
});

test('cancelled transactions release scheduled occurrence links and cannot be matched again', () => {
  const book = setup();
  try {
    const original = expense(book);
    const schedule = saveSchedule(book, 'owner', { accountId: 'bank', name: '생활비', amountExpression: '-500',
      startDate: '2026-10-01', frequency: 'once' });
    linkOccurrence(book, 'owner', { scheduleId: schedule.id, date: '2026-10-01', entryId: original.id });
    reverseManualTransaction(book, 'editor', cancellation(book, original));
    assert.equal(linkedOccurrences(book, 'owner').length, 0);
    assert.equal(matchingEntries(book, 'owner', schedule.id, '2026-10-01').length, 0);
    assert.throws(() => linkOccurrence(book, 'owner', { scheduleId: schedule.id, date: '2026-10-01', entryId: original.id }), /Reversed transaction/);
    const audit = manualReversalPreview(book, 'owner', original.id).reversal;
    assert.equal(audit.detachedScheduleLink.schedule_id, schedule.id);
  } finally { book.close(); }
});

test('cancellation HTTP enforces CSRF and permission and shows escaped audit and register markers', async () => {
  const book = setup(); const original = expense(book);
  const server = createImportApi(book, { auth: { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'editor', role: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/transactions/reverse`;
  const input = { ...cancellation(book, original), reason: '<script>취소</script>', csrf: 'token' };
  try {
    assert.equal((await fetch(`${base}?entryId=${original.id}`)).status, 200);
    assert.equal((await fetch(`${base}?entryId=${original.id}`, { headers: { Cookie: 'viewer=1' } })).status, 400);
    assert.equal((await fetch(base, { method: 'POST', body: new URLSearchParams({ ...input, csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(base, { method: 'POST', headers: { Cookie: 'viewer=1' }, body: new URLSearchParams(input) })).status, 400);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(base, { method: 'POST', body: new URLSearchParams(input) });
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /&lt;script&gt;취소&lt;\/script&gt;/);
      assert.ok(!html.includes('<script>취소</script>'));
    }
    const register = await (await fetch(base.replace('/transactions/reverse', '/register?accountId=bank'))).text();
    assert.match(register, /취소됨 \(원거래 보존\)/);
    assert.match(register, /취소 분개/);
    assert.equal(book.entries().length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
