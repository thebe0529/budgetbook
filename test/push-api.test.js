import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { createImportApi } from '../src/import-api.js';
import { issueApiKey, issueAccountKey, saveParserRules, getParserRules } from '../src/push-credentials.js';

const patterns = { amount: '금액\\s*([\\d,]+)', date: '(\\d{4}-\\d{2}-\\d{2})' };

test('API key identifies user, account key scopes account, configured regex parses in review inbox', async () => {
  const book = new Book();
  book.createAccount({ id: 'bank', name: '보통예금', type: 'asset' });
  book.createAccount({ id: 'other', name: '다른 계좌', type: 'asset' });
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
  const auth = { session: req => req.headers.cookie === 'test=valid' ?
    { sub: 'owner', csrf: 'csrf-value' } : null };
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
