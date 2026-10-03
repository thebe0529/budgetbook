import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount } from '../src/manual.js';
import { cardCashDefault, setCardCashDefault, recordCardPurchase, recordCardPayment } from '../src/card-manual.js';
import { createImportApi } from '../src/import-api.js';

test('card default is visible only with current card and cash write access', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true });
    const cash = createLedgerAccount(book, 'owner', { name: '출금', type: 'asset', cash: true });
    const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
    setMember(book, 'owner', 'editor', 'editor', [card.id, cash.id]);
    setCardCashDefault(book, 'owner', card.id, cash.id);
    assert.equal(cardCashDefault(book, 'editor', card.id), cash.id);
    assert.throws(() => setCardCashDefault(book, 'editor', card.id, cash.id), /Owner/);
    assert.throws(() => setCardCashDefault(book, 'owner', card.id, expense.id), /cash asset/);
    const plan = recordCardPurchase(book, 'owner', { requestId: randomUUID(), date: '2026-10-03',
      cardId: card.id, expenseId: expense.id, amountExpression: '10000', count: '1', firstDueDate: '2026-11-03' }).plan;
    setMember(book, 'owner', 'editor', 'editor', [card.id]);
    assert.equal(cardCashDefault(book, 'editor', card.id), null);
    assert.throws(() => recordCardPayment(book, 'editor', { planId: plan.id, index: 1,
      date: '2026-11-03', cashId: cash.id }), /write access/);
    assert.equal(book.pendingCardPayments('2026-11-30').length, 1);
    setCardCashDefault(book, 'owner', card.id, null);
    assert.equal(cardCashDefault(book, 'owner', card.id), null);
  } finally { book.close(); }
});

test('default cash endpoint enforces owner and CSRF and selects the configured payment account', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true });
  const cash = createLedgerAccount(book, 'owner', { name: '출금', type: 'asset', cash: true });
  const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
  recordCardPurchase(book, 'owner', { requestId: randomUUID(), date: '2026-10-03', cardId: card.id,
    expenseId: expense.id, amountExpression: '1000', count: '1', firstDueDate: '2026-11-03' });
  setMember(book, 'owner', 'editor', 'editor', [card.id, cash.id]);
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'editor=1' ? 'editor' : 'owner',
    role: req.headers.cookie === 'editor=1' ? 'editor' : 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/cards/default-cash`;
  const body = { cardId: card.id, cashId: cash.id, throughDate: '2026-11-30', csrf: 'token' };
  const send = (data, cookie = '') => fetch(url, { method: 'POST', headers: { Cookie: cookie },
    body: new URLSearchParams(data) });
  try {
    assert.equal((await send({ ...body, csrf: 'wrong' })).status, 403);
    assert.equal((await send(body, 'editor=1')).status, 400);
    const response = await send(body);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, new RegExp(`value="${cash.id}" selected`));
    const payForm = html.match(/action="\/admin\/cards\/pay"[\s\S]*?<\/form>/)?.[0];
    assert.match(payForm, new RegExp(`value="${cash.id}" selected`));
    assert.equal(book.entries().length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
