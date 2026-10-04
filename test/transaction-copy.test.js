import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual, accountRegister } from '../src/manual.js';
import { recordSplitManual } from '../src/split-manual.js';
import { transactionCopyPreview } from '../src/transaction-copy.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['other', 'asset'], ['private', 'asset'],
    ['expense', 'expense'], ['income', 'income'], ['equity', 'equity']]) {
    book.createAccount({ id, name: `<${id}>`, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '<식비>' });
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'other']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, overrides = {}) => recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01',
  kind: 'expense', accountId: 'bank', counterId: 'expense', categoryId: 'food', amountExpression: '500', memo: '<원거래>', ...overrides }).entry;
async function api(book) {
  let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => sub ? { sub, role: sub, csrf: 'token' } : null } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, setSub: value => { sub = value; }, copy: id => fetch(`${base}/admin/transactions/copy?entryId=${encodeURIComponent(id)}`),
    send: (path, values) => fetch(`${base}${path}`, { method: 'POST', body: values }),
    close: () => new Promise(resolve => server.close(resolve)) };
}
const hidden = (html, name) => html.match(new RegExp(`name="${name}" value="([^"]*)"`))[1];
function confirm(book, accountId, entryId) {
  const row = accountRegister(book, 'owner', accountId, '2026-10-31').rows.find(row => row.id === entryId);
  setTransactionChecked(book, 'owner', accountId, row.id, true, row.confirmationHash);
}

test('copy preview is a fresh dated draft for another author and preserves legacy, income, transfer and split values', () => {
  const book = setup();
  try {
    const expense = create(book); const legacy = { ...expense }; delete legacy.manualKind;
    book.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify(legacy), expense.id);
    const before = book.entries(); const preview = transactionCopyPreview(book, 'editor', expense.id);
    assert.equal(preview.input.kind, 'expense'); assert.equal(preview.input.amountExpression, '500');
    assert.equal(preview.input.categoryId, 'food'); assert.equal(preview.input.memo, '<원거래>');
    assert.equal(preview.input.date, new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }));
    assert.equal(preview.input.requestId, undefined); assert.equal(preview.input.entryId, undefined);
    preview.input.memo = '초안 변경'; assert.deepEqual(book.entries(), before);
    const income = create(book, { kind: 'income', counterId: 'income', categoryId: null });
    assert.equal(transactionCopyPreview(book, 'editor', income.id).input.kind, 'income');
    const transfer = create(book, { kind: 'transfer', counterId: 'other', categoryId: null });
    assert.equal(transactionCopyPreview(book, 'editor', transfer.id).input.counterId, 'other');
    const split = recordSplitManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'expense',
      accountId: 'bank', memo: '분할', lines: [{ counterId: 'expense', amountExpression: '100', categoryId: 'food' },
        { counterId: 'expense', amountExpression: '200', categoryId: 'food' }] }).entry;
    assert.deepEqual(transactionCopyPreview(book, 'editor', split.id).input.lines, [
      { counterId: 'expense', amountExpression: '100', categoryId: 'food' },
      { counterId: 'expense', amountExpression: '200', categoryId: 'food' }]);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 0);
  } finally { book.close(); }
});

test('copy preview denies private counterpart accounts, viewers, opening balances, canceled and external entries', () => {
  const book = setup();
  try {
    const expense = create(book);
    assert.throws(() => transactionCopyPreview(book, 'viewer', expense.id), /cannot be copied/);
    assert.throws(() => transactionCopyPreview(book, 'unknown', expense.id), /cannot be copied/);
    assert.throws(() => transactionCopyPreview(book, 'owner', 'missing'), /cannot be copied/);
    const transfer = create(book, { kind: 'transfer', counterId: 'private', categoryId: null });
    assert.throws(() => transactionCopyPreview(book, 'editor', transfer.id), /cannot be copied/);
    const split = recordSplitManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'transfer',
      accountId: 'bank', lines: [{ counterId: 'other', amountExpression: '100' }, { counterId: 'private', amountExpression: '200' }] }).entry;
    assert.throws(() => transactionCopyPreview(book, 'editor', split.id), /cannot be copied/);
    const opening = create(book, { kind: 'opening', counterId: 'equity', categoryId: null });
    assert.throws(() => transactionCopyPreview(book, 'owner', opening.id), /cannot be copied/);
    const reversal = reverseManualTransaction(book, 'owner', { entryId: expense.id, date: '2026-10-02', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'owner', expense.id).expectedHash, requestId: randomUUID() }).entry;
    assert.throws(() => transactionCopyPreview(book, 'owner', expense.id), /cannot be copied/);
    assert.throws(() => transactionCopyPreview(book, 'owner', reversal.id), /cannot be copied/);
    book.record({ id: 'import', date: '2026-10-01', kind: 'import', postings: expense.postings });
    assert.throws(() => transactionCopyPreview(book, 'owner', 'import'), /cannot be copied/);
  } finally { book.close(); }
});

test('simple copy form creates a new idempotent transaction and keeps original author, data and confirmation', async () => {
  const book = setup(); const original = create(book); confirm(book, 'bank', original.id); const server = await api(book);
  try {
    const register = await (await fetch(`${server.base}/admin/register?accountId=bank`)).text();
    assert.ok(register.includes(`/admin/transactions/copy?entryId=${encodeURIComponent(original.id)}`));
    const response = await server.copy(original.id); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /단순 거래 복사/); assert.match(html, /새 거래로 저장/);
    assert.match(html, /value="&lt;원거래&gt;"/); assert.match(html, /value="500"/);
    assert.match(html, /value="food" selected/); assert.match(html, /action="\/admin\/transactions"/);
    const form = html.match(/<form[\s\S]*?<\/form>/)[0];
    assert.ok(!form.includes('name="entryId"')); assert.ok(!form.includes('name="expectedHash"'));
    assert.equal(book.entries().length, 1);
    const requestId = hidden(html, 'requestId');
    assert.notEqual(hidden(await (await server.copy(original.id)).text(), 'requestId'), requestId);
    const values = new URLSearchParams({ csrf: 'bad', requestId, accountId: hidden(html, 'accountId'),
      kind: hidden(html, 'kind'), counterId: 'expense', categoryId: 'food', date: '2026-11-01', amountExpression: '1000+250', memo: '복사 수정' });
    assert.equal((await server.send('/admin/transactions', values)).status, 403);
    values.set('csrf', 'token');
    assert.equal((await server.send('/admin/transactions', values)).status, 200);
    assert.equal((await server.send('/admin/transactions', values)).status, 200);
    const copied = book.entries().find(entry => entry.id !== original.id);
    assert.equal(copied.createdBy, 'editor'); assert.equal(copied.revision, 1); assert.equal(copied.memo, '복사 수정');
    assert.equal(copied.postings[0].amount, 1250); assert.equal(book.entries().length, 2);
    assert.deepEqual(book.entries().find(entry => entry.id === original.id), original);
    const rows = accountRegister(book, 'owner', 'bank', '2026-11-30').rows;
    assert.equal(rows.find(row => row.id === original.id).checked, true);
    assert.equal(rows.find(row => row.id === copied.id).checked, false);
    assert.equal(book.budget('2026-10').categories.food.spent, 500);
    assert.equal(book.budget('2026-11').categories.food.spent, 1250);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 0);
    server.setSub('viewer'); assert.equal((await server.copy(original.id)).status, 400);
    server.setSub(null);
    const unauthenticated = await fetch(`${server.base}/admin/transactions/copy?entryId=${encodeURIComponent(original.id)}`, { redirect: 'manual' });
    assert.equal(unauthenticated.status, 302);
  } finally { await server.close(); book.close(); }
});

test('split copy preloads all rows and saves edited amounts once without changing its confirmed original', async () => {
  const book = setup();
  const original = recordSplitManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'expense',
    accountId: 'bank', memo: '<분할>', lines: [{ counterId: 'expense', amountExpression: '100', categoryId: 'food' },
      { counterId: 'expense', amountExpression: '200', categoryId: 'food' }] }).entry;
  confirm(book, 'bank', original.id); const server = await api(book);
  try {
    const html = await (await server.copy(original.id)).text();
    assert.match(html, /분할 거래 복사/); assert.match(html, /action="\/admin\/split"/);
    assert.match(html, /name="lineAmount" value="100"/); assert.match(html, /name="lineAmount" value="200"/);
    assert.match(html, /value="&lt;분할&gt;"/); assert.match(html, /새 분할 거래로 저장/);
    assert.ok(!html.includes('name="entryId"')); assert.ok(!html.includes('name="revision"'));
    const values = new URLSearchParams({ csrf: 'token', requestId: hidden(html, 'requestId'), accountId: 'bank',
      kind: 'expense', date: '2026-11-01', memo: '새 분할' });
    for (const amount of ['400+100', '750']) {
      values.append('counterId', 'expense'); values.append('lineAmount', amount); values.append('lineCategory', 'food');
    }
    assert.equal((await server.send('/admin/split', values)).status, 200);
    assert.equal((await server.send('/admin/split', values)).status, 200);
    assert.equal(book.entries().length, 2);
    const copied = book.entries().find(entry => entry.id !== original.id);
    assert.equal(copied.kind, 'manual-split'); assert.equal(copied.createdBy, 'editor'); assert.equal(copied.revision, 1);
    assert.deepEqual(copied.budgetAllocations.map(a => a.amount), [500, 750]);
    assert.deepEqual(book.entries().find(entry => entry.id === original.id), original);
    assert.equal(accountRegister(book, 'owner', 'bank', '2026-11-30').rows.find(row => row.id === original.id).checked, true);
    assert.equal(book.budget('2026-11').categories.food.spent, 1250);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 0);
  } finally { await server.close(); book.close(); }
});

test('copies may read a locked original but new saves enforce their own period and current transfer permissions', async () => {
  const book = setup(); const original = create(book); confirm(book, 'bank', original.id);
  const compared = compareStatement(book, 'owner', 'bank', '2026-10-31', '-500');
  const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-31',
    statementExpression: '-500', expectedHash: compared.stateHash, requestId: randomUUID() }).saved;
  completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
  const server = await api(book);
  try {
    const html = await (await server.copy(original.id)).text(); assert.match(html, /새 거래로 저장/);
    const values = new URLSearchParams({ csrf: 'token', requestId: hidden(html, 'requestId'), accountId: 'bank',
      kind: 'expense', counterId: 'expense', amountExpression: '500', categoryId: 'food', date: '2026-10-02' });
    assert.equal((await server.send('/admin/transactions', values)).status, 400);
    assert.equal(book.entries().length, 1);
    values.set('date', '2026-11-01'); assert.equal((await server.send('/admin/transactions', values)).status, 200);
    const transfer = create(book, { kind: 'transfer', counterId: 'other', categoryId: null, date: '2026-11-02' });
    const transferForm = await (await server.copy(transfer.id)).text();
    const transferred = new URLSearchParams({ csrf: 'token', requestId: hidden(transferForm, 'requestId'), accountId: 'bank',
      kind: 'transfer', counterId: 'other', amountExpression: '500', date: '2026-11-03' });
    setMember(book, 'owner', 'editor', 'editor', ['bank']);
    assert.equal((await server.send('/admin/transactions', transferred)).status, 400);
    const denied = await server.copy(transfer.id); assert.equal(denied.status, 400);
    assert.ok(!(await denied.text()).includes('&lt;other&gt;'));
    assert.equal(book.entries().length, 3);
    assert.deepEqual(book.entries().find(entry => entry.id === original.id), original);
  } finally { await server.close(); book.close(); }
});
