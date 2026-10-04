import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual, accountRegister } from '../src/manual.js';
import { localSnapshot } from '../src/local-sync.js';
import { manualEditPreview, updateManualTransaction } from '../src/manual-edit.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['private', 'asset'], ['expense', 'expense'], ['equity', 'equity']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other', 'private']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, overrides = {}, sub = 'editor') => recordManual(book, sub, { requestId: randomUUID(),
  date: '2026-10-01', kind: 'expense', accountId: 'bank', counterId: 'expense',
  categoryId: 'food', amountExpression: '500', memo: '첫 입력', ...overrides }).entry;
const input = (book, entry, overrides = {}) => {
  const preview = manualEditPreview(book, 'editor', entry.id);
  return { ...preview.input, kind: 'manual-update', manualKind: preview.input.kind, entryId: entry.id,
    expectedHash: preview.expectedHash, requestId: randomUUID(), ...overrides };
};
async function api(book) {
  let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => sub ? ({ sub, role: sub, csrf: 'token' }) : null } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/local`;
  return { setSub: value => { sub = value; },
    send: (data, csrf = 'token') => fetch(`${base}/transactions`, { method: 'POST', headers: {
      'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify(data) }),
    close: () => new Promise(resolve => server.close(resolve)) };
}

test('snapshot provides scoped simple edit metadata only for editable source rows and omits opening and canceled entries', () => {
  const book = setup();
  try {
    const own = create(book); const foreign = create(book, {}, 'owner');
    const transfer = create(book, { kind: 'transfer', counterId: 'private', categoryId: null });
    const opening = create(book, { kind: 'opening', counterId: 'equity', categoryId: null }, 'owner');
    const canceled = create(book);
    reverseManualTransaction(book, 'owner', { entryId: canceled.id, date: '2026-10-02', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'owner', canceled.id).expectedHash, requestId: randomUUID() });
    const first = localSnapshot(book, 'editor').accounts.find(a => a.id === 'bank');
    assert.deepEqual(first.rows.find(row => row.id === own.id).manual, {
      expectedHash: manualEditPreview(book, 'editor', own.id).expectedHash,
      manualKind: 'expense', counterId: 'expense', amount: 500, categoryId: 'food' });
    assert.equal(first.rows.find(row => row.id === foreign.id).manual, undefined);
    assert.equal(first.rows.find(row => row.id === canceled.id).manual, undefined);
    assert.equal(localSnapshot(book, 'owner').accounts.find(a => a.id === 'bank').rows.find(row => row.id === opening.id).manual, undefined);
    assert.ok(localSnapshot(book, 'viewer').accounts[0].rows.every(row => !row.manual));
    setMember(book, 'owner', 'editor', 'editor', ['bank', 'other']);
    const scoped = localSnapshot(book, 'editor');
    assert.equal(scoped.accounts.find(a => a.id === 'bank').rows.find(row => row.id === transfer.id).manual, undefined);
    assert.ok(!JSON.stringify(scoped).includes('private'));
  } finally { book.close(); }
});

test('queued simple updates check fingerprints, budgets and confirmations and retry after a lost response without overwriting later work', async () => {
  const book = setup(); const original = create(book); const server = await api(book);
  try {
    const row = accountRegister(book, 'editor', 'bank', '2026-10-31').rows[0];
    setTransactionChecked(book, 'editor', 'bank', original.id, true, row.confirmationHash);
    const update = input(book, original, { date: '2026-11-01', amountExpression: '1000+250', memo: '오프라인 수정' });
    assert.equal((await server.send(update, 'bad')).status, 403);
    assert.equal((await server.send(update)).status, 201);
    const duplicate = await server.send(update); assert.equal(duplicate.status, 200);
    assert.deepEqual(await duplicate.json(), { id: original.id, duplicate: true });
    assert.equal(book.budget('2026-10').categories.food.spent, 0);
    assert.equal(book.budget('2026-11').categories.food.spent, 1250);
    assert.equal(accountRegister(book, 'editor', 'bank', '2026-11-30').rows[0].checked, false);
    assert.equal((await server.send({ ...update, requestId: randomUUID() })).status, 409);
    assert.equal((await server.send({ ...update, memo: '다른 요청' })).status, 400);
    assert.equal((await server.send(input(book, original, { amountExpression: '1500' }))).status, 201);
    assert.equal((await server.send(update)).status, 200);
    assert.equal(book.entries()[0].postings[0].amount, 1500);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 2);
    assert.equal(book.entries().length, 1);
  } finally { await server.close(); book.close(); }
});

test('local update endpoint enforces author and transfer rights, cancellation, fixed type and session', async () => {
  const book = setup(); const entry = create(book); const update = input(book, entry); const server = await api(book);
  try {
    server.setSub(null); assert.equal((await server.send(update)).status, 401);
    server.setSub('viewer'); assert.equal((await server.send(update)).status, 400);
    server.setSub('editor');
    assert.equal((await server.send({ ...update, manualKind: 'opening', counterId: 'equity' })).status, 400);
    assert.equal((await server.send({ ...update, manualKind: 'income' })).status, 400);
    assert.equal((await server.send({ ...update, requestId: null })).status, 400);
    const transfer = create(book, { kind: 'transfer', counterId: 'other', categoryId: null });
    const transferUpdate = input(book, transfer, { counterId: 'private' });
    setMember(book, 'owner', 'editor', 'editor', ['bank', 'other']);
    assert.equal((await server.send(transferUpdate)).status, 400);
    setMember(book, 'owner', 'editor', 'editor', ['bank']);
    assert.equal((await server.send({ ...transferUpdate, counterId: 'bank' })).status, 400);
    reverseManualTransaction(book, 'owner', { entryId: entry.id, date: '2026-10-02', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'owner', entry.id).expectedHash, requestId: randomUUID() });
    assert.equal((await server.send(update)).status, 400);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 0);
  } finally { await server.close(); book.close(); }
});

test('locked simple edits return 423 and omit edit metadata while accepted retries remain idempotent', async () => {
  const book = setup(); const entry = create(book); const server = await api(book);
  try {
    const accepted = input(book, entry, { amountExpression: '600' });
    assert.equal((await server.send(accepted)).status, 201);
    const blocked = input(book, entry, { date: '2026-11-01' });
    const row = accountRegister(book, 'owner', 'bank', '2026-10-01').rows[0];
    setTransactionChecked(book, 'owner', 'bank', row.id, true, row.confirmationHash);
    const preview = compareStatement(book, 'owner', 'bank', '2026-10-01', '-600');
    const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-01',
      statementExpression: '-600', expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    const response = await server.send(blocked); assert.equal(response.status, 423);
    assert.equal((await response.json()).code, 'PERIOD_LOCKED');
    assert.equal((await server.send(accepted)).status, 200);
    assert.equal(localSnapshot(book, 'editor').accounts.find(a => a.id === 'bank').rows[0].manual, undefined);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 1);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_update_requests').get().n, 1);
  } finally { await server.close(); book.close(); }
});
