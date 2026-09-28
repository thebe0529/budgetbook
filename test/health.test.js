import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { createImportApi } from '../src/import-api.js';

test('health endpoint checks database access without exposing ledger data', async () => {
  const book = new Book();
  const server = createImportApi(book);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const healthy = await fetch(`${url}/healthz`);
    assert.equal(healthy.status, 204);
    assert.equal(await healthy.text(), '');
    book.close();
    const unhealthy = await fetch(`${url}/healthz`);
    assert.equal(unhealthy.status, 503);
    assert.deepEqual(await unhealthy.json(), { error: 'Unavailable' });
  } finally { await new Promise(resolve => server.close(resolve)); }
});
