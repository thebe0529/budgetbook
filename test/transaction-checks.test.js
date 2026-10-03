import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountRegister, createLedgerAccount, recordManual } from '../src/manual.js';
import { recordSplitManual, updateSplitManual } from '../src/split-manual.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset' });
  const other = createLedgerAccount(book, 'owner', { name: '다른 은행', type: 'asset' });
  const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
  return { book, bank, other, expense };
}

test('confirmation is per account, permission checked and does not change ledger', () => {
  const { book, bank, other } = setup();
  try {
    const { entry } = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01',
      kind: 'transfer', accountId: bank.id, counterId: other.id, amountExpression: '1000' });
    const hash = entryFingerprint(entry);
    assert.throws(() => setTransactionChecked(book, 'viewer', bank.id, entry.id, true, hash), /write access/);
    assert.throws(() => setTransactionChecked(book, 'editor', other.id, entry.id, true, hash), /write access/);
    for (let i = 0; i < 2; i++) setTransactionChecked(book, 'editor', bank.id, entry.id, true, hash);
    const register = accountRegister(book, 'owner', bank.id, '2026-10-31');
    assert.equal(register.checkedBalance, -1000);
    assert.equal(register.uncheckedCount, 0);
    assert.equal(accountRegister(book, 'owner', other.id, '2026-10-31').uncheckedCount, 1);
    assert.equal(book.entries().length, 1);
    assert.deepEqual(book.entries()[0], entry);
    setTransactionChecked(book, 'editor', bank.id, entry.id, false);
    assert.equal(accountRegister(book, 'owner', bank.id, '2026-10-31').uncheckedCount, 1);
  } finally { book.close(); }
});

test('editing confirmed entries invalidates confirmation and rejects stale pages', () => {
  const { book, bank, other, expense } = setup();
  try {
    const input = { requestId: randomUUID(), date: '2026-10-01', kind: 'expense',
      accountId: bank.id, lines: [{ counterId: expense.id, amountExpression: '500' },
        { counterId: expense.id, amountExpression: '500' }] };
    const { entry } = recordSplitManual(book, 'editor', input);
    const hash = entryFingerprint(entry);
    assert.throws(() => setTransactionChecked(book, 'owner', other.id, entry.id, true, hash), /not found/);
    setTransactionChecked(book, 'editor', bank.id, entry.id, true, hash);
    updateSplitManual(book, 'editor', entry.id, 1, { ...input,
      lines: [{ counterId: expense.id, amountExpression: '1000' },
        { counterId: expense.id, amountExpression: '1000' }] });
    const register = accountRegister(book, 'editor', bank.id, '2026-10-31');
    assert.equal(register.checkedBalance, 0);
    assert.equal(register.uncheckedCount, 1);
    assert.throws(() => setTransactionChecked(book, 'editor', bank.id, entry.id, true, hash), /changed/);
    setTransactionChecked(book, 'editor', bank.id, entry.id, true, register.rows[0].confirmationHash);
    assert.equal(accountRegister(book, 'editor', bank.id, '2026-10-31').checkedBalance, -2000);
  } finally { book.close(); }
});

test('confirmation HTTP endpoint enforces CSRF, permissions and renders status', async () => {
  const { book, bank, expense } = setup();
  const { entry } = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01',
    kind: 'expense', accountId: bank.id, counterId: expense.id, amountExpression: '1000' });
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/register/check`;
  const body = { csrf: 'token', accountId: bank.id, entryId: entry.id,
    expectedHash: entryFingerprint(entry), checked: 'true' };
  try {
    assert.equal((await fetch(url, { method: 'POST', body: new URLSearchParams({ ...body, csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(url, { method: 'POST', headers: { Cookie: 'viewer=1' }, body: new URLSearchParams(body) })).status, 400);
    const response = await fetch(url, { method: 'POST', body: new URLSearchParams(body) });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /확인 완료/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
