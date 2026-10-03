import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { setBudgetTarget, budgetTargetPreview, fillBudgetTargets } from '../src/budget-targets.js';
import { createImportApi } from '../src/import-api.js';

test('monthly goals fill only missing assignments and retries do not overwrite later edits', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    for (const id of ['food', 'travel']) book.createBudgetCategory({ id, name: id });
    setBudgetTarget(book, 'owner', 'food', '10000+5000');
    setBudgetTarget(book, 'owner', 'travel', '3000');
    book.assignBudget('2026-09', 'food', 99999);
    book.assignBudget('2026-10', 'food', 5000);
    book.assignBudget('2026-10', 'travel', 4000);
    assert.equal(budgetTargetPreview(book, 'owner', '2026-10').total, 10000);
    const requestId = randomUUID();
    const result = fillBudgetTargets(book, 'owner', '2026-10', requestId);
    assert.equal(result.count, 1);
    assert.equal(result.total, 10000);
    assert.equal(book.budget('2026-10').categories.travel.budgeted, 4000);
    assert.equal(book.budget('2026-10').categories.food.budgeted, 15000);
    book.assignBudget('2026-10', 'food', 7000);
    assert.equal(fillBudgetTargets(book, 'owner', '2026-10', requestId).duplicate, true);
    assert.equal(book.budget('2026-10').categories.food.budgeted, 7000);
    assert.throws(() => fillBudgetTargets(book, 'owner', '2026-11', requestId), /reused/);
    setBudgetTarget(book, 'owner', 'food', '0');
    assert.equal(budgetTargetPreview(book, 'owner', '2026-10').total, 0);
    assert.equal(book.entries().length, 0);
    assert.throws(() => setBudgetTarget(book, 'owner', 'food', '-1'), /negative/);
  } finally { book.close(); }
});

test('target fill rolls back all assignments and its request record if a write fails', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    for (const id of ['a', 'b']) {
      book.createBudgetCategory({ id, name: id });
      setBudgetTarget(book, 'owner', id, '1000');
    }
    book.db.exec(`CREATE TRIGGER reject_second BEFORE INSERT ON budget_assignments
      WHEN NEW.category_id = 'b' BEGIN SELECT RAISE(ABORT, 'assignment failure'); END;`);
    assert.throws(() => fillBudgetTargets(book, 'owner', '2026-10', randomUUID()), /assignment failure/);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM budget_assignments').get().n, 0);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS n FROM budget_goal_fills').get().n, 0);
  } finally { book.close(); }
});

test('target settings and fill endpoints enforce owner and CSRF', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  setMember(book, 'owner', 'editor', 'editor', []);
  book.createBudgetCategory({ id: 'food', name: '식비' });
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'editor=1' ? 'editor' : 'owner',
    role: req.headers.cookie === 'editor=1' ? 'editor' : 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (path, body, cookie = '') => fetch(url + path, { method: 'POST',
    headers: { Cookie: cookie }, body: new URLSearchParams(body) });
  const setting = { month: '2026-10', categoryId: 'food', amountExpression: '1000', csrf: 'token' };
  try {
    assert.equal((await send('/admin/budget/target', { ...setting, csrf: 'wrong' })).status, 403);
    assert.equal((await send('/admin/budget/target', setting, 'editor=1')).status, 400);
    assert.equal((await send('/admin/budget/target', setting)).status, 200);
    const fill = { month: '2026-10', requestId: randomUUID(), csrf: 'token' };
    assert.equal((await send('/admin/budget/fill-targets', fill, 'editor=1')).status, 400);
    assert.equal((await send('/admin/budget/fill-targets', fill)).status, 200);
    assert.equal(book.budget('2026-10').categories.food.budgeted, 1000);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
