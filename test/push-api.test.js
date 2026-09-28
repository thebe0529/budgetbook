import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { createImportApi } from '../src/import-api.js';
import { issueApiKey, issueAccountKey, saveParserRules, getParserRules } from '../src/push-credentials.js';
import { ensureOwner, setMember, removeMember } from '../src/members.js';
import { approveEvent, listReviewEvents } from '../src/review.js';

const patterns = { amount: '금액\\s*([\\d,]+)', date: '(\\d{4}-\\d{2}-\\d{2})' };

test('API key identifies user, account key scopes account, configured regex parses in review inbox', async () => {
  const book = new Book();
  book.createAccount({ id: 'bank', name: '보통예금', type: 'asset' });
  book.createAccount({ id: 'other', name: '다른 계좌', type: 'asset' });
  ensureOwner(book, 'pocket-id-user-1');
  setMember(book, 'pocket-id-user-1', 'pocket-id-user-2', 'editor', ['other']);
  const userApi = issueApiKey(book, 'pocket-id-user-1');
  const userAccount = issueAccountKey(book, 'pocket-id-user-1', 'bank');
  const strangerAccount = issueAccountKey(book, 'pocket-id-user-2', 'other');
  saveParserRules(book, 'pocket-id-user-1', 'bank', patterns);
  assert.deepEqual(getParserRules(book, 'pocket-id-user-1', 'bank'), patterns);
  const server = createImportApi(book);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/push-events`;
  const request = (accountKey, rawText, key = 'notification-1') => fetch(url, { method: 'POST',
    headers: { Authorization: `Bearer ${userApi.key}`, 'Content-Type': 'application/json',
      'Idempotency-Key': key },
    body: JSON.stringify({ accountKey, rawText, externalId: key }) });
  try {
    assert.equal((await request(strangerAccount.key, '금액 100 2026-10-10')).status, 401);
    const first = await request(userAccount.key, '금액 12,000 2026-10-10');
    assert.equal(first.status, 202);
    const result = await first.json();
    assert.equal(result.status, 'parsed-pending-review');
    assert.equal((await request(userAccount.key, '금액 12,000 2026-10-10')).status, 200);
    const detail = await fetch(`${url}/${result.id}`, { headers: {
      Authorization: `Bearer ${userApi.key}`, 'X-Account-Key': userAccount.key } });
    assert.equal((await detail.json()).parsed.amount, 12_000);
    const failure = await request(userAccount.key, '비정형 알림', 'notification-2');
    assert.equal((await failure.json()).status, 'parse-error');
    assert.equal(book.entries().length, 0);
    assert.equal((await fetch('http://127.0.0.1:' + server.address().port + '/admin/regex')).status, 503);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('admin page requires authenticated session and CSRF token', async () => {
  const book = new Book();
  book.createAccount({ id: 'bank', name: '<생활비>', type: 'asset' });
  ensureOwner(book, 'owner');
  assert.throws(() => setMember(book, 'owner', 'owner', 'viewer', ['bank']), /Invalid member/);
  const auth = { session: req => req.headers.cookie === 'test=valid' ?
    { sub: 'owner', role: 'owner', csrf: 'csrf-value' } : null };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/admin/regex`;
  try {
    const unauthed = await fetch(url, { redirect: 'manual' });
    assert.equal(unauthed.status, 302);
    const page = await fetch(url, { headers: { Cookie: 'test=valid' } });
    assert.equal(page.status, 200);
    assert.ok((await page.text()).includes('&lt;생활비&gt;'));
    const invalid = await fetch(url, { method: 'POST', headers: {
      Cookie: 'test=valid', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'wrong', accountId: 'bank',
        action: 'save', ...patterns }) });
    assert.equal(invalid.status, 403);
    const saved = await fetch(url, { method: 'POST', headers: {
      Cookie: 'test=valid', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'csrf-value', accountId: 'bank',
        action: 'save', ...patterns }) });
    assert.equal(saved.status, 200);
    assert.deepEqual(getParserRules(book, 'owner', 'bank'), { ...patterns, payee: '', memo: '' });
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('family editor can approve own account import once; removed member loses key access', async () => {
  const book = new Book();
  book.createAccount({ id: 'bank', name: '예금', type: 'asset', onBudget: true, cash: true });
  book.createAccount({ id: 'other', name: '비공개', type: 'asset' });
  book.createAccount({ id: 'food', name: '식비', type: 'expense' });
  book.createAccount({ id: 'equity', name: '기초순자산', type: 'equity' });
  book.createBudgetCategory({ id: 'food-budget', name: '식비' });
  book.record({ id: 'opening', date: '2026-10-01', postings: [
    { accountId: 'bank', side: 'debit', amount: 100_000 },
    { accountId: 'equity', side: 'credit', amount: 100_000 },
  ] });
  ensureOwner(book, 'owner');
  setMember(book, 'owner', 'family-editor', 'editor', ['bank']);
  setMember(book, 'owner', 'family-reader', 'viewer', ['bank']);
  assert.throws(() => issueAccountKey(book, 'family-editor', 'other'), /permission/);
  assert.throws(() => issueApiKey(book, 'family-reader'), /Editor/);
  const key = issueApiKey(book, 'family-editor');
  const account = issueAccountKey(book, 'family-editor', 'bank');
  saveParserRules(book, 'family-editor', 'bank', patterns);
  const server = createImportApi(book);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/v1/push-events`, { method: 'POST', headers: {
      Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json',
      'Idempotency-Key': 'family-test-1' }, body: JSON.stringify({ accountKey: account.key,
        rawText: '2026-10-10 금액 20,000' }) });
    const { id } = await response.json();
    assert.equal(listReviewEvents(book, 'family-reader').length, 1);
    assert.equal(listReviewEvents(book, 'family-editor').length, 1);
    assert.equal(book.reports('2026-10-01', '2026-10-31').balanceSheet.accounts.bank, 100_000);
    assert.throws(() => approveEvent(book, 'family-reader', { eventId: id, kind: 'expense',
      counterAccountId: 'food', amount: 20_000, date: '2026-10-10' }), /write access/);
    assert.throws(() => approveEvent(book, 'family-editor', { eventId: id, kind: 'expense',
      counterAccountId: 'food', categoryId: 'missing', amount: 20_000, date: '2026-10-10' }), /category/);
    assert.equal(book.entries().length, 1);
    assert.equal(listReviewEvents(book, 'family-editor')[0].status, 'parsed-pending-review');
    const approved = approveEvent(book, 'family-editor', { eventId: id, kind: 'expense',
      counterAccountId: 'food', categoryId: 'food-budget', amount: 20_000, date: '2026-10-10' });
    assert.equal(approved.duplicate, false);
    assert.equal(approveEvent(book, 'family-editor', { eventId: id }).duplicate, true);
    assert.equal(book.entries().length, 2);
    assert.equal(book.reports('2026-10-01', '2026-10-31').balanceSheet.accounts.bank, 80_000);
    assert.equal(book.budget('2026-10').categories['food-budget'].spent, 20_000);
    assert.ok(listReviewEvents(book, 'family-editor')[0].approvedBy === 'family-editor');
    assert.equal(listReviewEvents(book, 'family-reader')[0].approvedEntryId, `import:${id}`);
    removeMember(book, 'owner', 'family-editor');
    assert.equal((await fetch(`${base}/api/v1/push-events`, { method: 'POST', headers: {
      Authorization: `Bearer ${key.key}`, 'Content-Type': 'application/json',
      'Idempotency-Key': 'family-test-2' }, body: JSON.stringify({ accountKey: account.key,
        rawText: '2026-10-10 금액 100' }) })).status, 401);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
