import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { createLedgerAccount, recordManual } from '../src/manual.js';
import { backupSettings, configureBackups, createBackupManager, listBackups } from '../src/backups.js';
import { createImportApi } from '../src/import-api.js';
import { randomUUID } from 'node:crypto';

test('online backup copies committed ledger, respects daily interval and prunes older copies', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'budgetbook-backups-'));
  const book = new Book(join(temp, 'ledger.sqlite'));
  try {
    ensureOwner(book, 'owner');
    const cash = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', cash: true });
    const equity = createLedgerAccount(book, 'owner', { name: '기초', type: 'equity' });
    setMember(book, 'owner', 'viewer', 'viewer', [cash.id]);
    recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-10-01', kind: 'opening',
      accountId: cash.id, counterId: equity.id, amountExpression: '10000' });
    const manager = createBackupManager(book, join(temp, 'copies'));
    assert.deepEqual(backupSettings(book, 'owner'), { intervalDays: 1, keepCount: 30 });
    assert.throws(() => configureBackups(book, 'viewer', { intervalDays: 1, keepCount: 1 }), /Owner/);
    configureBackups(book, 'owner', { intervalDays: 1, keepCount: 1 });
    const first = await manager.runIfDue();
    assert.equal(listBackups(book, 'owner').length, 1);
    assert.equal(await manager.runIfDue(new Date()), null);
    const copy = new Book(join(temp, 'copies', first.filename));
    try {
      assert.equal(copy.entries().length, 1);
      assert.equal(copy.reports('2026-10-01', '2026-10-31').balanceSheet.assets, 10000);
    } finally { copy.close(); }
    const second = await manager.run();
    assert.equal(listBackups(book, 'owner').length, 1);
    assert.equal(listBackups(book, 'owner')[0].filename, second.filename);
    assert.deepEqual(await readdir(join(temp, 'copies')), [second.filename]);
  } finally { book.close(); await rm(temp, { recursive: true, force: true }); }
});

test('only owner can configure or manually trigger backup in admin UI', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'budgetbook-backup-web-'));
  const book = new Book(join(temp, 'ledger.sqlite'));
  ensureOwner(book, 'owner');
  setMember(book, 'owner', 'viewer', 'viewer', []);
  book.backupManager = createBackupManager(book, join(temp, 'copies'));
  const auth = { session: req => ({ sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner',
    role: req.headers.cookie === 'viewer=1' ? 'viewer' : 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await fetch(`${url}/admin/backups`, { headers: { Cookie: 'viewer=1' } })).status, 400);
    assert.equal((await fetch(`${url}/admin/backups/run`, { method: 'POST',
      body: new URLSearchParams({ csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(`${url}/admin/backups/run`, { method: 'POST',
      headers: { Cookie: 'viewer=1' }, body: new URLSearchParams({ csrf: 'token' }) })).status, 400);
    assert.equal((await fetch(`${url}/admin/backups/run`, { method: 'POST',
      body: new URLSearchParams({ csrf: 'token' }) })).status, 200);
    assert.equal(listBackups(book, 'owner').length, 1);
  } finally {
    await new Promise(resolve => server.close(resolve));
    book.close(); await rm(temp, { recursive: true, force: true });
  }
});
