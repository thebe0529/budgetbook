import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordCardPurchase, recordCardPayment } from '../src/card-manual.js';
import { cardCancellationPreview, partiallyCancelCardPurchase, cancelCardPurchase } from '../src/card-cancellation.js';
import { refundPaidCardPurchase } from '../src/card-refund.js';
import { cardRefundReceiptPreview } from '../src/card-refund-receipt.js';
import { cardReductionPreview } from '../src/card-reduction-preview.js';
import { createImportApi } from '../src/import-api.js';

function fixture(paidCount = 0) {
  const book = new Book(); ensureOwner(book, 'owner');
  book.createAccount({ id: 'card', name: '<카드 & 이름>', type: 'liability', card: true, onBudget: true });
  book.createAccount({ id: 'cash', name: '은행', type: 'asset', cash: true });
  book.createAccount({ id: 'expense', name: '비용', type: 'expense' });
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['card', 'cash']);
  setMember(book, 'owner', 'viewer', 'viewer', ['card']);
  const plan = recordCardPurchase(book, 'editor', { requestId: randomUUID(), date: '2026-10-10', cardId: 'card', expenseId: 'expense',
    amountExpression: '12000', count: '3', firstDueDate: '2026-11-25', categoryId: 'food' }).plan;
  for (let index = 1; index <= paidCount; index++) recordCardPayment(book, 'editor', { planId: plan.id, index, date: '2026-11-25', cashId: 'cash' });
  return { book, plan };
}
const input = (book, plan, amountExpression = '2000') => ({ planId: plan.id, requestId: randomUUID(), date: '2026-12-01',
  reason: '<검토 & 확인>', amountExpression, expectedHash: cardCancellationPreview(book, 'editor', plan.id).expectedHash });
const changes = book => book.db.prepare('SELECT total_changes() AS n').get().n;

test('all partial allocation previews are read-only and match the subsequently committed installment schedule', () => {
  for (const [distributionMode, expected] of [['equal', [2334, 2333, 2333]], ['earliest-first', [0, 3000, 4000]],
    ['latest-first', [4000, 3000, 0]], ['manual', [3000, 4000, 0]]]) {
    const { book, plan } = fixture();
    try {
      const data = { ...input(book, plan, '5000'), distributionMode,
        ...(distributionMode === 'manual' ? { deductions: [{ index: 1, amountExpression: '1000' }, { index: 3, amountExpression: '4000' }] } : {}) };
      const count = changes(book); const before = book.cardPlan(plan.id); const budget = book.budget('2026-12');
      const preview = cardReductionPreview(book, 'editor', 'partial', data);
      assert.deepEqual(preview.afterInstallments.map(i => i.amount), expected);
      assert.equal(preview.unpaidReduction, 5000); assert.equal(preview.creditAmount, 0); assert.equal(preview.remainingAfter, 7000);
      assert.equal(changes(book), count); assert.deepEqual(book.cardPlan(plan.id), before); assert.deepEqual(book.budget('2026-12'), budget);
      partiallyCancelCardPurchase(book, 'editor', preview.input);
      assert.deepEqual(book.cardPlan(plan.id).installments, preview.afterInstallments);
      assert.equal(book.budget('2026-12').categories.food.spent, -preview.amount);
    } finally { book.close(); }
  }
});

test('mixed and fully paid refund previews preserve paid amounts and predict the exact cash receipt limit', () => {
  for (const paidCount of [1, 3]) {
    const { book, plan } = fixture(paidCount);
    try {
      const count = changes(book); const data = input(book, plan, '10000'); const before = book.cardPlan(plan.id);
      const preview = cardReductionPreview(book, 'editor', 'refund', data);
      assert.equal(changes(book), count);
      assert.equal(preview.unpaidReduction, paidCount === 1 ? 8000 : 0);
      assert.equal(preview.creditAmount, paidCount === 1 ? 2000 : 10000);
      assert.deepEqual(preview.afterInstallments.filter(i => i.paidEntryId), before.installments.filter(i => i.paidEntryId));
      if (paidCount === 1) assert.throws(() => refundPaidCardPurchase(book, 'editor', preview.input), /Confirm/);
      refundPaidCardPurchase(book, 'editor', { ...preview.input, confirmUnpaidFirst: true });
      assert.deepEqual(book.cardPlan(plan.id).installments, preview.afterInstallments);
      assert.equal(cardRefundReceiptPreview(book, 'editor', data.requestId).receiptLimit, preview.creditAmount);
    } finally { book.close(); }
  }
});

test('previews reject invalid permissions, dates, limits, deductions, locks and stale purchase state without writes', () => {
  const { book, plan } = fixture();
  try {
    const data = input(book, plan); const count = changes(book);
    for (const bad of [{ amountExpression: '0' }, { amountExpression: '12000' }, { date: '2026-10-09' }, { reason: '' }, { requestId: 'bad' },
      { distributionMode: 'manual', deductions: [{ index: 1, amountExpression: '1999' }] }]) {
      assert.throws(() => cardReductionPreview(book, 'editor', 'partial', { ...data, ...bad }));
    }
    assert.throws(() => cardReductionPreview(book, 'viewer', 'partial', data), /author or owner/);
    assert.throws(() => cardReductionPreview(book, 'editor', 'refund', data), /paid purchase/);
    assert.equal(changes(book), count);
    book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run('card', data.date, '{}');
    const lockedCount = changes(book);
    assert.throws(() => cardReductionPreview(book, 'editor', 'partial', data), /locked/); assert.equal(changes(book), lockedCount);
    book.db.prepare('DELETE FROM account_period_locks').run();
    partiallyCancelCardPurchase(book, 'editor', input(book, plan));
    assert.throws(() => cardReductionPreview(book, 'editor', 'partial', data), /changed/);
    const fresh = input(book, plan); cancelCardPurchase(book, 'editor', fresh);
    assert.throws(() => cardReductionPreview(book, 'editor', 'partial', input(book, plan)), /cancelled/);
  } finally { book.close(); }
});

function confirmationForm(html) {
  const unescape = value => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  return new URLSearchParams([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)]
    .map(([, name, value]) => [unescape(name), unescape(value)]));
}

test('HTTP partial preview escapes content, preserves the request and commits only after explicit save', async () => {
  const { book, plan } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards/cancel-partial`;
  try {
    const data = { ...input(book, plan, '1000+1000'), csrf: 'token', distributionMode: 'manual', 'deduction:1': '2000' };
    const send = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: body instanceof URLSearchParams ? body : new URLSearchParams(body) });
    assert.equal((await send('/preview', { ...data, csrf: 'bad' })).status, 403);
    sub = 'viewer'; assert.equal((await send('/preview', data)).status, 400); sub = 'editor';
    const count = changes(book); const response = await send('/preview', data); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /아직 저장하지 않았습니다/); assert.match(html, /&lt;검토 &amp; 확인&gt;/);
    assert.match(html, /&lt;카드 &amp; 이름&gt;/); assert.match(html, /계좌 입금 기록 한도: 0원/);
    assert.equal(changes(book), count);
    const confirmation = confirmationForm(html);
    assert.equal(confirmation.get('requestId'), data.requestId); assert.equal(confirmation.get('expectedHash'), data.expectedHash);
    assert.equal(confirmation.get('amountExpression'), '2000'); assert.equal(confirmation.get('deduction:1'), '2000');
    setMember(book, 'owner', 'editor', 'editor', []); assert.equal((await send('', confirmation)).status, 400);
    setMember(book, 'owner', 'editor', 'editor', ['card', 'cash']);
    book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run('card', data.date, '{}');
    assert.equal((await send('', confirmation)).status, 400); assert.equal(book.entries().length, 1);
    book.db.prepare('DELETE FROM account_period_locks').run();
    assert.equal((await send('', confirmation)).status, 200); assert.equal((await send('', confirmation)).status, 200);
    assert.deepEqual(book.cardPlan(plan.id).installments.map(i => i.amount), [2000, 4000, 4000]); assert.equal(book.entries().length, 2);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('HTTP mixed refund preview requires confirmation at save and detects a payment made after the preview', async () => {
  const { book, plan } = fixture(1);
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'editor', role: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards/refund`;
  try {
    const send = (path, body) => fetch(`${base}${path}`, { method: 'POST', body: body instanceof URLSearchParams ? body : new URLSearchParams(body) });
    const count = changes(book); const response = await send('/preview', { ...input(book, plan, '10000'), csrf: 'token' });
    assert.equal(response.status, 200); const html = await response.text(); assert.equal(changes(book), count);
    assert.match(html, /미납 감소 8,000원/); assert.match(html, /계좌 입금 기록 한도: 2,000원/); assert.match(html, /납부 보존/);
    const confirmation = confirmationForm(html); assert.equal((await send('', confirmation)).status, 400);
    confirmation.set('confirmUnpaidFirst', 'true');
    recordCardPayment(book, 'editor', { planId: plan.id, index: 2, date: '2026-12-01', cashId: 'cash' });
    assert.equal((await send('', confirmation)).status, 400); assert.equal(book.db.prepare('SELECT count(*) AS n FROM card_refunds').get().n, 0);
    const fresh = await send('/preview', { ...input(book, plan, '10000'), csrf: 'token' }); assert.equal(fresh.status, 200);
    const freshHtml = await fresh.text(); assert.match(freshHtml, /계좌 입금 기록 한도: 6,000원/);
    const newConfirmation = confirmationForm(freshHtml); newConfirmation.set('confirmUnpaidFirst', 'true');
    assert.equal((await send('', newConfirmation)).status, 200);
    assert.equal(cardRefundReceiptPreview(book, 'editor', newConfirmation.get('requestId')).receiptLimit, 6000);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
