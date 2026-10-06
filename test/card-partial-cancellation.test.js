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
import { refundPaidCardPurchase } from '../src/card-refund.js';
import { cardRefundReceiptPreview } from '../src/card-refund-receipt.js';

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

test('partial cancellation can reduce earliest or latest installments and final cancellation clears only the remainder', () => {
  for (const [distributionMode, amounts] of [['earliest-first', [0, 3000, 4000]], ['latest-first', [4000, 3000, 0]]]) {
    const { book, plan } = fixture();
    try {
      const input = { ...request(book, plan, '5000'), distributionMode };
      partiallyCancelCardPurchase(book, 'editor', input);
      assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.amount), amounts);
      assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.dueDate), plan.installments.map(i => i.dueDate));
      assert.equal(book.pendingCardPayments('9999-12-31').length, 2);
      assert.equal(book.budget('2026-11').categories.food.spent, -5000);
      assert.equal(book.reports('2026-11-01', '2026-11-30').cashFlow.netChange, 0);
      const projected = forecast(book, 'owner', { asOf: '2026-10-10', throughDate: '2027-02-01', cardCashId: 'cash' }).events.filter(e => e.type === 'card');
      assert.equal(projected.length, 2); assert.equal(projected.reduce((sum, e) => sum + e.amount, 0), -7000);
      assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...input, distributionMode: 'equal' }), /reused/);
      const full = { ...request(book, plan), date: '2026-12-01' };
      assert.equal(cancelCardPurchase(book, 'editor', full).entry.postings[0].amount, 7000);
      assert.equal(book.reports('2026-10-01', '2026-12-31').incomeStatement.expenses, 0);
      assert.equal(book.pendingCardPayments('9999-12-31').length, 0);
      assert.equal(partiallyCancelCardPurchase(book, 'editor', input).duplicate, true);
    } finally { book.close(); }
  }
});

test('manual partial deductions survive reopen and payment and canonical replay preserves the original allocation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'partial-allocation-')); let book;
  try {
    const setup = fixture(join(dir, 'book.sqlite')); book = setup.book;
    const input = { ...request(book, setup.plan), distributionMode: 'manual', deductions: [
      { index: 3, amountExpression: '500*2' }, { index: 1, amountExpression: '1000' }, { index: 2, amountExpression: '0' }] };
    partiallyCancelCardPurchase(book, 'editor', input);
    assert.deepEqual(book.cardPlan(setup.plan.id).installments.map(i => i.amount), [3000, 4000, 3000]);
    const audit = cardCancellationPreview(book, 'viewer', setup.plan.id).partials[0];
    assert.equal(audit.distributionMode, 'manual'); assert.deepEqual(audit.deductions, [{ index: 1, amount: 1000 }, { index: 2, amount: 0 }, { index: 3, amount: 1000 }]);
    book.close(); book = new Book(join(dir, 'book.sqlite'));
    recordCardPayment(book, 'editor', { planId: setup.plan.id, index: 1, date: '2026-11-25', cashId: 'cash', expectedAmount: 3000 });
    const equivalent = { ...input, deductions: [{ index: 1, amountExpression: '500+500' }, { index: 2, amountExpression: '0' }, { index: 3, amountExpression: '1000' }] };
    assert.equal(partiallyCancelCardPurchase(book, 'editor', equivalent).duplicate, true);
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...input, deductions: [{ index: 1, amountExpression: '2000' }] }), /reused/);
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...request(book, setup.plan), distributionMode: 'latest-first' }), /refund workflow/);
    assert.equal(book.entries().length, 3);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('invalid deductions and failed custom partial saves leave the original plan and budget intact', () => {
  const { book, plan } = fixture();
  try {
    const input = { ...request(book, plan), distributionMode: 'manual' };
    for (const deductions of [undefined, [], [{ index: 1, amountExpression: '-1' }], [{ index: 1, amountExpression: '4001' }],
      [{ index: 1, amountExpression: '1999' }], [{ index: 4, amountExpression: '2000' }],
      [{ index: 1, amountExpression: '1000' }, { index: 1, amountExpression: '1000' }]]) {
      assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...input, deductions }));
    }
    const valid = { ...input, deductions: [{ index: 1, amountExpression: '2000' }] };
    for (const table of ['card_partial_cancellations', 'card_plans']) {
      book.db.exec(`CREATE TRIGGER fail_custom_partial BEFORE ${table === 'card_plans' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'custom failure'); END`);
      assert.throws(() => partiallyCancelCardPurchase(book, 'editor', valid), /custom failure/);
      assert.deepEqual(book.cardPlan(plan.id), plan); assert.equal(book.entries().length, 1);
      assert.equal(book.budget('2026-11').categories.food.spent, 0);
      book.db.exec('DROP TRIGGER fail_custom_partial');
    }
    partiallyCancelCardPurchase(book, 'editor', valid);
    assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.amount), [2000, 4000, 4000]);
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', { ...valid, requestId: randomUUID() }), /changed/);
  } finally { book.close(); }
});

test('front-loaded partial cancellation excludes zero dues and supports paying and refunding the remaining single won', () => {
  const { book, plan } = fixture(undefined, '3');
  try {
    const input = { ...request(book, plan, '2'), distributionMode: 'earliest-first' };
    partiallyCancelCardPurchase(book, 'editor', input);
    assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.amount), [0, 0, 1]);
    assert.equal(book.pendingCardPayments('9999-12-31')[0].index, 3);
    assert.throws(() => recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2027-01-25', cashId: 'cash', expectedAmount: 0 }), /zero/);
    recordCardPayment(book, 'editor', { planId: plan.id, index: 3, date: '2027-01-25', cashId: 'cash', expectedAmount: 1 });
    const refund = { ...request(book, plan, '1'), date: '2027-02-01' };
    refundPaidCardPurchase(book, 'editor', refund);
    assert.equal(cardRefundReceiptPreview(book, 'editor', refund.requestId).receiptLimit, 1);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).remainingAmount, 0);
    assert.equal(book.reports('2026-10-01', '2027-02-28').incomeStatement.expenses, 0);
    assert.equal(partiallyCancelCardPurchase(book, 'editor', input).duplicate, true);
  } finally { book.close(); }
});

test('HTTP partial allocation validates manual fields, escapes history and preserves existing CSRF and permission rules', async () => {
  const { book, plan } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  try {
    const page = await (await fetch(`${base}/cancel?planId=${plan.id}`)).text();
    assert.match(page, /name="distributionMode"/); assert.match(page, /name="deduction:1"/); assert.match(page, /합계는 부분취소 금액과 같아야/);
    const input = { ...request(book, plan), distributionMode: 'manual', csrf: 'token', reason: '<지정 & 취소>', 'deduction:1': '2000', 'deduction:2': '0', 'deduction:3': '0' };
    const send = values => fetch(`${base}/cancel-partial`, { method: 'POST', body: new URLSearchParams(values) });
    assert.equal((await send({ ...input, csrf: 'bad' })).status, 403);
    assert.equal((await send({ ...input, 'deduction:1': '1999' })).status, 400);
    assert.equal((await send({ ...input, 'deduction:1x': '0' })).status, 400);
    const duplicate = new URLSearchParams(input); duplicate.append('deduction:1', '0');
    assert.equal((await fetch(`${base}/cancel-partial`, { method: 'POST', body: duplicate })).status, 400);
    sub = 'viewer'; assert.equal((await send(input)).status, 400);
    sub = 'editor'; const result = await send(input); assert.equal(result.status, 200);
    const html = await result.text(); assert.match(html, /배분 방식: 회차별 차감액 직접 지정/); assert.match(html, /&lt;지정 &amp; 취소&gt;/);
    assert.match(html, /4,000원 → 2,000원/); assert.equal((await send(input)).status, 200);
    assert.equal(book.entries().length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

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
    const row = book.db.prepare('SELECT data FROM card_partial_cancellations WHERE id = ?').get(input.requestId);
    const legacy = JSON.parse(row.data); delete legacy.distributionMode; delete legacy.deductions;
    book.db.prepare('UPDATE card_partial_cancellations SET data = ? WHERE id = ?').run(JSON.stringify(legacy), input.requestId);
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
