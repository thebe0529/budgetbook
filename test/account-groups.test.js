import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createGroup, createLedgerAccount, renameGroup, moveAccountGroup, recordManual } from '../src/manual.js';
import { createImportApi } from '../src/import-api.js';

test('group changes preserve account identity, balances and budget settings', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const old = createGroup(book, 'owner', '은행', 'asset');
    const next = createGroup(book, 'owner', '저축', 'asset');
    const liability = createGroup(book, 'owner', '카드', 'liability');
    const bank = createLedgerAccount(book, 'owner', { name: '통장', type: 'asset',
      groupId: old.id, onBudget: true, cash: true });
    const income = createLedgerAccount(book, 'owner', { name: '급여', type: 'income' });
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-03', kind: 'income',
      accountId: bank.id, counterId: income.id, amountExpression: '10000' });
    const entries = book.entries();
    moveAccountGroup(book, 'owner', bank.id, next.id);
    renameGroup(book, 'owner', next.id, ' 생활비 통장 ');
    assert.deepEqual(book.accounts().get(bank.id), { ...bank, groupId: next.id });
    assert.equal(book.accountGroups().find(g => g.id === next.id).name, '생활비 통장');
    assert.throws(() => moveAccountGroup(book, 'owner', bank.id, liability.id), /mismatch/);
    assert.equal(book.accounts().get(bank.id).groupId, next.id);
    moveAccountGroup(book, 'owner', bank.id, null);
    assert.equal(book.accounts().get(bank.id).groupId, undefined);
    assert.deepEqual(book.entries(), entries);
    assert.equal(book.reports('2026-10-01', '2026-10-31').balanceSheet.accounts[bank.id], 10000);
    assert.throws(() => renameGroup(book, 'owner', next.id, ' '), /Invalid/);
  } finally { book.close(); }
});

test('group management requires owner and CSRF, including direct POST requests', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const group = createGroup(book, 'owner', '은행', 'asset');
  const bank = createLedgerAccount(book, 'owner', { name: '통장', type: 'asset' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'editor=1' ? 'editor' : 'owner',
    role: req.headers.cookie === 'editor=1' ? 'editor' : 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (route, body, cookie = '') => fetch(url + route, { method: 'POST',
    headers: { Cookie: cookie }, body: new URLSearchParams(body) });
  try {
    const move = { csrf: 'token', accountId: bank.id, groupId: group.id };
    assert.equal((await send('/admin/accounts/group', { ...move, csrf: 'bad' })).status, 403);
    assert.equal((await send('/admin/accounts/group', move, 'editor=1')).status, 400);
    assert.equal((await send('/admin/accounts/group', move)).status, 200);
    assert.equal((await send('/admin/groups/rename', { csrf: 'token', groupId: group.id,
      name: '이름 변경' }, 'editor=1')).status, 400);
    assert.equal(book.accountGroups()[0].name, '은행');
    assert.equal((await send('/admin/groups/rename', { csrf: 'token', groupId: group.id,
      name: '생활비' })).status, 200);
    assert.equal(book.accountGroups()[0].name, '생활비');
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
