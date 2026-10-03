import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount } from '../src/manual.js';
import { createImportApi } from '../src/import-api.js';
import { accountRegister } from '../src/manual.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';

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
    for (const asset of ['app.js', 'local-policy.js', 'sw.js', 'manifest.json', 'icon.svg', 'icon-192.png', 'icon-512.png']) {
      assert.equal((await fetch(`${url}/app/${asset}`)).status, 200);
    }
    const worker = await (await fetch(`${url}/app/sw.js`)).text();
    assert.match(worker, /FILES\.includes\(url\.pathname\)/);
    assert.doesNotMatch(worker, /api\/v1\/local/);
    assert.equal((await fetch(`${url}/api/v1/local/state`)).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('local snapshot exposes scoped locks and locked writes return 423 while accepted retries remain safe', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '공유 은행', type: 'asset' });
  const other = createLedgerAccount(book, 'owner', { name: '이체 은행', type: 'asset' });
  const hidden = createLedgerAccount(book, 'owner', { name: '비공개 은행', type: 'asset' });
  const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id, other.id]);
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'editor', role: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/api/v1/local`;
  const send = data => fetch(`${base}/transactions`, { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-CSRF-Token': 'token' }, body: JSON.stringify(data) });
  try {
    const split = { requestId: randomUUID(), date: '2026-10-01', kind: 'split', splitKind: 'expense',
      accountId: bank.id, lines: [{ counterId: expense.id, amountExpression: '100' }, { counterId: expense.id, amountExpression: '200' }] };
    assert.equal((await send(split)).status, 201);
    const row = accountRegister(book, 'owner', bank.id, '2026-10-01').rows[0];
    setTransactionChecked(book, 'owner', bank.id, row.id, true, row.confirmationHash);
    const preview = compareStatement(book, 'owner', bank.id, '2026-10-01', '-300');
    const saved = saveStatementComparison(book, 'owner', { accountId: bank.id, throughDate: '2026-10-01',
      statementExpression: '-300', expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id);
    lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    const state = await (await fetch(`${base}/state`)).json();
    const locked = state.accounts.find(a => a.id === bank.id);
    assert.equal(locked.lockedThroughDate, '2026-10-01');
    assert.equal(locked.rows[0].locked, true);
    assert.equal(locked.rows[0].split, undefined);
    assert.equal(state.counterpartAccounts.find(a => a.id === bank.id).lockedThroughDate, '2026-10-01');
    assert.ok(!state.accounts.some(a => a.id === hidden.id));
    assert.ok(!state.counterpartAccounts.some(a => a.id === hidden.id));
    assert.equal((await send(split)).status, 200);
    const expenseInput = { requestId: randomUUID(), kind: 'expense', date: '2026-10-01',
      accountId: bank.id, counterId: expense.id, amountExpression: '100' };
    const blocked = await send(expenseInput);
    assert.equal(blocked.status, 423);
    assert.equal((await blocked.json()).code, 'PERIOD_LOCKED');
    assert.equal((await send({ ...split, requestId: randomUUID(), kind: 'split-update', entryId: row.id,
      expectedRevision: 1, date: '2026-10-02' })).status, 423);
    assert.equal((await send({ ...expenseInput, requestId: randomUUID(), kind: 'transfer', accountId: other.id, counterId: bank.id })).status, 423);
    assert.equal(book.entries().length, 1);
    assert.equal((await send({ ...expenseInput, requestId: randomUUID(), date: '2026-10-02' })).status, 201);
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

test('offline split edits use optimistic revision and retry safely after a lost response', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '공유 통장', type: 'asset', onBudget: true });
  const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  const hidden = createLedgerAccount(book, 'owner', { name: '개인 통장', type: 'asset' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
  const auth = { session: req => {
    const sub = req.headers.cookie === 'viewer=1' ? 'viewer' : 'editor';
    return { sub, role: sub, csrf: 'token' };
  } };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (body, cookie = '') => fetch(`${url}/api/v1/local/transactions`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json',
      'X-CSRF-Token': 'token' }, body: JSON.stringify(body),
  });
  try {
    const initial = { requestId: randomUUID(), date: '2026-10-21', kind: 'split', splitKind: 'expense',
      accountId: bank.id, memo: '처음', lines: [
        { counterId: food.id, amountExpression: '1000' },
        { counterId: food.id, amountExpression: '2000' },
      ] };
    assert.equal((await send(initial)).status, 201);
    const read = await (await fetch(`${url}/api/v1/local/state`)).json();
    assert.equal(read.accounts.length, 1);
    assert.equal(read.accounts[0].rows[0].split.revision, 1);
    assert.deepEqual(read.accounts[0].rows[0].split.lines.map(l => l.amount), [1000, 2000]);
    const viewerRead = await (await fetch(`${url}/api/v1/local/state`, {
      headers: { Cookie: 'viewer=1' },
    })).json();
    assert.equal(viewerRead.accounts[0].rows[0].split, undefined);
    assert.ok(!read.accounts.some(a => a.id === hidden.id));
    const update = { ...initial, requestId: randomUUID(), kind: 'split-update',
      entryId: `manual:${initial.requestId}`, expectedRevision: 1, memo: '수정',
      lines: [{ counterId: food.id, amountExpression: '500' },
        { counterId: food.id, amountExpression: '750' }] };
    assert.equal((await send({ ...update, requestId: null })).status, 400);
    assert.equal((await send(update, 'viewer=1')).status, 400);
    assert.equal((await send(update)).status, 201);
    const retry = await send(update);
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).duplicate, true);
    assert.equal((await send({ ...update, memo: '다른 내용' })).status, 400);
    assert.equal((await send({ ...update, requestId: randomUUID(), expectedRevision: 1 })).status, 409);
    assert.equal(book.entries().length, 1);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM entry_revisions').get().n, 1);
    assert.equal((await (await fetch(`${url}/api/v1/local/state`)).json()).accounts[0].balance, -1250);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
