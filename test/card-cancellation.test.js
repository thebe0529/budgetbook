import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordCardPurchase, recordCardPayment, recordCardPaymentBatch } from '../src/card-manual.js';
import { cardCancellationPreview, cancelCardPurchase, visibleCardPurchases } from '../src/card-cancellation.js';
import { forecast } from '../src/forecast.js';
import { createImportApi } from '../src/import-api.js';

function fixture(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  book.createAccount({ id: 'card', name: '카드', type: 'liability', card: true, onBudget: true });
  book.createAccount({ id: 'cash', name: '은행', type: 'asset', cash: true });
  book.createAccount({ id: 'expense', name: '비용', type: 'expense' });
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['card', 'cash']);
  setMember(book, 'owner', 'other', 'editor', ['card']);
  setMember(book, 'owner', 'viewer', 'viewer', ['card']);
  const purchase = { requestId: randomUUID(), date: '2026-10-10', cardId: 'card', expenseId: 'expense',
    amountExpression: '12000', count: '3', firstDueDate: '2026-11-25', categoryId: 'food', memo: '<가족 & 식사>' };
  const plan = recordCardPurchase(book, 'editor', purchase).plan;
  return { book, plan, purchase };
}
const inputFor = (book, plan) => ({ planId: plan.id, date: '2026-11-01', reason: '주문 취소',
  expectedHash: cardCancellationPreview(book, 'editor', plan.id).expectedHash, requestId: randomUUID() });

test('unpaid card cancellation reverses liability, expense and budget in cancellation month and removes forecast dues', () => {
  const { book, plan, purchase } = fixture();
  try {
    const original = book.entries()[0]; const input = inputFor(book, plan);
    const forecastArgs = { asOf: '2026-10-10', throughDate: '2027-02-01', cardCashId: 'cash' };
    assert.equal(forecast(book, 'owner', forecastArgs).events.filter(e => e.type === 'card').length, 3);
    const result = cancelCardPurchase(book, 'editor', input);
    assert.equal(result.duplicate, false); assert.deepEqual(book.entries()[0], original);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.expenses, 12000);
    assert.equal(book.reports('2026-11-01', '2026-11-30').incomeStatement.expenses, -12000);
    assert.equal(book.reports('2026-11-01', '2026-11-30').balanceSheet.liabilities, 0);
    assert.equal(book.budget('2026-10').categories.food.spent, 12000);
    assert.equal(book.budget('2026-11').categories.food.spent, -12000);
    assert.equal(book.reports('2026-11-01', '2026-11-30').cashFlow.netChange, 0);
    assert.deepEqual(book.pendingCardPayments('9999-12-31'), []);
    assert.equal(forecast(book, 'owner', forecastArgs).events.filter(e => e.type === 'card').length, 0);
    assert.equal(cardCancellationPreview(book, 'viewer', plan.id).cancellation.actor, 'editor');
    assert.equal(visibleCardPurchases(book, 'viewer')[0].cancellation.reason, '주문 취소');
    assert.equal(cancelCardPurchase(book, 'editor', input).duplicate, true);
    assert.equal(recordCardPurchase(book, 'editor', purchase).duplicate, true);
    assert.equal(book.entries().length, 2);
    assert.throws(() => cancelCardPurchase(book, 'editor', { ...input, requestId: randomUUID() }), /already cancelled/);
    assert.throws(() => cancelCardPurchase(book, 'editor', { ...input, reason: '다른 사유' }), /reused/);
    assert.throws(() => book.payInstallment({ planId: plan.id, index: 1, date: '2026-11-25', cashId: 'cash' }), /cancelled/);
    for (const id of [original.id, result.entry.id]) {
      assert.throws(() => book.db.prepare('UPDATE entries SET data = data WHERE id = ?').run(id), /cannot be changed/);
      assert.throws(() => book.db.prepare('DELETE FROM entries WHERE id = ?').run(id), /cannot be changed/);
    }
    assert.throws(() => book.db.prepare('UPDATE card_plans SET data = data WHERE id = ?').run(plan.id), /cannot be changed/);
    assert.throws(() => book.db.prepare('DELETE FROM card_plans WHERE id = ?').run(plan.id), /cannot be changed/);
  } finally { book.close(); }
});

test('cancellation checks current author permissions, request identity, date, reason and stale purchase state', () => {
  const { book, plan } = fixture();
  try {
    const input = inputFor(book, plan);
    assert.throws(() => cancelCardPurchase(book, 'other', input), /author or owner/);
    assert.throws(() => cancelCardPurchase(book, 'viewer', input), /author or owner/);
    for (const bad of [{ date: '2026-10-09' }, { date: '2026-02-30' }, { reason: ' ' }, { reason: 'x'.repeat(201) },
      { requestId: 'bad' }, { expectedHash: 'stale' }]) assert.throws(() => cancelCardPurchase(book, 'editor', { ...input, ...bad }));
    setMember(book, 'owner', 'editor', 'editor', []);
    assert.throws(() => cancelCardPurchase(book, 'editor', input), /read access/);
    assert.deepEqual(visibleCardPurchases(book, 'editor'), []);
    const modified = { ...plan, billingRule: { closingDay: 15, paymentDay: 25, paymentMonthOffset: 0 } };
    book.db.prepare('UPDATE card_plans SET data = ? WHERE id = ?').run(JSON.stringify(modified), plan.id);
    assert.throws(() => cancelCardPurchase(book, 'owner', input), /changed/);
    const fresh = { ...input, expectedHash: cardCancellationPreview(book, 'owner', plan.id).expectedHash };
    cancelCardPurchase(book, 'owner', fresh);
    assert.equal(book.entries().length, 2);
  } finally { book.close(); }
});

test('paid installments block cancellation and cancelled plans roll back mixed batch payments', () => {
  const { book, plan, purchase } = fixture();
  try {
    const old = inputFor(book, plan);
    recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2026-11-25', cashId: 'cash' });
    assert.throws(() => cancelCardPurchase(book, 'editor', old), /refund workflow/);
    const cancelled = recordCardPurchase(book, 'editor', { ...purchase, requestId: randomUUID() }).plan;
    cancelCardPurchase(book, 'editor', inputFor(book, cancelled));
    const count = book.entries().length;
    assert.throws(() => recordCardPaymentBatch(book, 'editor', { requestId: randomUUID(), date: '2026-12-25', cashId: 'cash',
      items: [{ planId: plan.id, index: 2 }, { planId: cancelled.id, index: 1 }] }), /cancelled/);
    assert.equal(book.entries().length, count);
    assert.equal(book.cardPlan(plan.id).installments[1].paidEntryId, null);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM card_payment_batches').get().n, 0);
  } finally { book.close(); }
});

test('locked cancellation dates fail atomically and a later cancellation preserves the locked original period', () => {
  const { book, plan } = fixture();
  try {
    const input = inputFor(book, plan);
    book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run('card', '2026-11-01', '{}');
    assert.throws(() => cancelCardPurchase(book, 'editor', input), /locked/);
    assert.equal(book.entries().length, 1); assert.equal(book.cardPlan(plan.id).cancellationId, undefined);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM transaction_reversals').get().n, 0);
    cancelCardPurchase(book, 'editor', { ...input, date: '2026-11-02' });
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.expenses, 12000);
    assert.equal(cancelCardPurchase(book, 'editor', { ...input, date: '2026-11-02' }).duplicate, true);
  } finally { book.close(); }
});

test('failed cancellation audit rolls back the reversal and card schedule and permits retry', () => {
  const { book, plan } = fixture();
  try {
    const input = inputFor(book, plan);
    book.db.exec("CREATE TRIGGER fail_card_audit BEFORE INSERT ON transaction_reversals BEGIN SELECT RAISE(ABORT, 'audit failure'); END;");
    assert.throws(() => cancelCardPurchase(book, 'editor', input), /audit failure/);
    assert.equal(book.entries().length, 1); assert.equal(book.pendingCardPayments('2027-12-31').length, 3);
    assert.equal(book.cardPlan(plan.id).cancellationId, undefined);
    book.db.exec('DROP TRIGGER fail_card_audit');
    book.db.exec("CREATE TRIGGER fail_card_plan BEFORE UPDATE ON card_plans BEGIN SELECT RAISE(ABORT, 'plan failure'); END;");
    assert.throws(() => cancelCardPurchase(book, 'editor', input), /plan failure/);
    assert.equal(book.entries().length, 1);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM transaction_reversals').get().n, 0);
    assert.equal(book.pendingCardPayments('2027-12-31').length, 3);
    book.db.exec('DROP TRIGGER fail_card_plan');
    assert.equal(cancelCardPurchase(book, 'editor', input).duplicate, false);
  } finally { book.close(); }
});

test('cancellation state, immutable entries and idempotency survive database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-cancel-')); const file = join(dir, 'book.sqlite'); let book;
  try {
    const setup = fixture(file); book = setup.book; const { plan } = setup;
    const input = inputFor(book, plan); cancelCardPurchase(book, 'editor', input);
    book.close(); book = new Book(file);
    assert.equal(cancelCardPurchase(book, 'editor', input).duplicate, true);
    assert.equal(cardCancellationPreview(book, 'editor', plan.id).cancellation.reason, input.reason);
    assert.equal(book.pendingCardPayments('9999-12-31').length, 0);
    assert.throws(() => book.payInstallment({ planId: plan.id, index: 1, date: '2026-12-01', cashId: 'cash' }), /cancelled/);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('card cancellation HTTP preview escapes input, guards CSRF and roles, displays audit and removes payment actions', async () => {
  const { book, plan } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  try {
    const preview = await fetch(`${base}/cancel?planId=${plan.id}`); assert.equal(preview.status, 200);
    const html = await preview.text(); assert.match(html, /&lt;가족 &amp; 식사&gt;/);
    assert.match(html, /action="\/admin\/cards\/cancel"/);
    const input = { ...inputFor(book, plan), csrf: 'token', reason: '<취소 & 확인>' };
    const send = values => fetch(`${base}/cancel`, { method: 'POST', body: new URLSearchParams(values) });
    assert.equal((await send({ ...input, csrf: 'wrong' })).status, 403);
    sub = 'viewer'; const read = await (await fetch(`${base}/cancel?planId=${plan.id}`)).text();
    assert.doesNotMatch(read, /action="\/admin\/cards\/cancel"/); assert.equal((await send(input)).status, 400);
    sub = 'other'; assert.equal((await send(input)).status, 400);
    sub = 'editor'; const response = await send(input); assert.equal(response.status, 200);
    const after = await response.text(); assert.match(after, /취소 이력/); assert.match(after, /&lt;취소 &amp; 확인&gt;/);
    assert.doesNotMatch(after, /action="\/admin\/cards\/cancel"/);
    assert.equal((await send(input)).status, 200);
    const cards = await (await fetch(`${base}?throughDate=2027-12-31`)).text();
    assert.match(cards, /취소 완료/); assert.doesNotMatch(cards, /action="\/admin\/cards\/pay"/);
    assert.equal(book.entries().length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
