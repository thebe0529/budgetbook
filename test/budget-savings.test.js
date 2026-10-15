import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { setBudgetSavingsTarget, budgetSavingsPreview, fillBudgetSavings, budgetSavingsFills } from '../src/budget-savings.js';
import { setBudgetTarget, fillBudgetTargets } from '../src/budget-targets.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner'); setMember(book, 'owner', 'editor', 'editor', []);
  for (const [id, name] of [['a', '<여행 & 저축>'], ['b', '비상금'], ['c', '미설정']]) book.createBudgetCategory({ id, name });
  for (const [id, type] of [['bank', 'asset'], ['expense', 'expense']]) book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  book.assignBudget('2026-09', 'a', 5000); book.assignBudget('2026-10', 'a', 1000);
  book.assignBudget('2026-09', 'b', 1000);
  expense(book, 'a', 2000, '2026-09-10'); expense(book, 'a', 500, '2026-10-10'); expense(book, 'b', 1500, '2026-09-10');
  return book;
}
function expense(book, categoryId, amount, date = '2026-10-11') {
  book.record({ id: randomUUID(), date, postings: [{ accountId: 'expense', side: 'debit', amount }, { accountId: 'bank', side: 'credit', amount }], budgetAllocations: [{ categoryId, amount }] });
}
const fill = (book, month = '2026-10', id = randomUUID()) => fillBudgetSavings(book, 'owner', month, id, budgetSavingsPreview(book, 'owner', month).expectedHash);

test('savings goals account for carry and expenses, replenish deficits and add to assignments without reducing surpluses', () => {
  const book = setup();
  try {
    setBudgetSavingsTarget(book, 'owner', 'a', '5000+5000'); setBudgetSavingsTarget(book, 'owner', 'b', '2000');
    const entries = book.entries(); const reports = book.reports('2026-09-01', '2026-10-31');
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const preview = budgetSavingsPreview(book, 'owner', '2026-10');
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(preview.rows.map(row => [row.categoryId, row.balance, row.needed, row.afterBudgeted, row.afterBalance]), [['a', 3500, 6500, 7500, 10000], ['b', -500, 2500, 2500, 2000]]);
    assert.equal(preview.total, 9000); assert.equal(preview.afterReadyToAssign, preview.readyToAssign - 9000);
    const result = fillBudgetSavings(book, 'owner', '2026-10', randomUUID(), preview.expectedHash);
    assert.equal(result.count, 2); assert.equal(result.total, 9000);
    assert.equal(book.budget('2026-10').categories.a.budgeted, 7500); assert.equal(book.budget('2026-10').categories.b.balance, 2000);
    assert.equal(budgetSavingsPreview(book, 'owner', '2026-10').total, 0);
    book.assignBudget('2026-10', 'a', 10000); const over = book.budget('2026-10').categories.a.balance;
    assert.equal(fill(book).count, 0); assert.equal(book.budget('2026-10').categories.a.balance, over);
    assert.deepEqual(book.entries(), entries); assert.deepEqual(book.reports('2026-09-01', '2026-10-31'), reports);
    assert.equal(book.budget('2026-09').categories.a.budgeted, 5000);
  } finally { book.close(); }
});

test('monthly assignment and savings goals coexist, invalidate stale fills and can replenish after later spending', () => {
  const book = setup();
  try {
    setBudgetSavingsTarget(book, 'owner', 'a', '10000'); setBudgetTarget(book, 'owner', 'a', '4000');
    const old = budgetSavingsPreview(book, 'owner', '2026-10'); const requestId = randomUUID();
    fillBudgetTargets(book, 'owner', '2026-10', randomUUID());
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-10', requestId, old.expectedHash), /changed/);
    assert.equal(budgetSavingsPreview(book, 'owner', '2026-10').total, 3500);
    const result = fill(book, '2026-10', requestId); assert.equal(result.total, 3500);
    expense(book, 'a', 700);
    assert.equal(budgetSavingsPreview(book, 'owner', '2026-10').total, 700);
    assert.equal(fillBudgetSavings(book, 'owner', '2026-10', requestId, result.expectedHash).duplicate, true);
    assert.equal(budgetSavingsPreview(book, 'owner', '2026-10').total, 700);
    assert.equal(fill(book).total, 700);
    const next = budgetSavingsPreview(book, 'owner', '2026-11'); assert.equal(next.total, 0);
    setBudgetSavingsTarget(book, 'owner', 'a', '0'); assert.deepEqual(budgetSavingsPreview(book, 'owner', '2026-10').rows, []);
  } finally { book.close(); }
});

test('savings fill rejects changed targets and ID reuse, enforces owner and checks all arithmetic bounds', () => {
  const book = setup();
  try {
    setBudgetSavingsTarget(book, 'owner', 'a', '10000');
    const preview = budgetSavingsPreview(book, 'owner', '2026-10'); const id = randomUUID();
    setBudgetSavingsTarget(book, 'owner', 'a', '11000');
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-10', id, preview.expectedHash), /changed/);
    const saved = fill(book, '2026-10', id);
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-11', id, saved.expectedHash), /reused/);
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-10', id, 'bad'), /reused/);
    for (const sub of ['editor', 'unknown']) {
      assert.throws(() => setBudgetSavingsTarget(book, sub, 'a', '1'), /Owner/);
      assert.throws(() => budgetSavingsPreview(book, sub, '2026-10'), /Owner/);
      assert.throws(() => fillBudgetSavings(book, sub, '2026-10', id, saved.expectedHash), /Owner/);
      assert.throws(() => budgetSavingsFills(book, sub, '2026-10'), /Owner/);
    }
    assert.throws(() => setBudgetSavingsTarget(book, 'owner', 'a', '-1'), /negative/);
    assert.throws(() => setBudgetSavingsTarget(book, 'owner', 'missing', '1'), /Unknown/);
    assert.throws(() => budgetSavingsPreview(book, 'owner', '2026-13'));
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-10', 'bad', saved.expectedHash), /request ID/);
    setBudgetSavingsTarget(book, 'owner', 'b', String(Number.MAX_SAFE_INTEGER));
    assert.throws(() => budgetSavingsPreview(book, 'owner', '2026-10'), /supported range/);
  } finally { book.close(); }
});

test('savings fill audit failure rolls back every assignment and its request is retryable after reopening', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-savings-')); let book;
  try {
    const file = join(dir, 'book.sqlite'); book = setup(file);
    setBudgetSavingsTarget(book, 'owner', 'a', '10000'); setBudgetSavingsTarget(book, 'owner', 'b', '2000');
    const preview = budgetSavingsPreview(book, 'owner', '2026-10'); const id = randomUUID();
    book.db.exec("CREATE TRIGGER fail_savings BEFORE INSERT ON budget_savings_fills BEGIN SELECT RAISE(ABORT, 'savings failure'); END");
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-10', id, preview.expectedHash), /savings failure/);
    assert.equal(book.budget('2026-10').categories.a.budgeted, 1000); assert.equal(book.budget('2026-10').categories.b.budgeted, 0); assert.equal(budgetSavingsFills(book, 'owner', '2026-10').length, 0);
    book.db.exec('DROP TRIGGER fail_savings'); const saved = fillBudgetSavings(book, 'owner', '2026-10', id, preview.expectedHash);
    book.close(); book = new Book(file);
    assert.equal(fillBudgetSavings(book, 'owner', '2026-10', id, preview.expectedHash).duplicate, true);
    assert.deepEqual(budgetSavingsFills(book, 'owner', '2026-10')[0].rows, saved.rows);
    assert.equal(budgetSavingsPreview(book, 'owner', '2026-11').total, 0);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP savings goals enforce CSRF and owner, show current shortfalls and reject stale submissions', async () => {
  const book = setup(); let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/budget`;
  const post = (path, values) => fetch(base + path, { method: 'POST', body: new URLSearchParams(values) });
  const setting = { month: '2026-10', categoryId: 'a', amountExpression: '10000', csrf: 'token' };
  try {
    for (const path of ['/savings-target', '/fill-savings']) assert.equal((await post(path, { ...setting, csrf: 'wrong' })).status, 403);
    sub = 'editor'; for (const path of ['/savings-target', '/fill-savings']) assert.equal((await post(path, setting)).status, 400); sub = 'owner';
    assert.equal((await post('/savings-target', setting)).status, 200);
    const html = await (await fetch(`${base}?month=2026-10`)).text();
    assert.match(html, /저축 잔액 목표/); assert.match(html, /&lt;여행 &amp; 저축&gt;/); assert.match(html, /잔액 목표 부족액 합계 6,500원/); assert.match(html, /미배정 자금이 음수/);
    const fields = html.match(/action="\/admin\/budget\/fill-savings">([\s\S]*?)<\/form>/)[1];
    const input = { month: '2026-10', csrf: 'token', requestId: fields.match(/name="requestId" value="([^\"]+)"/)[1], expectedHash: fields.match(/name="expectedHash" value="([^\"]+)"/)[1] };
    expense(book, 'a', 100);
    assert.equal((await post('/fill-savings', input)).status, 400);
    input.expectedHash = budgetSavingsPreview(book, 'owner', '2026-10').expectedHash;
    assert.equal((await post('/fill-savings', input)).status, 200);
    const retry = await post('/fill-savings', input); assert.equal(retry.status, 200); assert.match(await retry.text(), /이미 처리한/);
    const history = await (await fetch(`${base}?month=2026-10`)).text(); assert.match(history, /배정 당시 내역/); assert.match(history, /6,600원/);
    assert.equal(budgetSavingsFills(book, 'owner', '2026-10').length, 1);
    const invalid = await post('/savings-target', { ...setting, categoryId: 'b', amountExpression: String(Number.MAX_SAFE_INTEGER) });
    assert.equal(invalid.status, 400); assert.equal(book.db.prepare('SELECT amount FROM budget_savings_targets WHERE category_id = ?').get('b'), undefined);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
