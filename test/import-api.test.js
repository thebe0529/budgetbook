import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { createImportChannel, revokeImportChannel } from '../src/imports.js';
import { createImportApi } from '../src/import-api.js';

test('import API authenticates account-scoped channels, deduplicates and isolates status', async () => {
  const book = new Book();
  book.createAccount({ id: 'shinhan', name: '신한은행', type: 'asset' });
  book.createAccount({ id: 'hana', name: '하나은행', type: 'asset' });
  const shinhan = createImportChannel(book, { id: 'ch-shinhan', name: 'iPhone', accountId: 'shinhan' });
  const hana = createImportChannel(book, { id: 'ch-hana', name: 'Other', accountId: 'hana' });
  assert.ok(shinhan.token.length >= 43);
  assert.ok(!JSON.stringify(book.db.prepare('SELECT * FROM import_channels').all()).includes(shinhan.token));
  const server = createImportApi(book);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/import-events`;
  const post = (token, key, body) => fetch(url, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
    'Idempotency-Key': key,
  }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('bad', 'test-12345', { rawText: '입금' })).status, 401);
    const first = await post(shinhan.token, 'test-12345', { rawText: '신한 출금 10000원', externalId: 'bank-1' });
    assert.equal(first.status, 202);
    const firstBody = await first.json();
    assert.equal(firstBody.status, 'pending-review');
    const retry = await post(shinhan.token, 'test-12345', { rawText: '신한 출금 10000원', externalId: 'bank-1' });
    assert.equal(retry.status, 200);
    assert.equal((await retry.json()).id, firstBody.id);
    assert.equal((await post(shinhan.token, 'test-67890',
      { rawText: '신한 출금 20000원', externalId: 'bank-1' })).status, 409);
    assert.equal((await post(shinhan.token, 'test-12345',
      { rawText: '신한 출금 20000원', externalId: 'bank-2' })).status, 409);
    const eventUrl = `${url}/${firstBody.id}`;
    const own = await fetch(eventUrl, { headers: { Authorization: `Bearer ${shinhan.token}` } });
    assert.equal((await own.json()).accountId, 'shinhan');
    assert.equal((await fetch(eventUrl, { headers: { Authorization: `Bearer ${hana.token}` } })).status, 404);
    assert.equal(book.entries().length, 0); // No unreviewed event enters the ledger.
    assert.equal(revokeImportChannel(book, shinhan.id), true);
    assert.equal((await post(shinhan.token, 'test-99999', { rawText: 'test' })).status, 401);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    book.close();
  }
});

test('import API rejects malformed, oversized and missing-key requests', async () => {
  const book = new Book();
  book.createAccount({ id: 'bank', name: '보통예금', type: 'asset' });
  const { token } = createImportChannel(book, { name: 'test', accountId: 'bank' });
  const server = createImportApi(book);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/v1/import-events`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  try {
    assert.equal((await fetch(url, { method: 'POST', headers,
      body: JSON.stringify({ rawText: 'test' }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'request-123' },
      body: JSON.stringify({ rawText: 'x'.repeat(20_000) }) })).status, 400);
    assert.equal((await fetch(url, { method: 'POST', headers: { ...headers, 'Idempotency-Key': 'request-123' },
      body: 'not-json' })).status, 400);
  } finally {
    await new Promise(resolve => server.close(resolve));
    book.close();
  }
});
