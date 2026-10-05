import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordCardPurchase, recordCardPayment } from '../src/card-manual.js';
import { cardCancellationPreview, cancelCardPurchase } from '../src/card-cancellation.js';
import { refundPaidCardPurchase } from '../src/card-refund.js';
import { cardRefundReceiptPreview, recordCardRefundReceipt } from '../src/card-refund-receipt.js';
import { forecast } from '../src/forecast.js';
import { createImportApi } from '../src/import-api.js';

function fixture(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  book.createAccount({ id: 'card', name: '카드', type: 'liability', card: true, onBudget: true });
  book.createAccount({ id: 'cash', name: '비공개 환급은행', type: 'asset', cash: true });
  book.createAccount({ id: 'cash2', name: '은행2', type: 'asset', cash: true });
  book.createAccount({ id: 'expense', name: '비용', type: 'expense' });
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['card', 'cash', 'cash2']);
  setMember(book, 'owner', 'other', 'editor', ['card', 'cash']);
  setMember(book, 'owner', 'viewer', 'viewer', ['card']);
  const plan = recordCardPurchase(book, 'editor', { requestId: randomUUID(), date: '2026-10-10', cardId: 'card', expenseId: 'expense',
    amountExpression: '12000', count: '1', firstDueDate: '2026-11-25', categoryId: 'food' }).plan;
  recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date: '2026-11-25', cashId: 'cash' });
  const refund = { requestId: randomUUID(), planId: plan.id, date: '2026-12-01', reason: '반품', amountExpression: '12000',
    expectedHash: cardCancellationPreview(book, 'editor', plan.id).expectedHash };
  refundPaidCardPurchase(book, 'editor', refund);
  return { book, plan, refund };
}
const request = (book, refund, amountExpression = '5000') => ({ requestId: randomUUID(), refundId: refund.requestId,
  cashId: 'cash', date: '2026-12-02', reason: '환급 입금', amountExpression,
  expectedHash: cardRefundReceiptPreview(book, 'editor', refund.requestId).expectedHash });

test('cash receipt increases cash and clears card credit without repeating expense or budget refunds', () => {
  const { book, plan, refund } = fixture();
  try {
    const before = book.entries(); const savedPlan = book.cardPlan(plan.id); const input = request(book, refund, '12000');
    const result = recordCardRefundReceipt(book, 'editor', input);
    assert.deepEqual(book.entries().slice(0, 3), before); assert.deepEqual(book.cardPlan(plan.id), savedPlan);
    assert.equal(result.entry.kind, 'card-refund-receipt'); assert.equal(result.entry.budgetAllocations, undefined);
    assert.equal(book.reports('2026-12-01', '2026-12-31').incomeStatement.expenses, -12000);
    assert.equal(book.budget('2026-12').categories.food.spent, -12000);
    assert.equal(book.reports('2026-12-01', '2026-12-31').cashFlow.netChange, 12000);
    assert.equal(book.reports('2026-12-01', '2026-12-31').balanceSheet.accounts.cash, 0);
    assert.equal(book.reports('2026-12-01', '2026-12-31').balanceSheet.liabilities, 0);
    assert.equal(cardRefundReceiptPreview(book, 'editor', refund.requestId).remaining, 0);
    assert.equal(recordCardRefundReceipt(book, 'editor', input).duplicate, true);
    assert.equal(refundPaidCardPurchase(book, 'editor', refund).duplicate, true);
    assert.equal(book.entries().length, 4);
    assert.throws(() => book.db.prepare('UPDATE entries SET data = data WHERE id = ?').run(result.entry.id), /cannot be changed/);
    assert.throws(() => book.db.prepare('DELETE FROM entries WHERE id = ?').run(result.entry.id), /cannot be changed/);
    assert.equal(forecast(book, 'owner', { asOf: '2026-12-01', throughDate: '2026-12-31' }).events.find(e => e.type === 'booked').amount, 12000);
  } finally { book.close(); }
});

test('split receipts cap each refund, detect stale state and keep replay receipts after completion', () => {
  const { book, plan, refund } = fixture();
  try {
    const first = request(book, refund); recordCardRefundReceipt(book, 'editor', first);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', { ...first, requestId: randomUUID() }), /changed/);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', { ...first, reason: '다른 메모' }), /reused/);
    assert.throws(() => refundPaidCardPurchase(book, 'editor', { ...refund, requestId: first.requestId }), /reused/);
    assert.throws(() => cancelCardPurchase(book, 'editor', { ...refund, requestId: first.requestId }), /reused/);
    const second = { ...request(book, refund, '7000'), cashId: 'cash2', date: '2026-12-03' };
    recordCardRefundReceipt(book, 'editor', second);
    assert.equal(cardRefundReceiptPreview(book, 'editor', refund.requestId).received, 12000);
    assert.equal(cardRefundReceiptPreview(book, 'editor', refund.requestId).receipts.length, 2);
    assert.equal(recordCardRefundReceipt(book, 'editor', first).duplicate, true);
    assert.equal(recordCardRefundReceipt(book, 'editor', second).duplicate, true);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', { ...request(book, refund, '1'), date: '2026-12-04' }), /exceeds/);
    assert.equal(book.entries().length, 5);
  } finally { book.close(); }
});

test('receipt validates amount, chronological dates, cash account and both current write permissions', () => {
  const { book, refund } = fixture();
  try {
    const input = request(book, refund);
    for (const bad of [{ date: '2026-11-30' }, { date: '2026-02-30' }, { reason: '' }, { reason: 'x'.repeat(201) },
      { amountExpression: '0' }, { amountExpression: '-1' }, { amountExpression: '12001' }, { amountExpression: '1/0' }, { requestId: 'bad' }]) {
      assert.throws(() => recordCardRefundReceipt(book, 'editor', { ...input, ...bad }));
    }
    assert.throws(() => recordCardRefundReceipt(book, 'other', input), /author or owner/);
    assert.throws(() => recordCardRefundReceipt(book, 'viewer', input), /write access/);
    assert.throws(() => recordCardRefundReceipt(book, 'owner', { ...input, cashId: 'expense' }), /cash asset/);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', { ...input, requestId: refund.requestId }), /reused/);
    setMember(book, 'owner', 'editor', 'editor', ['card']);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', input), /cash write access/);
    setMember(book, 'owner', 'editor', 'editor', ['cash']);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', input), /read access/);
    recordCardRefundReceipt(book, 'owner', input);
    assert.throws(() => recordCardRefundReceipt(book, 'owner', { ...input, requestId: randomUUID(), expectedHash: cardRefundReceiptPreview(book, 'owner', refund.requestId).expectedHash, date: '2026-12-01' }), /previous receipt/);
  } finally { book.close(); }
});

test('either account lock and audit failure roll back both postings and receipt audit', () => {
  const { book, refund } = fixture();
  try {
    const input = request(book, refund);
    for (const id of ['card', 'cash']) {
      book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run(id, input.date, '{}');
      assert.throws(() => recordCardRefundReceipt(book, 'editor', input), /locked/);
      assert.equal(book.entries().length, 3);
      book.db.prepare('DELETE FROM account_period_locks WHERE account_id = ?').run(id);
    }
    book.db.exec("CREATE TRIGGER fail_receipt BEFORE INSERT ON card_refund_receipts BEGIN SELECT RAISE(ABORT, 'receipt audit failure'); END;");
    assert.throws(() => recordCardRefundReceipt(book, 'editor', input), /audit failure/);
    assert.equal(book.entries().length, 3);
    assert.equal(cardRefundReceiptPreview(book, 'editor', refund.requestId).remaining, 12000);
    book.db.exec('DROP TRIGGER fail_receipt');
    assert.equal(recordCardRefundReceipt(book, 'editor', input).duplicate, false);
  } finally { book.close(); }
});

test('receipt limits, history and idempotency persist across database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-refund-receipt-')); const file = join(dir, 'book.sqlite'); let book;
  try {
    const setup = fixture(file); book = setup.book; const { refund } = setup;
    const input = request(book, refund); recordCardRefundReceipt(book, 'editor', input);
    book.close(); book = new Book(file);
    assert.equal(recordCardRefundReceipt(book, 'editor', input).duplicate, true);
    assert.equal(cardRefundReceiptPreview(book, 'editor', refund.requestId).remaining, 7000);
    setMember(book, 'owner', 'editor', 'editor', ['card']);
    assert.throws(() => recordCardRefundReceipt(book, 'editor', input), /cash write access/);
    const restricted = cardRefundReceiptPreview(book, 'viewer', refund.requestId).receipts[0];
    assert.deepEqual(restricted, { restricted: true, amount: 5000, date: '2026-12-02' });
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP receipt requires actual-deposit confirmation and CSRF, escapes history and masks inaccessible bank details', async () => {
  const { book, plan, refund } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  try {
    const page = await (await fetch(`${base}/refund-receipt?refundId=${refund.requestId}`)).text();
    assert.match(page, /비용·예산을 다시 되돌리지 않습니다/); assert.match(page, /name="confirmed"/);
    assert.match(await (await fetch(`${base}/cancel?planId=${plan.id}`)).text(), /입금 기록·이력/);
    const input = { ...request(book, refund, '12000'), reason: '<입금 & 확인>', csrf: 'token', confirmed: 'true' };
    const send = data => fetch(`${base}/refund-receipt`, { method: 'POST', body: new URLSearchParams(data) });
    assert.equal((await send({ ...input, csrf: 'wrong' })).status, 403);
    assert.equal((await send({ ...input, confirmed: 'false' })).status, 400);
    sub = 'viewer'; assert.equal((await send(input)).status, 400);
    sub = 'editor'; const response = await send(input); assert.equal(response.status, 200);
    const after = await response.text(); assert.match(after, /&lt;입금 &amp; 확인&gt;/); assert.match(after, /전액을 계좌 입금으로 기록/);
    assert.doesNotMatch(after, /action="\/admin\/cards\/refund-receipt"/);
    assert.equal((await send(input)).status, 200);
    sub = 'viewer'; const read = await (await fetch(`${base}/refund-receipt?refundId=${refund.requestId}`)).text();
    assert.match(read, /계좌 접근 제한/); assert.doesNotMatch(read, /비공개 환급은행|입금 &amp; 확인|name="cashId"/);
    assert.equal(book.entries().length, 4);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
