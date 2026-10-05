import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount } from '../src/manual.js';
import { firstCardBillingDate, firstCardDueDate, cardBillingDates, cardBillingRule, setCardBillingRule } from '../src/card-billing.js';
import { recordCardPurchase } from '../src/card-manual.js';
import { createImportApi } from '../src/import-api.js';

const rule = { closingDay: 15, paymentDay: 25, paymentMonthOffset: 0 };
function fixture(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability', card: true, onBudget: true });
  const expense = createLedgerAccount(book, 'owner', { name: '비용', type: 'expense' });
  setMember(book, 'owner', 'editor', 'editor', [card.id]);
  setMember(book, 'owner', 'viewer', 'viewer', []);
  return { book, card, expense };
}

test('billing cutoff is inclusive and supports same, next and second-next payment months', () => {
  assert.equal(firstCardDueDate('2026-10-15', rule), '2026-10-25');
  assert.equal(firstCardDueDate('2026-10-16', rule), '2026-11-25');
  assert.equal(firstCardDueDate('2026-12-16', rule), '2027-01-25');
  assert.equal(firstCardDueDate('2026-10-15', { ...rule, paymentMonthOffset: 1, paymentDay: 10 }), '2026-11-10');
  assert.equal(firstCardDueDate('2026-10-16', { ...rule, paymentMonthOffset: 2 }), '2027-01-25');
  for (const bad of [{ ...rule, closingDay: 0 }, { ...rule, paymentDay: 32 }, { ...rule, closingDay: 1.5 },
    { ...rule, paymentMonthOffset: 3 }, { ...rule, paymentMonthOffset: -1 }, { ...rule, paymentDay: 15 }]) {
    assert.throws(() => firstCardDueDate('2026-10-10', bad));
  }
  assert.throws(() => firstCardDueDate('2026-02-30', rule));
});

test('billing dates clamp short months and retain the configured day across leap years and date boundaries', () => {
  const monthEnd = { closingDay: 31, paymentDay: 31, paymentMonthOffset: 1 };
  assert.equal(firstCardDueDate('2028-02-29', monthEnd), '2028-03-31');
  assert.equal(firstCardDueDate('2027-01-31', monthEnd), '2027-02-28');
  assert.deepEqual(cardBillingDates('2027-02-28', 3, monthEnd), ['2027-02-28', '2027-03-31', '2027-04-30']);
  assert.deepEqual(cardBillingDates('2028-01-31', 3, monthEnd), ['2028-01-31', '2028-02-29', '2028-03-31']);
  assert.equal(firstCardDueDate('0004-01-31', monthEnd), '0004-02-29');
  assert.throws(() => firstCardDueDate('9999-12-31', monthEnd), /supported dates/);
  assert.throws(() => cardBillingDates('9999-12-31', 2, monthEnd), /supported dates/);
});

test('weekend adjustment handles Saturday and Sunday without shifting the billing month anchor', () => {
  const end = { closingDay: 31, paymentDay: 31, paymentMonthOffset: 1, weekendAdjustment: 'next' };
  assert.equal(firstCardBillingDate('2026-12-31', end), '2027-01-31');
  assert.equal(firstCardDueDate('2026-12-31', end), '2027-02-01');
  assert.deepEqual(cardBillingDates('2027-01-31', 3, end), ['2027-02-01', '2027-03-01', '2027-03-31']);
  const first = { closingDay: 15, paymentDay: 1, paymentMonthOffset: 1, weekendAdjustment: 'previous' };
  assert.equal(firstCardDueDate('2026-02-10', first), '2026-02-27');
  assert.deepEqual(cardBillingDates('2026-03-01', 3, first), ['2026-02-27', '2026-04-01', '2026-05-01']);
  assert.equal(firstCardDueDate('2026-02-10', { ...first, weekendAdjustment: 'next' }), '2026-03-02');
  assert.equal(firstCardDueDate('2027-12-10', first), '2027-12-31');
  assert.equal(firstCardDueDate('2027-12-10', { ...first, weekendAdjustment: 'next' }), '2028-01-03');
  const saturday = { closingDay: 15, paymentDay: 28, paymentMonthOffset: 0 };
  assert.equal(firstCardDueDate('2026-02-10', { ...saturday, weekendAdjustment: 'next' }), '2026-03-02');
  assert.equal(firstCardDueDate('2026-02-10', { ...saturday, weekendAdjustment: 'previous' }), '2026-02-27');
  assert.equal(firstCardDueDate('2026-02-10', { ...saturday, weekendAdjustment: 'none' }), '2026-02-28');
  assert.throws(() => firstCardDueDate('2026-02-28', { closingDay: 30, paymentDay: 31,
    paymentMonthOffset: 0, weekendAdjustment: 'previous' }), /precedes purchase/);
  for (const weekendAdjustment of ['', 'holiday', 1]) assert.throws(() => firstCardDueDate('2026-02-10', { ...first, weekendAdjustment }), /weekend/);
});

test('weekend-adjusted purchases snapshot settings, preserve amounts and replay legacy rules', () => {
  const { book, card, expense } = fixture();
  try {
    const input = { requestId: randomUUID(), date: '2026-12-31', cardId: card.id, expenseId: expense.id,
      amountExpression: '10001', count: '3', firstDueDate: '' };
    const end = { closingDay: 31, paymentDay: 31, paymentMonthOffset: 1 };
    setCardBillingRule(book, 'owner', card.id, end);
    const old = recordCardPurchase(book, 'editor', input).plan;
    setCardBillingRule(book, 'owner', card.id, { ...end, weekendAdjustment: 'next' });
    assert.equal(recordCardPurchase(book, 'editor', input).duplicate, true);
    assert.equal(old.installments[0].dueDate, '2027-01-31');
    const newInput = { ...input, requestId: randomUUID() };
    const plan = recordCardPurchase(book, 'editor', newInput).plan;
    assert.deepEqual(plan.installments.map(i => i.dueDate), ['2027-02-01', '2027-03-01', '2027-03-31']);
    assert.deepEqual(plan.installments.map(i => i.amount), [3334, 3334, 3333]);
    assert.equal(plan.billingRule.weekendAdjustment, 'next');
    setCardBillingRule(book, 'owner', card.id, { ...end, weekendAdjustment: 'previous' });
    assert.equal(recordCardPurchase(book, 'editor', newInput).duplicate, true);
    const manual = recordCardPurchase(book, 'editor', { ...input, requestId: randomUUID(), firstDueDate: '2027-01-31' }).plan;
    assert.equal(manual.installments[0].dueDate, '2027-01-31'); assert.equal(manual.billingRule, undefined);
    setCardBillingRule(book, 'owner', card.id, { closingDay: 30, paymentDay: 31, paymentMonthOffset: 0, weekendAdjustment: 'previous' });
    assert.throws(() => recordCardPurchase(book, 'editor', { ...input, requestId: randomUUID(), date: '2026-02-28' }), /precedes purchase/);
    assert.equal(book.entries().length, 3);
    assert.equal(book.reports('2026-12-01', '2026-12-31').incomeStatement.expenses, 30003);
  } finally { book.close(); }
});

test('billing rules require owner writes and account reads and persist across database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budgetbook-billing-')); const file = join(dir, 'book.sqlite');
  let book; let card;
  try {
    ({ book, card } = fixture(file));
    assert.throws(() => setCardBillingRule(book, 'editor', card.id, rule), /Owner/);
    assert.throws(() => setCardBillingRule(book, 'owner', 'missing', rule), /card liability/);
    setCardBillingRule(book, 'owner', card.id, rule);
    assert.deepEqual(cardBillingRule(book, 'editor', card.id), rule);
    assert.throws(() => cardBillingRule(book, 'viewer', card.id), /read access/);
    assert.throws(() => setCardBillingRule(book, 'owner', card.id, { ...rule, paymentDay: 1 }));
    setCardBillingRule(book, 'owner', card.id, { ...rule, weekendAdjustment: 'next' });
    book.close(); book = new Book(file);
    assert.deepEqual(cardBillingRule(book, 'owner', card.id), { ...rule, weekendAdjustment: 'next' });
    setCardBillingRule(book, 'owner', card.id, null);
    assert.equal(cardBillingRule(book, 'owner', card.id), null);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('automatic purchases snapshot rules, retain monthly day and remain idempotent after settings change or removal', () => {
  const { book, card, expense } = fixture();
  try {
    const input = { requestId: randomUUID(), date: '2027-01-31', cardId: card.id, expenseId: expense.id,
      amountExpression: '10001', count: '3', firstDueDate: '' };
    assert.throws(() => recordCardPurchase(book, 'editor', input), /billing rule/);
    const end = { closingDay: 31, paymentDay: 31, paymentMonthOffset: 1 };
    setCardBillingRule(book, 'owner', card.id, end);
    const { plan } = recordCardPurchase(book, 'editor', input);
    assert.deepEqual(plan.installments.map(i => i.dueDate), ['2027-02-28', '2027-03-31', '2027-04-30']);
    assert.deepEqual(plan.installments.map(i => i.amount), [3334, 3334, 3333]);
    assert.deepEqual(plan.billingRule, end);
    setCardBillingRule(book, 'owner', card.id, rule);
    assert.equal(recordCardPurchase(book, 'editor', input).duplicate, true);
    setCardBillingRule(book, 'owner', card.id, null);
    assert.equal(recordCardPurchase(book, 'editor', input).duplicate, true);
    assert.throws(() => recordCardPurchase(book, 'editor', { ...input, amountExpression: '20000' }), /reused/);
    assert.throws(() => recordCardPurchase(book, 'viewer', input), /write access/);
    assert.equal(book.entries().length, 1);
    assert.equal(book.reports('2027-01-01', '2027-01-31').incomeStatement.expenses, 10001);
    const manual = recordCardPurchase(book, 'editor', { ...input, requestId: randomUUID(), firstDueDate: '2027-03-10' }).plan;
    assert.equal(manual.billingRule, undefined);
    assert.equal(manual.installments[0].dueDate, '2027-03-10');
    setCardBillingRule(book, 'owner', card.id, end);
    assert.throws(() => recordCardPurchase(book, 'editor', { ...input, requestId: randomUUID(), date: '9999-10-31' }), /supported dates/);
    assert.equal(book.entries().length, 2);
    const early = recordCardPurchase(book, 'editor', { ...input, requestId: randomUUID(), date: '0004-01-31' }).plan;
    assert.deepEqual(early.installments.map(i => i.dueDate), ['0004-02-29', '0004-03-31', '0004-04-30']);
  } finally { book.close(); }
});

test('billing settings and preview HTTP routes enforce CSRF and permissions and automatic form submission', async () => {
  const { book, card, expense } = fixture(); let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  const values = { csrf: 'token', cardId: card.id, throughDate: '2027-12-31', closingDay: '15', paymentDay: '25', paymentMonthOffset: '0', action: 'save' };
  const send = (path, input) => fetch(`${base}/${path}`, { method: 'POST', body: new URLSearchParams(input) });
  try {
    assert.equal((await send('billing-rule', { ...values, csrf: 'wrong' })).status, 403);
    sub = 'editor'; assert.equal((await send('billing-rule', values)).status, 400);
    sub = 'owner'; assert.equal((await send('billing-rule', values)).status, 200);
    assert.equal((await send('billing-rule', { ...values, paymentDay: '1' })).status, 400);
    assert.equal((await send('billing-rule', { ...values, paymentMonthOffset: '' })).status, 400);
    const preview = await fetch(`${base}?throughDate=2027-12-31&previewCardId=${card.id}&purchaseDate=2026-10-16`);
    assert.equal(preview.status, 200); const html = await preview.text();
    assert.match(html, /첫 결제 예정일: 2026-11-25/); assert.match(html, /주말: 조정 없음, 공휴일 조정 없음/);
    assert.match(html, /name="date" value="2026-10-16" required/);
    assert.doesNotMatch(html, /name="firstDueDate" required/);
    sub = 'viewer'; assert.equal((await fetch(`${base}?previewCardId=${card.id}&purchaseDate=2026-10-16`)).status, 400);
    sub = 'editor';
    const response = await send('purchase', { csrf: 'token', requestId: randomUUID(), cardId: card.id,
      date: '2026-10-16', expenseId: expense.id, amountExpression: '100', count: '1', firstDueDate: '' });
    assert.equal(response.status, 200); assert.match(await response.text(), /2026-11-25/);
    sub = 'owner'; assert.equal((await send('billing-rule', { ...values, action: 'clear' })).status, 200);
    assert.equal(cardBillingRule(book, 'owner', card.id), null);
    assert.equal(book.entries().length, 1);
    assert.equal((await send('billing-rule', { ...values, closingDay: '31', paymentDay: '31', paymentMonthOffset: '1', weekendAdjustment: 'invalid' })).status, 400);
    const adjusted = await send('billing-rule', { ...values, closingDay: '31', paymentDay: '31', paymentMonthOffset: '1', weekendAdjustment: 'next' });
    assert.equal(adjusted.status, 200); assert.match(await adjusted.text(), /value="next" selected/);
    const weekendPreview = await fetch(`${base}?previewCardId=${card.id}&purchaseDate=2026-12-31`);
    const weekendHtml = await weekendPreview.text();
    assert.match(weekendHtml, /첫 결제 예정일: 2027-02-01/); assert.match(weekendHtml, /주말: 다음 평일/);
    assert.equal(cardBillingRule(book, 'owner', card.id).weekendAdjustment, 'next');
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
