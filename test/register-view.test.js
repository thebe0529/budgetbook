import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { registerFilters, registerPage } from '../src/register-view.js';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount, recordManual } from '../src/manual.js';
import { createImportApi } from '../src/import-api.js';

const filters = values => registerFilters(new URLSearchParams(values));

test('register search filters before pagination and preserves running balances', () => {
  const register = { rows: Array.from({ length: 405 }, (_, id) => ({ id,
    memo: 'Cafe 식비', date: '2026-10-01', checked: false, movement: -1, balance: -1000 + id })) };
  const first = registerPage(register, filters({ memo: 'CAFE', status: 'unchecked' }));
  const second = registerPage(register, filters({ memo: '식비', page: '2' }));
  const last = registerPage(register, filters({ page: '999' }));
  assert.equal(first.total, 405);
  assert.equal(first.movement, -405);
  assert.equal(first.rows.length, 200);
  assert.equal(second.rows[0].id, 200);
  assert.equal(second.rows[0].balance, -800);
  assert.equal(last.page, 3);
  assert.equal(last.rows.length, 5);
  assert.equal(registerPage(register, filters({ fromDate: '2026-10-02' })).total, 0);
  assert.equal(registerPage(register, filters({ throughDate: '2026-09-30' })).total, 0);
  assert.equal(registerPage(register, filters({ fromDate: '2026-10-01', throughDate: '2026-10-01' })).total, 405);
  assert.equal(registerPage(register, filters({ status: 'checked' })).total, 0);
});

test('register filters reject invalid dates, ranges, statuses and pages', () => {
  for (const input of [{ fromDate: '2026-02-30' }, { fromDate: '2026-10-02', throughDate: '2026-10-01' },
    { status: 'hidden' }, { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e2' },
    { page: '9007199254740992' }, { memo: 'a'.repeat(201) }]) {
    assert.throws(() => filters(input));
  }
});

test('register HTTP search preserves filters after confirmation and excludes private accounts', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset' });
  const privateBank = createLedgerAccount(book, 'owner', { name: '비밀', type: 'asset' });
  const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  setMember(book, 'owner', 'editor', 'editor', [bank.id]);
  const make = (accountId, date, memo) => recordManual(book, 'owner', { requestId: randomUUID(),
    kind: 'expense', accountId, counterId: expense.id, amountExpression: '1000', date, memo }).entry;
  const entry = make(bank.id, '2026-10-01', '<검색 & 대상>');
  make(bank.id, '2026-09-01', '이전 거래');
  make(privateBank.id, '2026-10-01', '비밀 거래');
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'editor', role: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/register`;
  const query = new URLSearchParams({ accountId: bank.id, fromDate: '2026-10-01', throughDate: '2026-10-01', memo: '<검색 & 대상>', status: 'unchecked' });
  try {
    const html = await (await fetch(`${base}?${query}`)).text();
    assert.match(html, /조건에 맞는 1건/);
    assert.match(html, /&lt;검색 &amp; 대상&gt;/);
    assert.ok(!html.includes('이전 거래'));
    assert.ok(!html.includes('비밀 거래'));
    assert.match(html, /잔액: -2,000원/);
    const { entryFingerprint } = await import('../src/transaction-checks.js');
    const body = new URLSearchParams(query);
    body.set('csrf', 'token'); body.set('entryId', entry.id);
    body.set('checked', 'true'); body.set('expectedHash', entryFingerprint(entry));
    const result = await fetch(`${base}/check`, { method: 'POST', body });
    assert.equal(result.status, 200);
    const checked = await result.text();
    assert.match(checked, /조건에 맞는 0건/);
    assert.match(checked, /name="fromDate" value="2026-10-01"/);
    assert.equal((await fetch(`${base}?accountId=${privateBank.id}`)).status, 400);
    assert.equal((await fetch(`${base}?accountId=${bank.id}&page=0`)).status, 400);
    for (let i = 0; i < 200; i++) make(bank.id, '2026-10-02', `추가 ${i}`);
    const pagedQuery = new URLSearchParams({ accountId: bank.id, status: 'unchecked', page: '2' });
    const second = await (await fetch(`${base}?${pagedQuery}`)).text();
    assert.match(second, /2 \/ 2 페이지/);
    assert.match(second, /이전 거래/);
    assert.equal((second.match(/name="selection"/g) || []).length, 1);
    const selected = second.match(/name="selection"[^>]*value="([^"]+)"/)[1]
      .replaceAll('&quot;', '"').replaceAll('&amp;', '&');
    const batch = new URLSearchParams(pagedQuery);
    batch.set('csrf', 'token'); batch.set('selection', selected);
    const saved = await fetch(`${base}/check-selected`, { method: 'POST', body: batch });
    assert.equal(saved.status, 200);
    const finalPage = await saved.text();
    assert.match(finalPage, /1 \/ 1 페이지/);
    assert.match(finalPage, /조건에 맞는 200건/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
