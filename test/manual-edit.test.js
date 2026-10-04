import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual, accountRegister } from '../src/manual.js';
import { manualEditPreview, updateManualTransaction } from '../src/manual-edit.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { transactionHistory } from '../src/transaction-history.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['private', 'asset'], ['loan', 'liability'],
    ['expense', 'expense'], ['income', 'income'], ['equity', 'equity']]) {
    book.createAccount({ id, name: `<${id}>`, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '식비' });
  book.createBudgetCategory({ id: 'living', name: '생활비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other', 'loan']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
function create(book, overrides = {}, sub = 'editor') {
  return recordManual(book, sub, { requestId: randomUUID(), date: '2026-10-01', kind: 'expense',
    accountId: 'bank', counterId: 'expense', categoryId: 'food', amountExpression: '500', memo: '<점심>', ...overrides }).entry;
}
function edit(book, entryId, overrides = {}, sub = 'editor') {
  const preview = manualEditPreview(book, sub, entryId);
  return { ...preview.input, entryId, expectedHash: preview.expectedHash, updateRequestId: randomUUID(), ...overrides };
}
function lock(book, accountId, throughDate = '2026-10-31') {
  const register = accountRegister(book, 'owner', accountId, throughDate);
  for (const row of register.rows) setTransactionChecked(book, 'owner', accountId, row.id, true, row.confirmationHash);
  const compared = compareStatement(book, 'owner', accountId, throughDate, String(register.balance));
  const saved = saveStatementComparison(book, 'owner', { accountId, throughDate, statementExpression: String(register.balance),
    expectedHash: compared.stateHash, requestId: randomUUID() }).saved;
  completeStatementReview(book, 'owner', saved.id);
  lockAccountPeriod(book, 'owner', saved.id, randomUUID());
}
const count = (book, table) => book.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('simple edit moves budget spending between months and categories, preserves author and invalidates confirmation', () => {
  const book = setup();
  try {
    const original = create(book);
    const row = accountRegister(book, 'owner', 'bank', '2026-10-31').rows[0];
    setTransactionChecked(book, 'editor', 'bank', original.id, true, row.confirmationHash);
    const result = updateManualTransaction(book, 'owner', edit(book, original.id, {
      date: '2026-11-02', categoryId: 'living', amountExpression: '1000+500', memo: '수정' }, 'owner'));
    assert.equal(result.entry.createdBy, 'editor'); assert.equal(result.entry.revision, 2);
    assert.equal(result.entry.id, original.id); assert.equal(result.duplicate, false);
    assert.equal(book.entries().length, 1);
    assert.equal(book.budget('2026-10').categories.food.spent, 0);
    assert.equal(book.budget('2026-11').categories.living.spent, 1500);
    assert.equal(accountRegister(book, 'viewer', 'bank', '2026-10-31').balance, 0);
    const updated = accountRegister(book, 'viewer', 'bank', '2026-11-30');
    assert.equal(updated.balance, -1500); assert.equal(updated.rows[0].checked, false);
    const history = transactionHistory(book, 'viewer', 'bank', original.id);
    assert.deepEqual(history.versions.map(v => [v.actor, v.memo]), [['editor', '<점심>'], ['owner', '수정']]);
    assert.equal(history.versions[0].postings[0].amount, 500);
    assert.throws(() => setTransactionChecked(book, 'editor', 'bank', original.id, true, row.confirmationHash), /changed/);
  } finally { book.close(); }
});

test('edit retries never overwrite a later version and stale or invalid changes leave no audit writes', () => {
  const book = setup();
  try {
    const original = create(book); const input = edit(book, original.id, { amountExpression: '1000' });
    updateManualTransaction(book, 'editor', input);
    assert.equal(updateManualTransaction(book, 'editor', input).duplicate, true);
    updateManualTransaction(book, 'editor', edit(book, original.id, { amountExpression: '1500' }));
    const retry = updateManualTransaction(book, 'editor', input);
    assert.equal(retry.duplicate, true); assert.equal(retry.entry.postings[0].amount, 1500);
    assert.equal(count(book, 'entry_revisions'), 2); assert.equal(count(book, 'entry_update_requests'), 2);
    assert.throws(() => updateManualTransaction(book, 'editor', { ...input, memo: '다른 요청' }), /reused/);
    assert.throws(() => updateManualTransaction(book, 'owner', input), /reused/);
    assert.throws(() => updateManualTransaction(book, 'editor', { ...input, updateRequestId: randomUUID() }), /changed/);
    for (const bad of [{ kind: 'income' }, { accountId: 'other' }, { amountExpression: '0' },
      { amountExpression: '1/0' }, { categoryId: 'missing' }, { date: '2026-02-30' },
      { counterId: 'income' }, { updateRequestId: 'bad' }, { memo: 'x'.repeat(501) }]) {
      assert.throws(() => updateManualTransaction(book, 'editor', edit(book, original.id, bad)));
    }
    assert.equal(count(book, 'entry_revisions'), 2); assert.equal(count(book, 'entry_update_requests'), 2);
  } finally { book.close(); }
});

test('editing enforces author, original and replacement account rights and excludes reversed or nonmanual entries', () => {
  const book = setup();
  try {
    const owned = create(book, {}, 'owner');
    assert.throws(() => manualEditPreview(book, 'editor', owned.id), /cannot be edited/);
    assert.throws(() => manualEditPreview(book, 'viewer', owned.id), /cannot be edited/);
    const transfer = create(book, { kind: 'transfer', counterId: 'other', categoryId: null });
    const input = edit(book, transfer.id);
    assert.throws(() => updateManualTransaction(book, 'editor', { ...input, counterId: 'private' }), /destination access/);
    setMember(book, 'owner', 'editor', 'editor', ['bank', 'loan']);
    assert.throws(() => updateManualTransaction(book, 'editor', { ...input, counterId: 'loan' }), /cannot be edited/);
    updateManualTransaction(book, 'owner', edit(book, transfer.id, { counterId: 'loan' }, 'owner'));
    assert.equal(accountRegister(book, 'owner', 'other', '2026-10-31').balance, 0);
    assert.equal(accountRegister(book, 'owner', 'loan', '2026-10-31').balance, -500);
    const preview = manualReversalPreview(book, 'owner', transfer.id);
    reverseManualTransaction(book, 'owner', { entryId: transfer.id, date: '2026-10-02', reason: '오입력',
      expectedHash: preview.expectedHash, requestId: randomUUID() });
    assert.throws(() => manualEditPreview(book, 'owner', transfer.id), /cannot be edited/);
    book.record({ id: 'import', date: '2026-10-01', kind: 'import', postings: owned.postings });
    assert.throws(() => manualEditPreview(book, 'owner', 'import'), /cannot be edited/);
  } finally { book.close(); }
});

test('legacy entries infer type and income and liability opening edits retain correct posting directions', () => {
  const book = setup();
  try {
    const income = create(book, { kind: 'income', counterId: 'income', categoryId: null });
    const legacy = { ...income }; delete legacy.manualKind; delete legacy.revision;
    book.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify(legacy), income.id);
    assert.equal(manualEditPreview(book, 'editor', income.id).input.kind, 'income');
    const updated = updateManualTransaction(book, 'editor', edit(book, income.id, { amountExpression: '700' })).entry;
    assert.equal(updated.revision, 2); assert.equal(updated.postings[0].side, 'debit');
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-10-31').balance, 700);
    const opening = create(book, { kind: 'opening', accountId: 'loan', counterId: 'equity', categoryId: null }, 'owner');
    assert.throws(() => manualEditPreview(book, 'editor', opening.id), /cannot be edited/);
    updateManualTransaction(book, 'owner', edit(book, opening.id, { amountExpression: '800' }, 'owner'));
    assert.equal(accountRegister(book, 'owner', 'loan', '2026-10-31').balance, 800);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.result, 700);
  } finally { book.close(); }
});

test('old and new account period locks roll back edits, revisions and request receipts together', () => {
  for (const scenario of ['old-source', 'new-source', 'old-counter', 'new-counter']) {
    const book = setup();
    try {
      const isCounter = scenario.endsWith('counter');
      const original = create(book, { date: scenario === 'new-source' ? '2026-11-01' : '2026-10-01',
        ...(isCounter ? { kind: 'transfer', counterId: 'other', categoryId: null } : {}) });
      const input = edit(book, original.id, scenario === 'old-source' ? { date: '2026-11-01' } :
        scenario === 'new-source' ? { date: '2026-10-02' } :
        scenario === 'old-counter' ? { counterId: 'loan', date: '2026-11-01' } : { counterId: 'loan' });
      lock(book, isCounter ? scenario === 'new-counter' ? 'loan' : 'other' : 'bank');
      assert.throws(() => updateManualTransaction(book, 'editor', input), /period is locked/);
      assert.deepEqual(book.entries(), [original]);
      assert.equal(count(book, 'entry_revisions'), 0); assert.equal(count(book, 'entry_update_requests'), 0);
    } finally { book.close(); }
  }
});

test('HTTP simple editor preloads escaped data, requires CSRF and writer rights and rejects stale saves', async () => {
  const book = setup(); const original = create(book);
  let session = { sub: 'editor', role: 'editor', csrf: 'token' };
  const server = createImportApi(book, { auth: { session: () => session } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin`;
  const input = edit(book, original.id, { amountExpression: '600', memo: '수정 완료' });
  const post = values => fetch(`${base}/transactions/update`, { method: 'POST', body: new URLSearchParams({ csrf: 'token', ...values }) });
  try {
    const register = await (await fetch(`${base}/register?accountId=bank`)).text();
    assert.ok(register.includes(`/admin/transactions/edit?entryId=${encodeURIComponent(original.id)}`));
    const form = await (await fetch(`${base}/transactions/edit?entryId=${encodeURIComponent(original.id)}`)).text();
    assert.match(form, /value="&lt;점심&gt;"/); assert.match(form, /&lt;bank&gt;/);
    assert.match(form, /name="expectedHash"/); assert.match(form, /name="updateRequestId"/);
    assert.ok(!form.includes('&lt;private&gt;'));
    assert.equal((await post({ ...input, csrf: 'bad' })).status, 403);
    assert.equal((await post(input)).status, 200);
    assert.equal((await post(input)).status, 200);
    assert.equal((await post({ ...input, updateRequestId: randomUUID() })).status, 400);
    assert.equal(count(book, 'entry_revisions'), 1);
    session = { sub: 'viewer', role: 'viewer', csrf: 'token' };
    assert.equal((await post(input)).status, 400);
    assert.equal((await fetch(`${base}/transactions/edit?entryId=${encodeURIComponent(original.id)}`)).status, 400);
    session = null;
    assert.equal((await fetch(`${base}/transactions/edit?entryId=${encodeURIComponent(original.id)}`, { redirect: 'manual' })).status, 302);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
