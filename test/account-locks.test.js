import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountRegister, recordManual } from '../src/manual.js';
import { recordSplitManual, updateSplitManual } from '../src/split-manual.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, completeStatementReview, saveStatementComparison } from '../src/statement-comparison.js';
import { accountPeriodLock, accountLockHistory, lockAccountPeriod, unlockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';
import { recordAdjustment } from '../src/adjustments.js';

function setup(filename) {
  const book = new Book(filename);
  ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['equity', 'equity'], ['expense', 'expense'], ['card', 'liability']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank', cash: id === 'bank', card: id === 'card' });
  }
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  book.record(entry('opening', '2026-10-01', 'bank', 'equity', 10000));
  return book;
}

function entry(id, date, debit = 'expense', credit = 'bank', amount = 100) {
  return { id, date, postings: [{ accountId: debit, side: 'debit', amount }, { accountId: credit, side: 'credit', amount }] };
}

function ready(book, throughDate = '2026-10-01', complete = true) {
  const register = accountRegister(book, 'owner', 'bank', throughDate);
  for (const row of register.rows) setTransactionChecked(book, 'owner', 'bank', row.id, true, row.confirmationHash);
  const preview = compareStatement(book, 'owner', 'bank', throughDate, String(register.balance));
  const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate,
    statementExpression: String(register.balance), expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
  if (complete) completeStatementReview(book, 'owner', saved.id);
  return saved;
}

test('period locking requires owner, completed current review and rejects older cutoffs', () => {
  const book = setup();
  try {
    const saved = ready(book, '2026-10-01', false);
    assert.throws(() => lockAccountPeriod(book, 'editor', saved.id, randomUUID()), /Owner/);
    assert.throws(() => lockAccountPeriod(book, 'owner', saved.id, 'bad'), /request ID/);
    assert.throws(() => lockAccountPeriod(book, 'owner', saved.id, randomUUID()), /Completed review/);
    completeStatementReview(book, 'owner', saved.id);
    book.record(entry('backdated', '2026-10-01'));
    assert.throws(() => lockAccountPeriod(book, 'owner', saved.id, randomUUID()), /changed/);
    const latest = ready(book);
    const requestId = randomUUID();
    assert.equal(lockAccountPeriod(book, 'owner', latest.id, requestId).duplicate, false);
    assert.equal(lockAccountPeriod(book, 'owner', latest.id, requestId).duplicate, true);
    assert.throws(() => lockAccountPeriod(book, 'owner', saved.id, requestId), /reused/);
    assert.throws(() => lockAccountPeriod(book, 'owner', latest.id, randomUUID()), /later lock/);
    assert.equal(accountLockHistory(book, 'viewer', 'bank').length, 1);
    assert.throws(() => accountPeriodLock(book, 'viewer', 'other'), /read access/);
  } finally { book.close(); }
});

test('database guards inserts, old and new update dates, counterpart accounts and deletion', () => {
  const book = setup();
  try {
    lockAccountPeriod(book, 'owner', ready(book).id, randomUUID());
    for (const date of ['2026-09-30', '2026-10-01']) assert.throws(() => book.record(entry(randomUUID(), date)), /period is locked/);
    assert.throws(() => book.record(entry('transfer', '2026-10-01', 'bank', 'other')), /period is locked/);
    book.record(entry('future', '2026-10-02'));
    book.record(entry('unrelated', '2026-10-01', 'expense', 'other'));
    const moveOpening = entry('opening', '2026-10-02', 'bank', 'equity', 10000);
    assert.throws(() => book.db.prepare('UPDATE entries SET date = ?, data = ? WHERE id = ?')
      .run(moveOpening.date, JSON.stringify(moveOpening), 'opening'), /period is locked/);
    const moveFuture = entry('future', '2026-10-01');
    assert.throws(() => book.db.prepare('UPDATE entries SET date = ?, data = ? WHERE id = ?')
      .run(moveFuture.date, JSON.stringify(moveFuture), 'future'), /period is locked/);
    assert.throws(() => book.db.prepare('DELETE FROM entries WHERE id = ?').run('opening'), /period is locked/);
    assert.throws(() => book.db.prepare('DELETE FROM account_entry_checks WHERE entry_id = ?').run('opening'), /period is locked/);
    assert.throws(() => book.db.prepare('UPDATE account_entry_checks SET entry_hash = ? WHERE entry_id = ?').run('bad', 'opening'), /period is locked/);
    assert.throws(() => setTransactionChecked(book, 'owner', 'bank', 'opening', false), /period is locked/);
    const row = accountRegister(book, 'owner', 'bank', '2026-10-01').rows[0];
    setTransactionChecked(book, 'owner', 'bank', row.id, true, row.confirmationHash);
    assert.equal(book.entries().length, 3);
  } finally { book.close(); }
});

test('a mixed adjustment batch rolls back unrelated rows when a locked account is encountered', () => {
  const book = setup();
  try {
    lockAccountPeriod(book, 'owner', ready(book).id, randomUUID());
    assert.throws(() => recordAdjustment(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', reason: '조정', rows: [
      { debitId: 'expense', creditId: 'other', amountExpression: '100' },
      { debitId: 'expense', creditId: 'bank', amountExpression: '100' }] }), /period is locked/);
    assert.equal(book.entries().length, 1);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM adjustment_batches').get().count, 0);
  } finally { book.close(); }
});

test('locked split edits roll back revision audit and locked card payments roll back installment state', () => {
  const book = setup();
  try {
    const input = { requestId: randomUUID(), date: '2026-10-01', kind: 'expense', accountId: 'bank',
      lines: [{ counterId: 'expense', amountExpression: '100' }, { counterId: 'expense', amountExpression: '200' }] };
    const split = recordSplitManual(book, 'owner', input).entry;
    const future = recordSplitManual(book, 'owner', { ...input, requestId: randomUUID(), date: '2026-10-02' }).entry;
    book.cardPurchase({ id: 'purchase', date: '2026-09-30', cardId: 'card', expenseId: 'expense',
      amount: 600, count: 2, firstDueDate: '2026-10-01' });
    lockAccountPeriod(book, 'owner', ready(book).id, randomUUID());
    assert.throws(() => updateSplitManual(book, 'owner', split.id, 1, { ...input, requestId: randomUUID(), date: '2026-10-02' }), /period is locked/);
    assert.throws(() => updateSplitManual(book, 'owner', future.id, 1, { ...input, requestId: randomUUID() }), /period is locked/);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM entry_revisions').get().count, 0);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM entry_update_requests').get().count, 0);
    assert.throws(() => book.payInstallment({ planId: 'purchase', index: 1, date: '2026-10-01', cashId: 'bank' }), /period is locked/);
    assert.equal(book.pendingCardPayments('2026-12-31').length, 2);
    book.payInstallment({ planId: 'purchase', index: 1, date: '2026-10-02', cashId: 'bank' });
    assert.equal(book.pendingCardPayments('2026-12-31').length, 1);
  } finally { book.close(); }
});

test('unlock is audited, atomic and idempotent and cannot remove a newer lock', () => {
  const book = setup();
  try {
    const first = lockAccountPeriod(book, 'owner', ready(book).id, randomUUID()).lock;
    const unlock = { accountId: 'bank', expectedLockId: first.id, reason: '누락 거래 수정', requestId: randomUUID() };
    assert.throws(() => unlockAccountPeriod(book, 'editor', unlock), /Owner/);
    assert.throws(() => unlockAccountPeriod(book, 'owner', { ...unlock, reason: ' ' }), /reason/);
    book.db.exec(`CREATE TRIGGER fail_unlock_audit BEFORE INSERT ON account_lock_events
      WHEN json_extract(NEW.data, '$.action') = 'unlock' BEGIN SELECT RAISE(ABORT, 'audit failure'); END;`);
    assert.throws(() => unlockAccountPeriod(book, 'owner', unlock), /audit failure/);
    assert.equal(accountPeriodLock(book, 'owner', 'bank').id, first.id);
    book.db.exec('DROP TRIGGER fail_unlock_audit');
    assert.equal(unlockAccountPeriod(book, 'owner', unlock).duplicate, false);
    assert.equal(accountPeriodLock(book, 'owner', 'bank'), null);
    book.record(entry('fixed', '2026-10-01'));
    const second = lockAccountPeriod(book, 'owner', ready(book).id, randomUUID()).lock;
    assert.equal(unlockAccountPeriod(book, 'owner', unlock).duplicate, true);
    assert.equal(accountPeriodLock(book, 'owner', 'bank').id, second.id);
    assert.throws(() => unlockAccountPeriod(book, 'owner', { ...unlock, requestId: randomUUID() }), /Lock changed/);
    assert.throws(() => unlockAccountPeriod(book, 'owner', { ...unlock, reason: '다른 사유' }), /reused/);
    const third = lockAccountPeriod(book, 'owner', ready(book, '2026-10-02').id, randomUUID()).lock;
    assert.equal(third.throughDate, '2026-10-02');
    assert.throws(() => unlockAccountPeriod(book, 'owner', { ...unlock, expectedLockId: second.id, requestId: randomUUID() }), /Lock changed/);
    assert.equal(accountLockHistory(book, 'owner', 'bank').length, 4);
  } finally { book.close(); }
});

test('period locks and database guards survive reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'period-lock-'));
  const filename = join(directory, 'book.sqlite');
  let book = setup(filename);
  try {
    const lock = lockAccountPeriod(book, 'owner', ready(book).id, randomUUID()).lock;
    book.close(); book = new Book(filename);
    assert.equal(accountPeriodLock(book, 'owner', 'bank').id, lock.id);
    assert.throws(() => book.record(entry('blocked', '2026-10-01')), /period is locked/);
    assert.equal(accountLockHistory(book, 'owner', 'bank').length, 1);
  } finally { book.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('lock and unlock HTTP enforce owner and CSRF and show status and escaped audit reason', async () => {
  const book = setup();
  const saved = ready(book);
  const server = createImportApi(book, { auth: { session: req => {
    const sub = req.headers.cookie === 'editor=1' ? 'editor' : 'owner';
    return { sub, role: sub, csrf: 'token' };
  } } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/balance-check`;
  const body = { comparisonId: saved.id, requestId: randomUUID(), csrf: 'token' };
  try {
    assert.equal((await fetch(`${base}/lock`, { method: 'POST', body: new URLSearchParams({ ...body, csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(`${base}/lock`, { method: 'POST', headers: { Cookie: 'editor=1' }, body: new URLSearchParams(body) })).status, 400);
    const locked = await fetch(`${base}/lock`, { method: 'POST', body: new URLSearchParams(body) });
    assert.equal(locked.status, 200);
    assert.match(await locked.text(), /2026-10-01까지 거래 추가/);
    const register = await (await fetch(base.replace('/balance-check', '/register?accountId=bank'))).text();
    assert.match(register, /기간이 잠겨 있습니다/);
    const denied = await fetch(base.replace('/balance-check', '/transactions'), { method: 'POST', body: new URLSearchParams({
      csrf: 'token', requestId: randomUUID(), accountId: 'bank', counterId: 'expense', kind: 'expense',
      date: '2026-10-01', amountExpression: '100' }) });
    assert.equal(denied.status, 400);
    const unlock = { csrf: 'token', accountId: 'bank', expectedLockId: body.requestId,
      requestId: randomUUID(), reason: '<script>수정</script>' };
    assert.equal((await fetch(`${base}/unlock`, { method: 'POST', body: new URLSearchParams({ ...unlock, csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(`${base}/unlock`, { method: 'POST', headers: { Cookie: 'editor=1' }, body: new URLSearchParams(unlock) })).status, 400);
    const released = await fetch(`${base}/unlock`, { method: 'POST', body: new URLSearchParams(unlock) });
    assert.equal(released.status, 200);
    const html = await released.text();
    assert.match(html, /&lt;script&gt;수정&lt;\/script&gt;/);
    assert.ok(!html.includes('<script>수정</script>'));
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
