import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount } from '../src/manual.js';
import { recordCardPurchase, recordCardPaymentBatch } from '../src/card-manual.js';
import { createImportApi } from '../src/import-api.js';

function fixture() {
  const book = new Book();
  ensureOwner(book, 'owner');
  const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true });
  const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
  const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
  const plan = recordCardPurchase(book, 'owner', { requestId: randomUUID(), date: '2026-10-03',
    cardId: card.id, expenseId: expense.id, amountExpression: '12000', count: '3', firstDueDate: '2026-11-25' }).plan;
  const input = { requestId: randomUUID(), items: [{ planId: plan.id, index: 1 }, { planId: plan.id, index: 2 }],
    date: '2026-12-25', cashId: cash.id };
  return { book, card, cash, plan, input };
}

test('bulk card payments post each installment once and roll back all writes on failure', () => {
  const { book, card, cash, plan, input } = fixture();
  try {
    book.db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON entries
      WHEN NEW.id = 'payment:${plan.id}:2' BEGIN SELECT RAISE(ABORT, 'payment failure'); END;`);
    assert.throws(() => recordCardPaymentBatch(book, 'owner', input), /payment failure/);
    assert.equal(book.entries().length, 1);
    assert.equal(book.pendingCardPayments('2027-02-01').length, 3);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM card_payment_batches').get().n, 0);
    book.db.exec('DROP TRIGGER reject_second');
    const result = recordCardPaymentBatch(book, 'owner', input);
    assert.equal(result.total, 8000);
    assert.equal(recordCardPaymentBatch(book, 'owner', { ...input, items: [...input.items].reverse() }).duplicate, true);
    assert.equal(book.entries().length, 3);
    assert.equal(book.reports('2026-10-01', '2027-01-31').balanceSheet.accounts[card.id], 4000);
    assert.equal(book.reports('2026-10-01', '2027-01-31').balanceSheet.accounts[cash.id], -8000);
    assert.throws(() => recordCardPaymentBatch(book, 'owner', { ...input, date: '2026-12-26' }), /reused/);
    assert.throws(() => recordCardPaymentBatch(book, 'owner', { ...input, requestId: randomUUID(),
      items: [{ planId: plan.id, index: 3 }, { planId: plan.id, index: 2 }] }), /already paid/);
    assert.equal(book.pendingCardPayments('2027-02-01').length, 1);
  } finally { book.close(); }
});

test('bulk payment endpoint checks CSRF and both account permissions', async () => {
  const { book, card, input } = fixture();
  setMember(book, 'owner', 'editor', 'editor', [card.id]);
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'editor=1' ? 'editor' : 'owner',
    role: req.headers.cookie === 'editor=1' ? 'editor' : 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/cards/pay-batch`;
  const send = (csrf = 'token', cookie = '') => {
    const body = new URLSearchParams({ csrf, requestId: input.requestId, date: input.date,
      cashId: input.cashId, throughDate: '2027-01-31' });
    for (const item of input.items) body.append('item', JSON.stringify([item.planId, item.index]));
    return fetch(url, { method: 'POST', headers: { Cookie: cookie }, body });
  };
  try {
    assert.equal((await send('wrong')).status, 403);
    assert.equal((await send('token', 'editor=1')).status, 400);
    assert.equal((await send()).status, 200);
    assert.equal((await send()).status, 200);
    assert.equal(book.entries().length, 3);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
