import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount } from '../src/manual.js';
import { createImportApi } from '../src/import-api.js';

test('local sync exposes scoped accounts and queues submit idempotently with session and CSRF', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '공유 은행', type: 'asset' });
  const privateBank = createLedgerAccount(book, 'owner', { name: '비공개 은행', type: 'asset' });
  const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  const auth = { session: req => req.headers.cookie === 'editor=1' ?
    { sub: 'editor', role: 'editor', csrf: 'token' } : null };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/api/v1/local/state`)).status, 401);
    const state = await (await fetch(`${url}/api/v1/local/state`, {
      headers: { Cookie: 'editor=1' },
    })).json();
    assert.deepEqual(state.accounts.map(a => a.name), ['공유 은행']);
    assert.ok(!state.counterpartAccounts.some(a => a.id === privateBank.id));
    assert.equal(state.csrf, 'token');
    const body = { requestId: randomUUID(), date: '2026-10-10', kind: 'expense',
      accountId: bank.id, counterId: expense.id, amountExpression: '1000+250', memo: '점심' };
    const send = (data, csrf = 'token') => fetch(`${url}/api/v1/local/transactions`, {
      method: 'POST', headers: { Cookie: 'editor=1', 'Content-Type': 'application/json',
        'X-CSRF-Token': csrf }, body: JSON.stringify(data),
    });
    assert.equal((await send(body, 'wrong')).status, 403);
    assert.equal((await send({ ...body, accountId: privateBank.id })).status, 400);
    const first = await send(body);
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { id: `manual:${body.requestId}`, duplicate: false });
    const duplicate = await send(body);
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    assert.equal((await send({ ...body, amountExpression: '2000' })).status, 400);
    assert.equal(book.entries().length, 1);
    assert.equal((await (await fetch(`${url}/api/v1/local/state`, {
      headers: { Cookie: 'editor=1' },
    })).json()).accounts[0].balance, -1250);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('PWA shell and worker are public but never return account data or cache API requests', async () => {
  const book = new Book();
  const server = createImportApi(book);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const shell = await fetch(`${url}/app/`);
    assert.equal(shell.status, 200);
    assert.match(await shell.text(), /BudgetBook 거래 입력/);
    for (const asset of ['app.js', 'sw.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png']) {
      assert.equal((await fetch(`${url}/app/${asset}`)).status, 200);
    }
    const worker = await (await fetch(`${url}/app/sw.js`)).text();
    assert.match(worker, /FILES\.includes\(url\.pathname\)/);
    assert.doesNotMatch(worker, /api\/v1\/local/);
    assert.equal((await fetch(`${url}/api/v1/local/state`)).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('queued split transaction is validated and posted atomically with budget allocations', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '공유 통장', type: 'asset', onBudget: true });
  const privateBank = createLedgerAccount(book, 'owner', { name: '비공개 통장', type: 'asset' });
  const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  const category = book.createBudgetCategory({ id: randomUUID(), name: '식비 예산' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  const auth = { session: () => ({ sub: 'editor', role: 'editor', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const submit = data => fetch(`${url}/api/v1/local/transactions`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': 'token' },
    body: JSON.stringify(data),
  });
  try {
    const data = { requestId: randomUUID(), date: '2026-10-20', kind: 'split',
      splitKind: 'expense', accountId: bank.id, memo: '장보기', lines: [
        { counterId: food.id, amountExpression: '1000+250', categoryId: category.id },
        { counterId: food.id, amountExpression: '750', categoryId: category.id },
      ] };
    assert.equal((await submit({ ...data, lines: [...data.lines,
      { counterId: food.id, amountExpression: '100', categoryId: null }] })).status, 400);
    assert.equal(book.entries().length, 0);
    const first = await submit(data);
    assert.equal(first.status, 201);
    assert.deepEqual(await first.json(), { id: `manual:${data.requestId}`, duplicate: false });
    assert.equal((await submit(data)).status, 200);
    assert.equal(book.entries().length, 1);
    assert.equal(book.budget('2026-10').categories[category.id].spent, 2000);
    const transfer = { ...data, requestId: randomUUID(), splitKind: 'transfer', lines: [
      { counterId: privateBank.id, amountExpression: '100' },
      { counterId: privateBank.id, amountExpression: '100' },
    ] };
    assert.equal((await submit(transfer)).status, 400);
    assert.equal(book.entries().length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
