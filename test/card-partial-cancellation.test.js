import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordCardPurchase, recordCardPayment } from '../src/card-manual.js';
import { cardCancellationPreview, cancelCardPurchase, partiallyCancelCardPurchase } from '../src/card-cancellation.js';
import { forecast } from '../src/forecast.js';
import { createImportApi } from '../src/import-api.js';

function fixture(filename, amount = '12000') {
  const book = new Book(filename); ensureOwner(book, 'owner');
  book.createAccount({ id: 'card', name: '카드', type: 'liability', card: true, onBudget: true });
  book.createAccount({ id: 'cash', name: '은행', type: 'asset', cash: true });
  book.createAccount({ id: 'expense', name: '비용', type: 'expense' });
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['card', 'cash']);
  setMember(book, 'owner', 'other', 'editor', ['card']);
  setMember(book, 'owner', 'viewer', 'viewer', ['card']);
  const purchase = { requestId: randomUUID(), date: '2026-10-10', cardId: 'card', expenseId: 'expense',
    amountExpression: amount, count: '3', firstDueDate: '2026-11-25', categoryId: 'food', memo: '<식사>' };
  const plan = recordCardPurchase(book, 'editor', purchase).plan;
  return { book, plan, purchase };
}
const request = (book, plan, amountExpression = '2000') => ({ requestId: randomUUID(), planId: plan.id,
  expectedHash: cardCancellationPreview(book, 'editor', plan.id).expectedHash, date: '2026-11-01', reason: '부분 반품', amountExpression });

test('partial cancellation reverses only the chosen amount and evenly reallocates installments without shifting dates', () => {
  const { book, plan, purchase } = fixture();
  try {
    const input = request(book, plan); const original = book.entries()[0];
    const result = partiallyCancelCardPurchase(book, 'editor', input);
    assert.deepEqual(book.entries()[0], original); assert.equal(result.entry.postings[0].amount, 2000);
    assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.amount), [3334, 3333, 3333]);
    assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.dueDate), plan.installments.map(i => i.dueDate));
    assert.equal(book.budget('2026-10').categories.food.spent, 12000);
    assert.equal(book.budget('2026-11').categories.food.spent, -2000);
    assert.equal(book.reports('2026-11-01', '2026-11-30').balanceSheet.liabilities, 10000);
    assert.equal(book.reports('2026-11-01', '2026-11-30').cashFlow.netChange, 0);
    const projected = forecast(book, 'owner', { asOf: '2026-10-10', throughDate: '2027-02-01', cardCashId: 'cash' });
    assert.equal(projected.events.filter(e => e.type === 'card').reduce((sum, e) => sum + e.amount, 0), -10000);
    assert.equal(partiallyCancelCardPurchase(book, 'editor', { ...input, amountExpression: '1000+1000' }).duplicate, true);
    assert.equal(recordCardPurchase(book, 'editor', purchase).duplicate, true);
    const history = cardCancellationPreview(book, 'viewer', plan.id).partials[0];
    assert.deepEqual(history.beforeInstallments, plan.installments);
    assert.deepEqual(history.afterInstallments, book.cardPlan(plan.id).installments);
    for (const id of [original.id, result.entry.id]) {
      assert.throws(() => book.db.prepare('UPDATE entries SET data = data WHERE id = ?').run(id), /cannot be changed/);
      assert.throws(() => book.db.prepare('DELETE FROM entries WHERE id = ?').run(id), /cannot be changed/);
    }
  } finally { book.close(); }
});

test('successive partial cancellations and final cancellation reverse only the remaining balance and retain retry receipts', () => {
  const { book, plan } = fixture();
  try {
    const first = request(book, plan); partiallyCancelCardPurchase(book, 'editor', first);
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...first, requestId: randomUUID() }), /changed/);
    assert.throws(() => cancelCardPurchase(book, 'editor', first), /reused/);
    const second = { ...request(book, plan, '1000'), date: '2026-11-02' };
    partiallyCancelCardPurchase(book, 'editor', second);
    assert.equal(cardCancellationPreview(book, 'editor', plan.id).remainingAmount, 9000);
    assert.throws(() => cancelCardPurchase(book, 'editor', { ...request(book, plan), date: '2026-11-01' }), /latest partial/);
    const full = { ...request(book, plan), date: '2026-12-01' };
    assert.equal(cancelCardPurchase(book, 'editor', full).entry.postings[0].amount, 9000);
    assert.equal(book.budget('2026-12').categories.food.spent, -9000);
    assert.equal(book.reports('2026-10-01', '2026-12-31').incomeStatement.expenses, 0);
    assert.equal(book.reports('2026-12-01', '2026-12-31').balanceSheet.liabilities, 0);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).remainingAmount, 0);
    assert.equal(partiallyCancelCardPurchase(book, 'editor', first).duplicate, true);
    assert.equal(cancelCardPurchase(book, 'editor', full).duplicate, true);
    assert.equal(book.entries().length, 4);
  } finally { book.close(); }
});

test('partial cancellation validates amount, author, dates, stale state, paid plans and zero installments', () => {
  const { book, plan } = fixture(undefined, '3');
  try {
    const input = request(book, plan, '2');
    for (const amountExpression of ['0', '-1', '3', '4', '1/0']) assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...input, amountExpression }));
    for (const bad of [{ date: '2026-10-09' }, { reason: '' }, { requestId: 'bad' }]) assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...input, ...bad }));
    assert.throws(() => partiallyCancelCardPurchase(book, 'other', input), /author or owner/);
    assert.throws(() => partiallyCancelCardPurchase(book, 'viewer', input), /author or owner/);
    partiallyCancelCardPurchase(book, 'editor', input);
    assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.amount), [1, 0, 0]);
    assert.equal(book.pendingCardPayments('2027-12-31').length, 1);
    assert.throws(() => recordCardPayment(book, 'editor', { planId: plan.id, index: 2, date: '2026-12-25', cashId: 'cash', expectedAmount: 0 }), /zero/);
    assert.throws(() => recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2026-10-31', cashId: 'cash', expectedAmount: 1 }), /latest partial/);
    recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2026-11-25', cashId: 'cash', expectedAmount: 1 });
    assert.equal(partiallyCancelCardPurchase(book, 'editor', input).duplicate, true);
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', request(book, plan, '0.5')), /refund workflow/);
    assert.equal(book.entries().length, 3);
  } finally { book.close(); }
});

test('period locks and audit or plan write failures roll back the entire partial cancellation', () => {
  const { book, plan } = fixture();
  try {
    const input = request(book, plan);
    book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run('card', input.date, '{}');
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', input), /locked/);
    book.db.prepare('DELETE FROM account_period_locks').run();
    for (const table of ['card_partial_cancellations', 'card_plans']) {
      book.db.exec(`CREATE TRIGGER fail_partial BEFORE ${table === 'card_plans' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'partial failure'); END;`);
      assert.throws(() => partiallyCancelCardPurchase(book, 'editor', input), /partial failure/);
      assert.equal(book.entries().length, 1); assert.deepEqual(book.cardPlan(plan.id), plan);
      assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM card_partial_cancellations').get().n, 0);
      book.db.exec('DROP TRIGGER fail_partial');
    }
    assert.equal(partiallyCancelCardPurchase(book, 'editor', input).duplicate, false);
  } finally { book.close(); }
});

test('partial history and original request receipts persist across database reopen and later payment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-partial-')); const file = join(dir, 'book.sqlite'); let book;
  try {
    const setup = fixture(file); book = setup.book; const { plan } = setup;
    const input = request(book, plan); partiallyCancelCardPurchase(book, 'editor', input);
    book.close(); book = new Book(file);
    assert.equal(partiallyCancelCardPurchase(book, 'editor', input).duplicate, true);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).partials[0].amount, 2000);
    recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2026-11-25', cashId: 'cash', expectedAmount: 3334 });
    assert.equal(book.entries().at(-1).postings[0].amount, 3334);
    assert.equal(partiallyCancelCardPurchase(book, 'editor', input).duplicate, true);
    assert.equal(book.entries().length, 3);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP partial cancellation enforces CSRF and permissions, escapes history and shows recomputed balance', async () => {
  const { book, plan } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  try {
    const input = { ...request(book, plan), csrf: 'token', reason: '<취소 & 확인>' };
    const send = values => fetch(`${base}/cancel-partial`, { method: 'POST', body: new URLSearchParams(values) });
    assert.equal((await send({ ...input, csrf: 'wrong' })).status, 403);
    sub = 'viewer'; assert.equal((await send(input)).status, 400);
    sub = 'editor'; const response = await send(input); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /남은 구매 금액: 10,000원/); assert.match(html, /부분취소 이력/);
    assert.match(html, /&lt;취소 &amp; 확인&gt;/); assert.match(html, /기존 회차 수로 균등 배분/);
    assert.equal((await send(input)).status, 200);
    const listing = await (await fetch(`${base}`)).text(); assert.match(listing, /부분취소 · 전 회차 미결제/);
    sub = 'viewer'; const view = await (await fetch(`${base}/cancel?planId=${plan.id}`)).text();
    assert.match(view, /부분취소 이력/); assert.doesNotMatch(view, /action="\/admin\/cards\/cancel-partial"/);
    sub = 'editor';
    const pay = { csrf: 'token', planId: plan.id, index: '1', date: '2026-11-25', cashId: 'cash' };
    const sendPay = values => fetch(`${base}/pay`, { method: 'POST', body: new URLSearchParams(values) });
    assert.equal((await sendPay(pay)).status, 400);
    assert.equal((await sendPay({ ...pay, expectedAmount: '4000' })).status, 400);
    assert.equal((await sendPay({ ...pay, expectedAmount: '3334' })).status, 200);
    const batch = new URLSearchParams({ csrf: 'token', requestId: randomUUID(), date: '2027-01-25', cashId: 'cash', throughDate: '2027-12-31' });
    batch.append('item', JSON.stringify([plan.id, 2, 3333])); batch.append('item', JSON.stringify([plan.id, 3, 4000]));
    assert.equal((await fetch(`${base}/pay-batch`, { method: 'POST', body: batch })).status, 400);
    assert.equal(book.cardPlan(plan.id).installments[1].paidEntryId, null);
    batch.delete('item'); batch.append('item', JSON.stringify([plan.id, 2, 3333])); batch.append('item', JSON.stringify([plan.id, 3, 3333]));
    assert.equal((await fetch(`${base}/pay-batch`, { method: 'POST', body: batch })).status, 200);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
