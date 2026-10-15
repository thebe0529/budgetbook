import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { setBudgetSavingsTarget, budgetSavingsPreview, fillBudgetSavings, budgetSavingsFills } from '../src/budget-savings.js';
import { budgetSavingsPriorities, setBudgetSavingsPriority, budgetSavingsPartialPreview, fillBudgetSavingsPartial } from '../src/budget-savings-partial.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner'); setMember(book, 'owner', 'editor', 'editor', []);
  for (const [id, amount] of [['a', 5000], ['b', 3000], ['c', 2000]]) {
    book.createBudgetCategory({ id, name: id === 'a' ? '<여행 & 저축>' : id }); setBudgetSavingsTarget(book, 'owner', id, String(amount));
  }
  for (const [id, type] of [['bank', 'asset'], ['income', 'income'], ['expense', 'expense']]) book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  book.record({ id: 'income', date: '2026-10-01', postings: [{ accountId: 'bank', side: 'debit', amount: 13000 }, { accountId: 'income', side: 'credit', amount: 13000 }] });
  spend(book, 500); book.assignBudget('2026-09', 'a', 1000);
  return book;
}
function spend(book, amount) {
  book.record({ id: randomUUID(), date: '2026-10-10', postings: [{ accountId: 'expense', side: 'debit', amount }, { accountId: 'bank', side: 'credit', amount }], budgetAllocations: [{ categoryId: 'b', amount }] });
}
const preview = (book, amount = '5000') => budgetSavingsPartialPreview(book, 'owner', '2026-10', amount);
const save = (book, plan, id = randomUUID()) => fillBudgetSavingsPartial(book, 'owner', plan.month, String(plan.limit), id, plan.expectedHash);

test('limited savings uses priority and available cap, preserves unfilled goals and changes no ledger entries', () => {
  const book = setup();
  try {
    setBudgetSavingsPriority(book, 'owner', 'b', '1'); setBudgetSavingsPriority(book, 'owner', 'a', '2');
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n; const entries = book.entries();
    const plan = preview(book, '2000+3000');
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.deepEqual(plan.rows.map(row => [row.categoryId, row.priority, row.needed, row.assigned, row.remainingNeeded]), [['b', 1, 3500, 3500, 0], ['a', 2, 4000, 1500, 2500], ['c', 50, 2000, 0, 2000]]);
    assert.equal(plan.total, 5000); assert.equal(plan.remainingNeeded, 4500); assert.equal(plan.unusedLimit, 0);
    assert.equal(plan.readyToAssign, 12000); assert.equal(plan.afterReadyToAssign, 7000);
    const result = save(book, plan); assert.equal(result.count, 2); assert.equal(result.mode, 'limited');
    const budget = book.budget('2026-10'); assert.equal(budget.categories.b.balance, 3000); assert.equal(budget.categories.a.balance, 2500); assert.equal(budget.categories.c.budgeted, 0);
    assert.equal(budget.readyToAssign, 7000); assert.equal(budgetSavingsPreview(book, 'owner', '2026-10').total, 4500);
    assert.deepEqual(book.entries(), entries); assert.deepEqual(budgetSavingsFills(book, 'owner', '2026-10')[0].rows, plan.rows);
  } finally { book.close(); }
});

test('equal priorities have stable ordering, satisfied goals are skipped and unused capacity stays unassigned', () => {
  const book = setup();
  try {
    assert.deepEqual(preview(book, '2000').rows.map(row => [row.categoryId, row.assigned]), [['a', 2000], ['b', 0], ['c', 0]]);
    setBudgetSavingsTarget(book, 'owner', 'a', '500');
    const plan = preview(book, '12000'); assert.equal(plan.rows[0].assigned, 0); assert.equal(plan.total, 5500); assert.equal(plan.unusedLimit, 6500);
    save(book, plan); assert.equal(book.budget('2026-10').categories.a.balance, 1000); assert.equal(book.budget('2026-10').readyToAssign, 6500);
    const zero = preview(book, '0'); assert.equal(zero.total, 0); assert.throws(() => save(book, zero), /No savings allocation/);
    book.assignBudget('2026-10', 'a', 20000);
    assert.equal(preview(book, '0').total, 0); assert.throws(() => preview(book, '1'), /unassigned funds/);
    assert.equal(budgetSavingsFills(book, 'owner', '2026-10').length, 1);
  } finally { book.close(); }
});

test('priority, goals, assignments and spending invalidate previews, while retries and fill modes remain distinct', () => {
  const book = setup();
  try {
    let plan = preview(book); const id = randomUUID();
    setBudgetSavingsPriority(book, 'owner', 'b', 1); assert.throws(() => save(book, plan, id), /changed/);
    plan = preview(book); setBudgetSavingsTarget(book, 'owner', 'a', '6000'); assert.throws(() => save(book, plan, id), /changed/);
    plan = preview(book); book.assignBudget('2026-10', 'a', 100); assert.throws(() => save(book, plan, id), /changed/);
    plan = preview(book); spend(book, 100); assert.throws(() => save(book, plan, id), /changed/);
    plan = preview(book); const saved = save(book, plan, id);
    book.assignBudget('2026-10', 'a', 0); setBudgetSavingsPriority(book, 'owner', 'a', 1);
    assert.equal(save(book, plan, id).duplicate, true);
    assert.equal(fillBudgetSavingsPartial(book, 'owner', '2026-10', '2500*2', id, plan.expectedHash).duplicate, true);
    for (const [month, amount, hash] of [['2026-11', '5000', plan.expectedHash], ['2026-10', '4000', plan.expectedHash], ['2026-10', '5000', 'bad']]) assert.throws(() => fillBudgetSavingsPartial(book, 'owner', month, amount, id, hash), /reused/);
    assert.throws(() => fillBudgetSavings(book, 'owner', '2026-10', id, saved.expectedHash), /reused/);
    const fullId = randomUUID(); const fullHash = budgetSavingsPreview(book, 'owner', '2026-10').expectedHash;
    fillBudgetSavings(book, 'owner', '2026-10', fullId, fullHash);
    assert.throws(() => fillBudgetSavingsPartial(book, 'owner', '2026-10', '5000', fullId, fullHash), /reused/);
  } finally { book.close(); }
});

test('limited savings and priorities validate owner, active targets, integer priorities and funding limits', () => {
  const book = setup();
  try {
    for (const value of ['0', '101', '1.5', '01', '-1', '1e1', '']) assert.throws(() => setBudgetSavingsPriority(book, 'owner', 'a', value), /1 to 100/);
    for (const value of ['-1', '12001', '1/0']) assert.throws(() => preview(book, value));
    setBudgetSavingsTarget(book, 'owner', 'c', '0'); assert.throws(() => setBudgetSavingsPriority(book, 'owner', 'c', 2), /Active/);
    assert.throws(() => setBudgetSavingsPriority(book, 'owner', 'missing', 2), /Active/);
    for (const sub of ['editor', 'unknown']) {
      assert.throws(() => budgetSavingsPriorities(book, sub), /Owner/);
      assert.throws(() => setBudgetSavingsPriority(book, sub, 'a', 2), /Owner/);
      assert.throws(() => budgetSavingsPartialPreview(book, sub, '2026-10', '1'), /Owner/);
      assert.throws(() => fillBudgetSavingsPartial(book, sub, '2026-10', '1', randomUUID(), ''), /Owner/);
    }
    assert.throws(() => budgetSavingsPartialPreview(book, 'owner', '2026-13', '1'));
    assert.throws(() => fillBudgetSavingsPartial(book, 'owner', '2026-10', '1', 'bad', ''), /request ID/);
    assert.equal(budgetSavingsFills(book, 'owner', '2026-10').length, 0);
  } finally { book.close(); }
});

test('limited fill failure rolls back all assignments and priorities, receipts and saved rows survive reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budget-savings-partial-')); let book;
  try {
    const file = join(dir, 'book.sqlite'); book = setup(file); setBudgetSavingsPriority(book, 'owner', 'b', 1);
    const plan = preview(book); const id = randomUUID();
    book.db.exec("CREATE TRIGGER fail_limited BEFORE INSERT ON budget_savings_fills BEGIN SELECT RAISE(ABORT, 'limited failure'); END");
    assert.throws(() => save(book, plan, id), /limited failure/);
    assert.equal(book.budget('2026-10').categories.a.budgeted, 0); assert.equal(book.budget('2026-10').categories.b.budgeted, 0); assert.equal(budgetSavingsFills(book, 'owner', '2026-10').length, 0);
    book.db.exec('DROP TRIGGER fail_limited'); save(book, plan, id); book.close(); book = new Book(file);
    assert.equal(save(book, plan, id).duplicate, true); assert.equal(budgetSavingsPriorities(book, 'owner').get('b'), 1);
    assert.deepEqual(budgetSavingsFills(book, 'owner', '2026-10')[0].rows, plan.rows);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP priority and limited savings routes enforce CSRF and owner, escape previews and revalidate final saves', async () => {
  const book = setup(); let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/budget`;
  const input = { month: '2026-10', requestId: randomUUID(), amountExpression: '2000+3000', csrf: 'token', categoryId: 'b', priority: '1' };
  const post = (path, values) => fetch(base + path, { method: 'POST', body: new URLSearchParams(values) });
  try {
    for (const path of ['/savings-priority', '/fill-savings-limited/preview', '/fill-savings-limited']) {
      assert.equal((await post(path, { ...input, csrf: 'wrong' })).status, 403);
      sub = 'editor'; assert.equal((await post(path, input)).status, 400); sub = 'owner';
    }
    assert.equal((await post('/savings-priority', input)).status, 200);
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const response = await post('/fill-savings-limited/preview', input); assert.equal(response.status, 200);
    const html = await response.text(); assert.match(html, /&lt;여행 &amp; 저축&gt;/); assert.match(html, /남은 목표 부족액 4,500원/); assert.match(html, /name="amountExpression" value="5000"/);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    const expectedHash = html.match(/name="expectedHash" value="([^\"]+)"/)[1];
    setBudgetSavingsPriority(book, 'owner', 'a', 1);
    assert.equal((await post('/fill-savings-limited', { ...input, expectedHash })).status, 400);
    const fresh = preview(book); const saved = await post('/fill-savings-limited', { ...input, expectedHash: fresh.expectedHash }); assert.equal(saved.status, 200);
    const result = await saved.text(); assert.match(result, /한도 내 배정/); assert.match(result, /남은 목표 부족액 4,500원/); assert.match(result, /순위 1/);
    assert.equal((await post('/fill-savings-limited', { ...input, expectedHash: fresh.expectedHash })).status, 200);
    assert.equal(budgetSavingsFills(book, 'owner', '2026-10').length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
