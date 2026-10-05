import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordCardPurchase, recordCardPayment, recordCardPaymentBatch } from '../src/card-manual.js';
import { cardCancellationPreview, cancelCardPurchase, partiallyCancelCardPurchase } from '../src/card-cancellation.js';
import { refundPaidCardPurchase } from '../src/card-refund.js';
import { createImportApi } from '../src/import-api.js';

function fixture(filename, pay = true) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  book.createAccount({ id: 'card', name: '카드', type: 'liability', card: true, onBudget: true });
  book.createAccount({ id: 'cash', name: '은행', type: 'asset', cash: true });
  book.createAccount({ id: 'expense', name: '비용', type: 'expense' });
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['card', 'cash']);
  setMember(book, 'owner', 'other', 'editor', ['card']);
  setMember(book, 'owner', 'viewer', 'viewer', ['card']);
  const purchase = { requestId: randomUUID(), date: '2026-10-10', cardId: 'card', expenseId: 'expense',
    amountExpression: '12000', count: '3', firstDueDate: '2026-11-25', categoryId: 'food', memo: '<식사>' };
  const plan = recordCardPurchase(book, 'editor', purchase).plan;
  const payment = { requestId: randomUUID(), date: '2027-01-25', cashId: 'cash',
    items: plan.installments.map(item => ({ planId: plan.id, index: item.index })) };
  if (pay) recordCardPaymentBatch(book, 'editor', payment);
  return { book, plan, purchase, payment };
}
const request = (book, plan, amountExpression = '2000') => ({ requestId: randomUUID(), planId: plan.id,
  expectedHash: cardCancellationPreview(book, 'editor', plan.id).expectedHash, date: '2027-02-01', reason: '반품', amountExpression });

test('paid card credit refunds reverse expense and budget but do not fabricate bank cash or alter paid installments', () => {
  const { book, plan, payment } = fixture();
  try {
    const before = book.entries(); const installments = book.cardPlan(plan.id).installments;
    const input = request(book, plan); const result = refundPaidCardPurchase(book, 'editor', input);
    assert.deepEqual(book.entries().slice(0, 4), before); assert.deepEqual(book.cardPlan(plan.id).installments, installments);
    assert.equal(book.reports('2027-02-01', '2027-02-28').incomeStatement.expenses, -2000);
    assert.equal(book.budget('2027-02').categories.food.spent, -2000);
    assert.equal(book.reports('2027-02-01', '2027-02-28').balanceSheet.liabilities, -2000);
    assert.equal(book.reports('2027-02-01', '2027-02-28').cashFlow.netChange, 0);
    assert.equal(book.pendingCardPayments('9999-12-31').length, 0);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).remainingAmount, 10000);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).refunds[0].method, 'card-credit');
    assert.equal(refundPaidCardPurchase(book, 'editor', { ...input, amountExpression: '1000+1000' }).duplicate, true);
    assert.equal(recordCardPaymentBatch(book, 'editor', payment).duplicate, true);
    for (const id of [...before.map(e => e.id), result.entry.id]) {
      assert.throws(() => book.db.prepare('UPDATE entries SET data = data WHERE id = ?').run(id), /cannot be changed/);
      assert.throws(() => book.db.prepare('DELETE FROM entries WHERE id = ?').run(id), /cannot be changed/);
    }
    const altered = structuredClone(book.cardPlan(plan.id)); altered.installments[0].amount = 1;
    assert.throws(() => book.db.prepare('UPDATE card_plans SET data = ? WHERE id = ?').run(JSON.stringify(altered), plan.id), /cannot be changed/);
    assert.throws(() => book.db.prepare('DELETE FROM card_plans WHERE id = ?').run(plan.id), /cannot be changed/);
  } finally { book.close(); }
});

test('successive partial and full paid refunds enforce the remaining amount and preserve idempotency', () => {
  const { book, plan, purchase } = fixture();
  try {
    const first = request(book, plan); refundPaidCardPurchase(book, 'editor', first);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', { ...first, requestId: randomUUID() }), /changed/);
    assert.throws(() => cancelCardPurchase(book, 'editor', first), /reused/);
    assert.throws(() => partiallyCancelCardPurchase(book, 'editor', first), /reused/);
    const second = { ...request(book, plan, '10000'), date: '2027-03-01' }; refundPaidCardPurchase(book, 'editor', second);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).remainingAmount, 0);
    assert.equal(book.reports('2026-10-01', '2027-03-31').incomeStatement.expenses, 0);
    assert.equal(book.reports('2027-03-01', '2027-03-31').balanceSheet.liabilities, -12000);
    assert.equal(refundPaidCardPurchase(book, 'editor', first).duplicate, true);
    assert.equal(refundPaidCardPurchase(book, 'editor', second).duplicate, true);
    assert.equal(recordCardPurchase(book, 'editor', purchase).duplicate, true);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', { ...first, reason: '다른 사유' }), /reused/);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', { ...request(book, plan, '1'), date: '2027-03-02' }), /exceeds/);
    assert.equal(book.entries().length, 6);
  } finally { book.close(); }
});

test('refunds require full payment, current author and card permission, valid amount and chronological dates', () => {
  const { book, plan } = fixture(undefined, false);
  try {
    let input = request(book, plan);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', input), /fully paid/);
    recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2026-11-25', cashId: 'cash' });
    assert.throws(() => refundPaidCardPurchase(book, 'editor', request(book, plan)), /fully paid/);
    recordCardPaymentBatch(book, 'editor', { requestId: randomUUID(), date: '2027-01-25', cashId: 'cash', items: [{ planId: plan.id, index: 2 }, { planId: plan.id, index: 3 }] });
    input = request(book, plan);
    for (const sub of ['other', 'viewer']) assert.throws(() => refundPaidCardPurchase(book, sub, input), /author or owner/);
    for (const bad of [{ date: '2027-01-24' }, { date: '2027-02-30' }, { reason: '' }, { reason: 'x'.repeat(201) },
      { amountExpression: '0' }, { amountExpression: '-1' }, { amountExpression: '12001' }, { amountExpression: '1/0' }, { requestId: 'bad' }]) {
      assert.throws(() => refundPaidCardPurchase(book, 'editor', { ...input, ...bad }));
    }
    // A card credit does not require bank write access because no bank entry is changed.
    setMember(book, 'owner', 'editor', 'editor', ['card']);
    const paid = book.entries().find(e => e.kind === 'card-payment');
    book.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify({ ...paid, memo: 'changed payment' }), paid.id);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', input), /changed/);
    book.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify(paid), paid.id);
    refundPaidCardPurchase(book, 'editor', input);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', { ...request(book, plan), date: '2027-01-31' }), /previous refund/);
    setMember(book, 'owner', 'editor', 'editor', []);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', input), /read access/);
  } finally { book.close(); }
});

test('partial cancellation followed by full payment limits refunds to the reduced purchase amount including zero dues', () => {
  const { book, plan } = fixture(undefined, false);
  try {
    const partial = { ...request(book, plan, '11999'), date: '2026-11-01' };
    partiallyCancelCardPurchase(book, 'editor', partial);
    recordCardPayment(book, 'editor', { planId: plan.id, index: 1, expectedAmount: 1, date: '2026-11-25', cashId: 'cash' });
    assert.equal(cardCancellationPreview(book, 'editor', plan.id).fullyPaid, true);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', request(book, plan, '2')), /exceeds/);
    refundPaidCardPurchase(book, 'editor', request(book, plan, '1'));
    assert.equal(book.reports('2026-10-01', '2027-02-28').incomeStatement.expenses, 0);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).remainingAmount, 0);
    assert.equal(book.cardPlan(plan.id).refundedAmount, 1);
  } finally { book.close(); }
});

test('locks, audit failure and plan update failure roll back refunds and permit the same request to retry', () => {
  const { book, plan } = fixture();
  try {
    const input = request(book, plan); const before = book.cardPlan(plan.id);
    book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run('card', input.date, '{}');
    assert.throws(() => refundPaidCardPurchase(book, 'editor', input), /locked/);
    book.db.prepare('DELETE FROM account_period_locks').run();
    for (const table of ['card_refunds', 'card_plans']) {
      book.db.exec(`CREATE TRIGGER fail_refund BEFORE ${table === 'card_plans' ? 'UPDATE' : 'INSERT'} ON ${table} BEGIN SELECT RAISE(ABORT, 'refund failure'); END;`);
      assert.throws(() => refundPaidCardPurchase(book, 'editor', input), /refund failure/);
      assert.equal(book.entries().length, 4); assert.deepEqual(book.cardPlan(plan.id), before);
      assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM card_refunds').get().n, 0);
      book.db.exec('DROP TRIGGER fail_refund');
    }
    assert.equal(refundPaidCardPurchase(book, 'editor', input).duplicate, false);
  } finally { book.close(); }
});

test('refund history and receipt persist across database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-refund-')); const file = join(dir, 'book.sqlite'); let book;
  try {
    const setup = fixture(file); book = setup.book; const { plan } = setup;
    const input = request(book, plan); refundPaidCardPurchase(book, 'editor', input);
    book.close(); book = new Book(file);
    assert.equal(refundPaidCardPurchase(book, 'editor', input).duplicate, true);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).refunds[0].amount, 2000);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).remainingAmount, 10000);
    assert.equal(book.entries().length, 5);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP refund form enforces roles and CSRF, explains card credit, escapes history and removes the form on full refund', async () => {
  const { book, plan } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  try {
    const before = await (await fetch(`${base}/cancel?planId=${plan.id}`)).text();
    assert.match(before, /action="\/admin\/cards\/refund"/); assert.match(before, /현금 입금을 기록하지 않습니다/);
    assert.match(before, /min="2027-01-25"/);
    const input = { ...request(book, plan, '12000'), csrf: 'token', reason: '<환불 & 확인>' };
    const send = values => fetch(`${base}/refund`, { method: 'POST', body: new URLSearchParams(values) });
    assert.equal((await send({ ...input, csrf: 'wrong' })).status, 403);
    sub = 'viewer'; assert.equal((await send(input)).status, 400);
    sub = 'editor'; const response = await send(input); assert.equal(response.status, 200);
    const after = await response.text(); assert.match(after, /카드대금 차감 환불 이력/); assert.match(after, /&lt;환불 &amp; 확인&gt;/);
    assert.doesNotMatch(after, /action="\/admin\/cards\/refund"/); assert.match(after, /남은 구매 금액: 0원/);
    assert.equal((await send(input)).status, 200);
    assert.match(await (await fetch(`${base}`)).text(), /전액 환불 완료/);
    sub = 'viewer'; assert.match(await (await fetch(`${base}/cancel?planId=${plan.id}`)).text(), /카드대금 차감 환불 이력/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
