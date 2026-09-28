import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createCategory, createLedgerAccount } from '../src/manual.js';
import { recordCardPayment, recordCardPurchase, visibleCardSchedule } from '../src/card-manual.js';
import { createImportApi } from '../src/import-api.js';

test('card form actions record expense once, budget once and future payment dates', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true, onBudget: true });
    const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
    const category = createCategory(book, 'owner', '식비');
    setMember(book, 'owner', 'editor', 'editor', [card.id]);
    const input = { requestId: randomUUID(), date: '2026-10-10', cardId: card.id,
      expenseId: food.id, amountExpression: '100000+20000', count: '3',
      firstDueDate: '2026-11-25', categoryId: category.id, memo: '가족 식사' };
    assert.throws(() => recordCardPurchase(book, 'editor', { ...input,
      firstDueDate: '2026-09-25' }), /precedes/);
    const first = recordCardPurchase(book, 'editor', input);
    assert.equal(recordCardPurchase(book, 'editor', input).duplicate, true);
    assert.throws(() => recordCardPurchase(book, 'owner', input), /reused/);
    assert.equal(first.plan.installments.length, 3);
    assert.equal(visibleCardSchedule(book, 'editor', '2027-01-31').length, 3);
    assert.equal(book.budget('2026-10').categories[category.id].spent, 120_000);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.expenses, 120_000);
    assert.throws(() => recordCardPayment(book, 'editor', { planId: first.plan.id,
      index: 1, date: '2026-11-25', cashId: cash.id }), /write access/);
    setMember(book, 'owner', 'editor', 'editor', [card.id, cash.id]);
    recordCardPayment(book, 'editor', { planId: first.plan.id, index: 1,
      date: '2026-11-25', cashId: cash.id });
    assert.throws(() => recordCardPayment(book, 'editor', { planId: first.plan.id, index: 1,
      date: '2026-11-25', cashId: cash.id }), /already paid/);
    assert.equal(visibleCardSchedule(book, 'editor', '2027-01-31').length, 2);
    assert.equal(book.budget('2026-11').categories[category.id].spent, 0);
    assert.equal(book.reports('2026-11-01', '2026-11-30').cashFlow.netChange, -40_000);
  } finally { book.close(); }
});

test('card page checks CSRF and lists payment schedule', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const card = createLedgerAccount(book, 'owner', { name: '공유 카드', type: 'liability', card: true });
  createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  const auth = { session: () => ({ sub: 'owner', role: 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${url}/admin/cards?throughDate=2027-01-31`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /카드 구매·할부 등록/);
    const params = new URLSearchParams({ csrf: 'invalid', requestId: randomUUID(),
      date: '2026-10-10', cardId: card.id });
    const denied = await fetch(`${url}/admin/cards/purchase`, { method: 'POST', body: params });
    assert.equal(denied.status, 403);
    assert.equal(book.entries().length, 0);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
