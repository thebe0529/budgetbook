import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { previousBudgetPreview, copyPreviousBudget } from '../src/budget-actions.js';
import { createImportApi } from '../src/import-api.js';

test('previous budget copy crosses years, preserves explicit zero and is repeatable', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    for (const id of ['food', 'travel', 'other']) book.createBudgetCategory({ id, name: id });
    book.assignBudget('2026-12', 'food', 10000);
    book.assignBudget('2026-12', 'travel', 5000);
    book.assignBudget('2026-12', 'other', 3000);
    book.assignBudget('2027-01', 'travel', 0);
    book.assignBudget('2027-01', 'other', 2000);
    const preview = previousBudgetPreview(book, 'owner', '2027-01');
    assert.equal(preview.fromMonth, '2026-12');
    assert.equal(preview.total, 10000);
    assert.deepEqual(copyPreviousBudget(book, 'owner', '2027-01'),
      { fromMonth: '2026-12', count: 1, total: 10000 });
    const assigned = book.db.prepare('SELECT category_id, amount FROM budget_assignments WHERE month = ? ORDER BY category_id').all('2027-01');
    assert.deepEqual(assigned.map(row => [row.category_id, row.amount]),
      [['food', 10000], ['other', 2000], ['travel', 0]]);
    assert.equal(copyPreviousBudget(book, 'owner', '2027-01').count, 0);
    assert.equal(copyPreviousBudget(book, 'owner', '2026-01').count, 0);
    assert.equal(book.entries().length, 0);
    assert.throws(() => copyPreviousBudget(book, 'owner', '2027-13'), /YYYY-MM/);
  } finally { book.close(); }
});

test('budget copying enforces owner and CSRF and recalculates at submission', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  setMember(book, 'owner', 'editor', 'editor', []);
  book.createBudgetCategory({ id: 'food', name: '식비' });
  book.assignBudget('2026-09', 'food', 5000);
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'editor=1' ? 'editor' : 'owner',
    role: req.headers.cookie === 'editor=1' ? 'editor' : 'owner', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const send = (csrf = 'token', cookie = '') => fetch(url + '/admin/budget/copy-previous', {
    method: 'POST', headers: { Cookie: cookie }, body: new URLSearchParams({ month: '2026-10', csrf }) });
  try {
    assert.equal((await send('bad')).status, 403);
    assert.equal((await send('token', 'editor=1')).status, 400);
    const page = await fetch(url + '/admin/budget?month=2026-10');
    assert.match(await page.text(), /이전 달 예산 복사/);
    book.assignBudget('2026-10', 'food', 2500);
    assert.equal((await send()).status, 200);
    assert.equal(book.db.prepare('SELECT amount FROM budget_assignments WHERE month = ? AND category_id = ?')
      .get('2026-10', 'food').amount, 2500);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
