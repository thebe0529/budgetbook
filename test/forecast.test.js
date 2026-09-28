import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount, recordManual } from '../src/manual.js';
import { disableSchedule, forecast, saveSchedule } from '../src/forecast.js';
import { recordCardPurchase } from '../src/card-manual.js';
import { createImportApi } from '../src/import-api.js';
import { randomUUID } from 'node:crypto';

test('cash forecast combines monthly schedules, unpaid cards and posted future cash without changing ledger', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const equity = createLedgerAccount(book, 'owner', { name: '자본', type: 'equity' });
    const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true });
    const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
    setMember(book, 'owner', 'viewer', 'viewer', [cash.id]);
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01',
      kind: 'opening', accountId: cash.id, counterId: equity.id, amountExpression: '100000' });
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-03',
      kind: 'expense', accountId: cash.id, counterId: expense.id, amountExpression: '3000' });
    const plan = recordCardPurchase(book, 'owner', { requestId: randomUUID(), date: '2026-10-05',
      cardId: card.id, expenseId: expense.id, amountExpression: '30000', count: 3,
      firstDueDate: '2026-11-25' });
    const schedule = saveSchedule(book, 'owner', { accountId: cash.id, name: '월급',
      amountExpression: '20000', startDate: '2026-10-31', frequency: 'monthly' });
    const args = { asOf: '2026-10-10', throughDate: '2026-12-31', cardCashId: cash.id };
    const result = forecast(book, 'owner', args);
    assert.equal(result.openingTotal, 100000);
    assert.deepEqual(result.events.map(e => [e.date, e.type, e.amount]), [
      ['2026-10-31', 'schedule', 20000], ['2026-11-03', 'booked', -3000],
      ['2026-11-25', 'card', -10000], ['2026-11-30', 'schedule', 20000],
      ['2026-12-25', 'card', -10000], ['2026-12-31', 'schedule', 20000],
    ]);
    assert.equal(result.projectedTotal, 137000);
    assert.equal(forecast(book, 'owner', { ...args, overrides: { [schedule.id]: '25000+5000' } }).projectedTotal,
      167000);
    assert.equal(book.entries().length, 3);
    assert.throws(() => forecast(book, 'viewer', args), /Owner/);
    assert.throws(() => forecast(book, 'owner', { ...args, overrides: { fake: '1' } }), /Unknown/);
    assert.throws(() => saveSchedule(book, 'viewer', { accountId: cash.id, name: '몰래',
      amountExpression: '1', startDate: '2026-11-01', frequency: 'once' }), /Owner/);
    disableSchedule(book, 'owner', schedule.id);
    assert.equal(forecast(book, 'owner', args).projectedTotal, 77000);
    assert.ok(book.cardPlan(plan.plan.id));
  } finally { book.close(); }
});

test('forecast page respects owner role and CSRF', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
  setMember(book, 'owner', 'viewer', 'viewer', [cash.id]);
  const auth = { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner',
    role: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${url}/admin/forecast?asOf=2026-10-01&throughDate=2026-12-31`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /예상 상세/);
    const denied = await fetch(`${url}/admin/forecast?asOf=2026-10-01&throughDate=2026-12-31`,
      { headers: { Cookie: 'viewer=1' } });
    assert.equal(denied.status, 400);
    const invalid = await fetch(`${url}/admin/forecast/schedules`, { method: 'POST',
      body: new URLSearchParams({ csrf: 'wrong' }) });
    assert.equal(invalid.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
