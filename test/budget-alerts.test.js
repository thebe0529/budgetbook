import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual } from '../src/manual.js';
import { recordSplitManual } from '../src/split-manual.js';
import { budgetOverspending, budgetCategoryActivity, budgetCategoryActivityCsv } from '../src/budget-alerts.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { updateSelectedCategories } from '../src/bulk-memo.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { moveBudget } from '../src/budget-actions.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['expense', 'expense'], ['salary', 'income']]) book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  for (const id of ['food', 'travel', 'other']) book.createBudgetCategory({ id, name: id === 'food' ? '<식비 & 생활>' : id });
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, date, amount, categoryId = 'food', overrides = {}) => recordManual(book, 'owner', {
  requestId: randomUUID(), date, kind: 'expense', accountId: 'bank', counterId: 'expense', categoryId,
  amountExpression: String(amount), memo: '예산 지출', ...overrides }).entry;

test('overspending uses carry-inclusive balances and never offsets deficits with other category surpluses', () => {
  const book = setup();
  try {
    create(book, '2026-09-01', 10000, null, { kind: 'income', counterId: 'salary' });
    book.assignBudget('2026-09', 'food', 500); create(book, '2026-09-30', 700);
    book.assignBudget('2026-10', 'food', 1000); create(book, '2026-10-01', 900);
    book.assignBudget('2026-09', 'travel', 1000); book.assignBudget('2026-10', 'travel', 100); create(book, '2026-10-02', 900, 'travel');
    book.assignBudget('2026-10', 'other', 100); create(book, '2026-10-02', 100, 'other');
    const before = book.entries(); const alerts = budgetOverspending(book, 'owner', '2026-10');
    assert.equal(alerts.categories.length, 1); assert.equal(alerts.deficit, 100);
    assert.equal(alerts.categories[0].categoryId, 'food'); assert.equal(alerts.categories[0].opening, -200);
    assert.equal(alerts.budget.categories.travel.balance, 200); assert.equal(alerts.overAssigned, 0);
    const detail = budgetCategoryActivity(book, 'owner', '2026-10', 'food');
    assert.equal(detail.opening, -200); assert.equal(detail.total, 900); assert.equal(detail.deficit, 100);
    assert.deepEqual(book.entries(), before);
    book.assignBudget('2026-10', 'travel', 0);
    moveBudget(book, 'owner', { month: '2026-10', fromCategoryId: 'food', toCategoryId: 'other', amountExpression: '50', requestId: randomUUID() });
    assert.equal(budgetOverspending(book, 'owner', '2026-10').deficit, 150);
    book.assignBudget('2026-10', 'food', 2000); assert.equal(budgetOverspending(book, 'owner', '2026-10').categories.length, 0);
  } finally { book.close(); }
});

test('over-assignment is separate from category deficits and carried deficits can have no current activity', () => {
  const book = setup();
  try {
    book.assignBudget('2026-09', 'food', 500);
    const assigned = budgetOverspending(book, 'owner', '2026-09');
    assert.equal(assigned.overAssigned, 500); assert.equal(assigned.deficit, 0);
    create(book, '2026-09-01', 700);
    const carried = budgetCategoryActivity(book, 'owner', '2026-10', 'food');
    assert.equal(carried.deficit, 200); assert.equal(carried.total, 0); assert.equal(carried.rows.length, 0); assert.equal(carried.opening, -200);
  } finally { book.close(); }
});

test('category activity reconciles split rows, reversals, card purchases and current category reassignment', () => {
  const book = setup();
  try {
    const split = recordSplitManual(book, 'owner', { requestId: randomUUID(), date: '2026-09-30', kind: 'expense', accountId: 'bank',
      lines: [{ counterId: 'expense', amountExpression: '100', categoryId: 'food' }, { counterId: 'expense', amountExpression: '200', categoryId: 'food' },
        { counterId: 'expense', amountExpression: '400', categoryId: 'travel' }] }).entry;
    assert.equal(budgetCategoryActivity(book, 'owner', '2026-09', 'food').rows[0].amount, 300);
    reverseManualTransaction(book, 'owner', { entryId: split.id, date: '2026-10-01', reason: '취소',
      expectedHash: manualReversalPreview(book, 'owner', split.id).expectedHash, requestId: randomUUID() });
    const first = create(book, '2026-10-02', 100); create(book, '2026-10-03', 200, null);
    create(book, '2026-11-01', 999);
    const detail = budgetCategoryActivity(book, 'owner', '2026-10', 'food');
    assert.equal(detail.rows.length, 2); assert.equal(detail.total, -200); assert.equal(detail.rows[1].amount, -300);
    updateSelectedCategories(book, 'owner', { accountId: 'bank', categoryId: 'travel', requestId: randomUUID(), selections: [{ entryId: first.id, expectedHash: entryFingerprint(first) }] });
    assert.equal(budgetCategoryActivity(book, 'owner', '2026-10', 'food').total, -300);
    assert.equal(budgetCategoryActivity(book, 'owner', '2026-10', 'travel').total, -300);
    book.createAccount({ id: 'card', name: '카드', type: 'liability', card: true, onBudget: true });
    book.cardPurchase({ date: '2026-10-03', cardId: 'card', expenseId: 'expense', amount: 600, count: 3,
      firstDueDate: '2026-11-15', categoryId: 'food' });
    const purchased = budgetCategoryActivity(book, 'owner', '2026-10', 'food');
    assert.equal(purchased.total, 300); assert.equal(purchased.rows[0].amount, 600);
    assert.equal(purchased.rows[0].accounts[0].id, 'card');
    assert.throws(() => budgetCategoryActivity(book, 'viewer', '2026-10', 'food'), /Owner/);
    assert.throws(() => budgetCategoryActivity(book, 'owner', '2026-10', 'missing'), /Unknown/);
    assert.throws(() => budgetCategoryActivity(book, 'owner', '2026-10', null), /Unknown/);
    assert.throws(() => budgetOverspending(book, 'owner', '2026-13'), /Month/);
  } finally { book.close(); }
});

test('budget category activity and spending reconcile on leap days including small ISO years', () => {
  const book = setup();
  try {
    for (const month of ['0000-02', '0096-02', '2024-02']) {
      create(book, `${month}-29`, 100);
      const detail = budgetCategoryActivity(book, 'owner', month, 'food');
      assert.equal(detail.total, 100); assert.equal(detail.category.spent, 100);
    }
  } finally { book.close(); }
});

test('category month navigation crosses years, handles leap days and stops at supported endpoints', () => {
  const book = setup();
  try {
    const january = budgetCategoryActivity(book, 'owner', '2027-01', 'food');
    assert.equal(january.previousMonth, '2026-12'); assert.equal(january.nextMonth, '2027-02');
    const december = budgetCategoryActivity(book, 'owner', '2026-12', 'food');
    assert.equal(december.nextMonth, '2027-01'); assert.equal(december.throughDate, '2026-12-31');
    const leap = budgetCategoryActivity(book, 'owner', '2024-02', 'food');
    assert.equal(leap.fromDate, '2024-02-01'); assert.equal(leap.throughDate, '2024-02-29');
    assert.equal(budgetCategoryActivity(book, 'owner', '0000-01', 'food').previousMonth, null);
    assert.equal(budgetCategoryActivity(book, 'owner', '9999-12', 'food').nextMonth, null);
  } finally { book.close(); }
});

test('HTTP category navigation preserves category and scopes account links, CSV and balances to the chosen month', async () => {
  const book = setup();
  book.assignBudget('2026-12', 'food', 1000); create(book, '2026-12-31', 1200); create(book, '2027-01-01', 100);
  const before = book.entries();
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'owner', role: 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/budget/category`;
  try {
    const html = await (await fetch(`${base}?month=2027-01&categoryId=food`)).text();
    assert.match(html, /value="food" selected/); assert.match(html, /name="month" max="9999-12" value="2027-01"/);
    assert.match(html, /month=2026-12&amp;categoryId=food/); assert.match(html, /month=2027-02&amp;categoryId=food/);
    assert.match(html, /accountId=bank&amp;fromDate=2027-01-01&amp;throughDate=2027-01-31/);
    assert.match(html, /이월 잔액 -200원/); assert.match(html, /남은 예산 -300원/); assert.match(html, /합계 100원/);
    const previous = await (await fetch(`${base}?month=2026-12&categoryId=food`)).text();
    assert.match(previous, /합계 1,200원/);
    const csv = await (await fetch(`${base}.csv?month=2026-12&categoryId=food`)).text();
    assert.match(csv, /2026-12-31/); assert.doesNotMatch(csv, /2027-01-01/);
    const low = await (await fetch(`${base}?month=0000-01&categoryId=food`)).text(); assert.doesNotMatch(low, /이전 달 \(/);
    const high = await (await fetch(`${base}?month=9999-12&categoryId=food`)).text(); assert.doesNotMatch(high, /다음 달 \(/);
    assert.deepEqual(book.entries(), before);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('budget alerts and drilldown HTTP are owner-only, read-only, escaped and export the same allocated amounts', async () => {
  const book = setup(); const entry = create(book, '2026-10-01', 500, 'food', { memo: '=SUM(1,2)' });
  setTransactionChecked(book, 'owner', 'bank', entry.id, true, entryFingerprint(entry));
  let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/budget`;
  try {
    const before = book.entries();
    const page = await (await fetch(`${base}?month=2026-10`)).text();
    assert.match(page, /예산 초과 1개 · 총 500원/); assert.match(page, /&lt;식비 &amp; 생활&gt;/); assert.match(page, /category\?month=2026-10&amp;categoryId=food/);
    const detail = await fetch(`${base}/category?month=2026-10&categoryId=food`); assert.equal(detail.status, 200);
    const html = await detail.text(); assert.match(html, /예산 지출 합계 500원/); assert.match(html, /변경 이력/);
    const csvResponse = await fetch(`${base}/category.csv?month=2026-10&categoryId=food`); assert.equal(csvResponse.status, 200);
    assert.equal(csvResponse.headers.get('cache-control'), 'no-store'); assert.equal(csvResponse.headers.get('x-content-type-options'), 'nosniff');
    const csv = budgetCategoryActivityCsv(book, 'owner', '2026-10', 'food'); assert.ok(csv.includes("'=SUM(1,2)"));
    assert.equal((await csvResponse.text()).replace(/^\uFEFF/, ''), csv.replace(/^\uFEFF/, ''));
    assert.deepEqual(book.entries(), before);
    assert.equal(book.db.prepare('SELECT entry_hash FROM account_entry_checks WHERE entry_id = ?').get(entry.id).entry_hash, entryFingerprint(entry));
    assert.equal((await fetch(`${base}/category?month=2026-10&categoryId=missing`)).status, 400);
    sub = 'viewer';
    for (const suffix of ['?month=2026-10', '/category?month=2026-10&categoryId=food', '/category.csv?month=2026-10&categoryId=food']) {
      const denied = await fetch(base + suffix); assert.equal(denied.status, 400); assert.doesNotMatch(await denied.text(), /식비/);
    }
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
