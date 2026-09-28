import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createCategory, createLedgerAccount } from '../src/manual.js';
import { listAdjustments, recordAdjustment, reverseAdjustment } from '../src/adjustments.js';
import { createImportApi } from '../src/import-api.js';

function fixture() {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true, onBudget: true });
  const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  const salary = createLedgerAccount(book, 'owner', { name: '급여', type: 'income' });
  const category = createCategory(book, 'owner', '생활비');
  setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
  return { book, bank, food, salary, category };
}

test('batch adjustment is atomic, idempotent and reversed with budget and audit preserved', () => {
  const { book, bank, food, salary, category } = fixture();
  try {
    const input = { requestId: randomUUID(), date: '2026-10-31', reason: '누락분 정리', rows: [
      { debitId: food.id, creditId: bank.id, amountExpression: '10000+2500',
        categoryId: category.id, memo: '식비' },
      { debitId: bank.id, creditId: salary.id, amountExpression: '20000', memo: '급여' },
    ] };
    assert.throws(() => recordAdjustment(book, 'viewer', input), /Owner/);
    assert.throws(() => recordAdjustment(book, 'owner', { ...input,
      rows: [input.rows[0], { ...input.rows[1], creditId: bank.id }] }), /Invalid adjustment row/);
    assert.equal(book.entries().length, 0);
    const first = recordAdjustment(book, 'owner', input);
    assert.equal(first.duplicate, false);
    assert.equal(recordAdjustment(book, 'owner', input).duplicate, true);
    assert.throws(() => recordAdjustment(book, 'owner', { ...input, reason: '다름' }), /reused/);
    assert.equal(book.entries().length, 2);
    assert.equal(book.budget('2026-10').categories[category.id].spent, 12500);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.result, 7500);
    assert.throws(() => reverseAdjustment(book, 'owner', { batchId: first.batch.id,
      date: '2026-10-30', reason: '취소' }), /precedes/);
    const reverse = reverseAdjustment(book, 'owner', { batchId: first.batch.id,
      date: '2026-11-01', reason: '취소' });
    assert.equal(reverse.reversesBatchId, first.batch.id);
    assert.equal(book.budget('2026-11').categories[category.id].spent, -12500);
    assert.equal(book.reports('2026-10-01', '2026-11-30').incomeStatement.result, 0);
    assert.equal(book.entries().length, 4);
    assert.equal(listAdjustments(book, 'owner').find(b => b.id === first.batch.id).reversalId, reverse.id);
    assert.throws(() => reverseAdjustment(book, 'owner', { batchId: first.batch.id,
      date: '2026-11-01', reason: '또 취소' }), /UNIQUE/);
    assert.equal(book.entries().length, 4);
  } finally { book.close(); }
});

test('adjustment form enforces CSRF and owner role', async () => {
  const { book, bank, food } = fixture();
  const auth = { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner',
    role: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${url}/admin/adjustments`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /adjustment-rows/);
    const body = new URLSearchParams({ requestId: randomUUID(), date: '2026-10-31',
      reason: '테스트', debitId: food.id, creditId: bank.id, amountExpression: '1000',
      categoryId: '', lineMemo: '' });
    assert.equal((await fetch(`${url}/admin/adjustments`, { method: 'POST',
      body: new URLSearchParams({ ...Object.fromEntries(body), csrf: 'wrong' }) })).status, 403);
    body.set('csrf', 'token');
    assert.equal((await fetch(`${url}/admin/adjustments`, { method: 'POST',
      headers: { Cookie: 'viewer=1' }, body })).status, 400);
    const saved = await fetch(`${url}/admin/adjustments`, { method: 'POST', body });
    assert.equal(saved.status, 200);
    assert.match(await saved.text(), /분개 조회/);
    const batch = listAdjustments(book, 'owner')[0];
    const detail = await fetch(`${url}/admin/adjustments/detail?id=${batch.id}`);
    assert.match(await detail.text(), /adjust:/);
    const hidden = await fetch(`${url}/admin/adjustments/detail?id=${batch.id}`,
      { headers: { Cookie: 'viewer=1' } });
    assert.equal(hidden.status, 400);
    assert.doesNotMatch(await hidden.text(), /테스트/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
