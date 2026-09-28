import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountOverview, accountRegister, createCategory, createGroup, createLedgerAccount,
  recordManual } from '../src/manual.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book();
  ensureOwner(book, 'owner');
  const group = createGroup(book, 'owner', '보통예금', 'asset');
  const bank = createLedgerAccount(book, 'owner', { name: '공유 통장', type: 'asset',
    groupId: group.id, onBudget: true, cash: true });
  const privateBank = createLedgerAccount(book, 'owner', { name: '비공개 계좌', type: 'asset', cash: true });
  const equity = createLedgerAccount(book, 'owner', { name: '기초자산', type: 'equity' });
  const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  const income = createLedgerAccount(book, 'owner', { name: '급여', type: 'income' });
  const category = createCategory(book, 'owner', '식비 예산');
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  setMember(book, 'owner', 'reader', 'viewer', [bank.id]);
  return { book, bank, privateBank, equity, expense, income, category };
}

test('manual entry uses arithmetic input, updates budget and prevents duplicate submission', () => {
  const { book, bank, privateBank, equity, expense, income, category } = setup();
  try {
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'opening',
      accountId: bank.id, counterId: equity.id, amountExpression: '100000', memo: '기초' });
    const requestId = randomUUID();
    const input = { requestId, date: '2026-10-10', kind: 'expense', accountId: bank.id,
      counterId: expense.id, categoryId: category.id, amountExpression: '10000+2500*2', memo: '장보기' };
    assert.equal(recordManual(book, 'editor', input).duplicate, false);
    assert.equal(recordManual(book, 'editor', input).duplicate, true);
    assert.throws(() => recordManual(book, 'editor', { ...input, amountExpression: '25000' }), /reused/);
    assert.equal(book.entries().length, 2);
    assert.equal(book.budget('2026-10').categories[category.id].spent, 15_000);
    assert.equal(accountRegister(book, 'editor', bank.id, '2026-10-31').balance, 85_000);
    assert.throws(() => recordManual(book, 'editor', { ...input, requestId: randomUUID(),
      kind: 'transfer', counterId: privateBank.id }), /destination access/);
    assert.throws(() => recordManual(book, 'reader', { ...input, requestId: randomUUID() }), /write access/);
    assert.throws(() => createLedgerAccount(book, 'editor', { name: '몰래', type: 'asset' }), /Owner/);
    assert.throws(() => accountRegister(book, 'editor', privateBank.id, '2026-10-31'), /read access/);
    assert.deepEqual(accountOverview(book, 'reader', '2026-10-31').map(a => a.name), ['공유 통장']);
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-15', kind: 'income',
      accountId: bank.id, counterId: income.id, amountExpression: '20000', memo: '급여' });
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-16', kind: 'transfer',
      accountId: bank.id, counterId: privateBank.id, amountExpression: '5000', memo: '저축' });
    assert.equal(accountRegister(book, 'owner', bank.id, '2026-10-31').balance, 100_000);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.result, 5_000);
  } finally { book.close(); }
});

test('account and report pages show only permitted account data to family member', async () => {
  const { book, bank, privateBank, equity, category } = setup();
  recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'opening',
    accountId: privateBank.id, counterId: equity.id, amountExpression: '900000', memo: '비공개 기초' });
  const auth = { session: req => req.headers.cookie === 'reader=1' ?
    { sub: 'reader', role: 'viewer', csrf: 'csrf-reader' } :
    { sub: 'owner', role: 'owner', csrf: 'csrf-owner' } };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const accounts = await (await fetch(`${base}/admin/accounts`, { headers: { Cookie: 'reader=1' } })).text();
    assert.ok(accounts.includes('공유 통장'));
    assert.ok(!accounts.includes('비공개 계좌'));
    const reports = await (await fetch(`${base}/admin/reports?fromDate=2026-10-01&throughDate=2026-10-31`,
      { headers: { Cookie: 'reader=1' } })).text();
    assert.ok(!reports.includes('900,000'));
    assert.ok(!reports.includes('비공개 계좌'));
    const budgetDenied = await fetch(`${base}/admin/budget?month=2026-10`, { headers: { Cookie: 'reader=1' } });
    assert.equal(budgetDenied.status, 400);
    assert.ok(!(await budgetDenied.text()).includes('900,000'));
    const setBudget = await fetch(`${base}/admin/budget`, { method: 'POST', headers: {
      'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({
        csrf: 'csrf-owner', month: '2026-10', categoryId: category.id,
        amountExpression: '10000+5000',
      }) });
    assert.equal(setBudget.status, 200);
    assert.equal(book.budget('2026-10').categories[category.id].budgeted, 15_000);
    const denied = await fetch(`${base}/admin/register?accountId=${encodeURIComponent(privateBank.id)}`,
      { headers: { Cookie: 'reader=1' } });
    assert.ok(!(await denied.text()).includes('비공개 계좌'));
    const posted = await fetch(`${base}/admin/transactions`, { method: 'POST', headers: {
      Cookie: 'reader=1', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'csrf-reader', requestId: randomUUID(),
        accountId: bank.id, counterId: equity.id, date: '2026-10-10', kind: 'opening',
        amountExpression: '100000' }) });
    assert.equal(posted.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
