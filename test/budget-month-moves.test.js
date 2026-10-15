import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { budgetMonthMovePreview, moveBudgetMonth, budgetMonthMoves } from '../src/budget-month-moves.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  setMember(book, 'owner', 'editor', 'editor', []);
  for (const [id, name] of [['food', '<식비 & 생활>'], ['travel', '여행']]) book.createBudgetCategory({ id, name });
  for (const [id, type] of [['bank', 'asset'], ['salary', 'income'], ['expense', 'expense']]) book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  book.record({ id: 'income', date: '2026-12-01', postings: [{ accountId: 'bank', side: 'debit', amount: 20000 }, { accountId: 'salary', side: 'credit', amount: 20000 }] });
  book.record({ id: 'expense', date: '2027-01-05', postings: [{ accountId: 'expense', side: 'debit', amount: 3000 }, { accountId: 'bank', side: 'credit', amount: 3000 }], budgetAllocations: [{ categoryId: 'food', amount: 3000 }] });
  book.assignBudget('2026-12', 'food', 10000); book.assignBudget('2027-02', 'food', 2000);
  return book;
}
const inputFor = (overrides = {}) => ({ fromMonth: '2026-12', toMonth: '2027-02', fromCategoryId: 'food', toCategoryId: 'food', amountExpression: '1000+2000', reason: '다음 달 준비', requestId: randomUUID(), ...overrides });
const ready = (book, input) => ({ ...input, expectedHash: budgetMonthMovePreview(book, 'owner', input).expectedHash });
const assignment = (book, month, id = 'food') => book.db.prepare('SELECT amount FROM budget_assignments WHERE month = ? AND category_id = ?').get(month, id)?.amount ?? 0;

test('moving assignments across years previews carry impact without writes and preserves later cumulative totals and actual reports', () => {
  const book = setup();
  try {
    const input = inputFor(); const entries = book.entries(); const reports = book.reports('2026-12-01', '2027-12-31');
    const oldEnd = book.budget('2027-02'); const oldMiddle = book.budget('2027-01');
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const preview = budgetMonthMovePreview(book, 'owner', input);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.equal(preview.fromBefore, 10000); assert.equal(preview.fromAfter, 7000); assert.equal(preview.toBefore, 2000); assert.equal(preview.toAfter, 5000);
    assert.deepEqual(preview.impacts.map(row => row.month), ['2026-12', '2027-02']);
    assert.equal(preview.impacts[0].before.readyToAssign, 10000); assert.equal(preview.impacts[0].after.readyToAssign, 13000);
    const saved = moveBudgetMonth(book, 'owner', { ...input, expectedHash: preview.expectedHash });
    assert.equal(saved.duplicate, false); assert.equal(assignment(book, '2026-12'), 7000); assert.equal(assignment(book, '2027-02'), 5000);
    assert.equal(book.budget('2027-01').categories.food.balance, oldMiddle.categories.food.balance - 3000);
    assert.equal(book.budget('2027-01').readyToAssign, oldMiddle.readyToAssign + 3000);
    assert.equal(book.budget('2027-02').categories.food.balance, oldEnd.categories.food.balance);
    assert.equal(book.budget('2027-02').readyToAssign, oldEnd.readyToAssign);
    assert.deepEqual(book.entries(), entries); assert.deepEqual(book.reports('2026-12-01', '2027-12-31'), reports);
    assert.equal(budgetMonthMoves(book, 'owner', '2026-12')[0].id, saved.id); assert.equal(budgetMonthMoves(book, 'owner', '2027-02')[0].id, saved.id);
    assert.equal(budgetMonthMoves(book, 'owner', '2027-01').length, 0);
  } finally { book.close(); }
});

test('backward moves between categories preserve total assignments and can exhaust source with stable retries', () => {
  const book = setup();
  try {
    const input = ready(book, inputFor({ fromMonth: '2027-02', toMonth: '2026-12', toCategoryId: 'travel', amountExpression: '2000', reason: '  여행 재배정  ' }));
    const result = moveBudgetMonth(book, 'owner', input);
    assert.equal(assignment(book, '2027-02'), 0); assert.equal(assignment(book, '2026-12', 'travel'), 2000);
    assert.equal(book.budget('2026-12').readyToAssign, 8000); assert.equal(book.budget('2027-02').readyToAssign, 8000);
    assert.equal(result.payload.reason, '여행 재배정');
    assert.equal(moveBudgetMonth(book, 'owner', { ...input, amountExpression: '1000*2', reason: '여행 재배정' }).duplicate, true);
    for (const patch of [{ amountExpression: '1000' }, { reason: '다른 사유' }, { expectedHash: 'bad' }, { toCategoryId: 'food' }]) assert.throws(() => moveBudgetMonth(book, 'owner', { ...input, ...patch }), /reused/);
    assert.equal(budgetMonthMoves(book, 'owner', '2027-02').length, 1);
  } finally { book.close(); }
});

test('month moves validate owner, months, amount, source assignment, reason, range and request ID', () => {
  const book = setup();
  try {
    for (const patch of [{ toMonth: '2026-12' }, { toMonth: '2027-13' }, { fromMonth: 'bad' }, { fromCategoryId: 'missing' }, { toCategoryId: 'missing' },
      { amountExpression: '0' }, { amountExpression: '-1' }, { amountExpression: '1/0' }, { amountExpression: '10001' }, { reason: '' }, { reason: 'x'.repeat(201) }]) {
      assert.throws(() => budgetMonthMovePreview(book, 'owner', inputFor(patch)));
    }
    book.assignBudget('2027-02', 'food', Number.MAX_SAFE_INTEGER);
    assert.throws(() => budgetMonthMovePreview(book, 'owner', inputFor()), /supported range/);
    book.assignBudget('2027-02', 'food', 2000);
    const input = ready(book, inputFor());
    assert.throws(() => moveBudgetMonth(book, 'owner', { ...input, requestId: 'bad' }), /request ID/);
    assert.throws(() => moveBudgetMonth(book, 'owner', { ...input, expectedHash: null }), /changed/);
    for (const sub of ['editor', 'unknown']) {
      assert.throws(() => budgetMonthMovePreview(book, sub, input), /Owner/);
      assert.throws(() => moveBudgetMonth(book, sub, input), /Owner/);
      assert.throws(() => budgetMonthMoves(book, sub, '2026-12'), /Owner/);
    }
    assert.equal(budgetMonthMoves(book, 'owner', '2026-12').length, 0); assert.equal(assignment(book, '2026-12'), 10000);
  } finally { book.close(); }
});

test('month move preview detects assignment and expense changes and does not reserve request IDs', () => {
  const book = setup();
  try {
    const input = ready(book, inputFor());
    book.assignBudget('2027-02', 'food', 2500);
    assert.throws(() => moveBudgetMonth(book, 'owner', input), /changed/);
    const next = ready(book, input);
    book.record({ id: 'extra-expense', date: '2027-01-20', postings: [{ accountId: 'expense', side: 'debit', amount: 100 }, { accountId: 'bank', side: 'credit', amount: 100 }], budgetAllocations: [{ categoryId: 'food', amount: 100 }] });
    assert.throws(() => moveBudgetMonth(book, 'owner', next), /changed/);
    const fresh = ready(book, input);
    assert.equal(moveBudgetMonth(book, 'owner', fresh).duplicate, false);
    book.assignBudget('2026-12', 'food', 0);
    assert.equal(moveBudgetMonth(book, 'owner', fresh).duplicate, true);
    assert.equal(budgetMonthMoves(book, 'owner', '2026-12').length, 1);
  } finally { book.close(); }
});

test('month move audit failure rolls back both assignments and saved previews survive reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-month-move-')); let book;
  try {
    const filename = join(dir, 'book.sqlite'); book = setup(filename); const input = ready(book, inputFor());
    book.db.exec("CREATE TRIGGER fail_month_move BEFORE INSERT ON budget_month_moves BEGIN SELECT RAISE(ABORT, 'month move failure'); END");
    assert.throws(() => moveBudgetMonth(book, 'owner', input), /month move failure/);
    assert.equal(assignment(book, '2026-12'), 10000); assert.equal(assignment(book, '2027-02'), 2000); assert.equal(budgetMonthMoves(book, 'owner', '2026-12').length, 0);
    book.db.exec('DROP TRIGGER fail_month_move'); const saved = moveBudgetMonth(book, 'owner', input);
    book.close(); book = new Book(filename);
    assert.equal(moveBudgetMonth(book, 'owner', input).duplicate, true);
    assert.deepEqual(budgetMonthMoves(book, 'owner', '2027-02')[0].impacts, saved.impacts);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP month move requires owner and CSRF, previews escaped impacts and saves only once after revalidation', async () => {
  const book = setup(); let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/budget`;
  const input = { ...inputFor({ reason: '<재배정 & 확인>' }), csrf: 'token' };
  const post = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body) });
  try {
    const budget = await (await fetch(`${base}?month=2026-12`)).text(); assert.match(budget, /월간 예산 배정 이동/);
    for (const path of ['/move-month/preview', '/move-month']) assert.equal((await post(path, { ...input, csrf: 'bad' })).status, 403);
    sub = 'editor'; assert.equal((await post('/move-month/preview', input)).status, 400); assert.equal((await post('/move-month', input)).status, 400); sub = 'owner';
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const response = await post('/move-month/preview', input); assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /&lt;식비 &amp; 생활&gt;/); assert.match(html, /&lt;재배정 &amp; 확인&gt;/); assert.match(html, /아직 저장하지 않았습니다/);
    assert.match(html, /name="amountExpression" value="3000"/); assert.match(html, /10,000 → 7,000원/);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    const expectedHash = html.match(/name="expectedHash" value="([a-f0-9]+)"/)[1];
    book.assignBudget('2027-02', 'food', 2500);
    assert.equal((await post('/move-month', { ...input, expectedHash })).status, 400);
    const freshHtml = await (await post('/move-month/preview', input)).text();
    const fresh = { ...input, expectedHash: freshHtml.match(/name="expectedHash" value="([a-f0-9]+)"/)[1] };
    assert.equal((await post('/move-month', fresh)).status, 200); const replay = await post('/move-month', fresh);
    assert.equal(replay.status, 200); assert.match(await replay.text(), /이미 처리한/);
    const destination = await (await fetch(`${base}?month=2027-02`)).text(); assert.match(destination, /&lt;재배정 &amp; 확인&gt;/); assert.match(destination, /이동 당시 내역/);
    assert.equal(budgetMonthMoves(book, 'owner', '2026-12').length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
