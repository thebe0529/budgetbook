import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordManual, accountRegister } from '../src/manual.js';
import { recordSplitManual } from '../src/split-manual.js';
import { tagEditPreview, transactionTags, updateTransactionTags, updateSelectedTags } from '../src/transaction-tags.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { transactionHistory } from '../src/transaction-history.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { manualEditPreview, updateManualTransaction } from '../src/manual-edit.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const [id, type] of [['bank', 'asset'], ['private', 'asset'], ['expense', 'expense']]) {
    book.createAccount({ id, name: id, type, onBudget: id === 'bank' });
  }
  book.createBudgetCategory({ id: 'food', name: '식비' });
  setMember(book, 'owner', 'editor', 'editor', ['bank']);
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  return book;
}
const create = (book, overrides = {}, sub = 'editor') => recordManual(book, sub, { requestId: randomUUID(),
  date: '2026-10-01', kind: 'expense', accountId: 'bank', counterId: 'expense', categoryId: 'food',
  amountExpression: '500', memo: '점심', ...overrides }).entry;
const selection = (book, entry) => ({ entryId: entry.id, expectedHash: entryFingerprint(entry), tagsHash: transactionTags(book, entry.id).tagsHash });
const request = (book, entries, tags = '여행', mode = 'add') => ({ accountId: 'bank', mode, tags,
  selections: entries.map(entry => selection(book, entry)), requestId: randomUUID() });
const set = (book, entry, tags) => updateTransactionTags(book, 'owner', { ...tagEditPreview(book, 'owner', 'bank', entry.id),
  accountId: 'bank', entryId: entry.id, tags, requestId: randomUUID() });
const count = (book, table) => book.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;

test('bulk tag add, remove and replace preserve independent tags, accounting and checks with per-entry audit', () => {
  const book = setup();
  try {
    const first = create(book);
    const second = recordSplitManual(book, 'editor', { requestId: randomUUID(), date: '2026-10-02', kind: 'expense',
      accountId: 'bank', lines: [100, 200].map(amount => ({ counterId: 'expense', amountExpression: String(amount), categoryId: 'food' })) }).entry;
    set(book, first, '점심'); set(book, second, '분할');
    for (const entry of [first, second]) setTransactionChecked(book, 'editor', 'bank', entry.id, true, entryFingerprint(entry));
    const before = book.entries(); const budget = book.budget('2026-10');
    assert.deepEqual(updateSelectedTags(book, 'editor', request(book, [first, second])), { count: 2, changed: 2, duplicate: false });
    assert.deepEqual(transactionTags(book, first.id).tags, ['여행', '점심']);
    assert.deepEqual(transactionTags(book, second.id).tags, ['분할', '여행']);
    const audit = transactionHistory(book, 'viewer', 'bank', first.id).tagChanges.at(-1);
    assert.deepEqual(audit.before, ['점심']); assert.deepEqual(audit.after, ['여행', '점심']); assert.equal(audit.actor, 'editor');
    updateSelectedTags(book, 'editor', request(book, [first, second], '여행', 'remove'));
    assert.deepEqual(transactionTags(book, first.id).tags, ['점심']); assert.deepEqual(transactionTags(book, second.id).tags, ['분할']);
    updateSelectedTags(book, 'editor', request(book, [first, second], '공통', 'replace'));
    assert.ok([first, second].every(entry => transactionTags(book, entry.id).tags.join() === '공통'));
    updateSelectedTags(book, 'editor', request(book, [first, second], '', 'replace'));
    assert.deepEqual(book.entries(), before); assert.deepEqual(book.budget('2026-10'), budget);
    assert.equal(accountRegister(book, 'viewer', 'bank', '2026-10-31').uncheckedCount, 0);
    assert.ok([first, second].every(entry => !transactionTags(book, entry.id).tags.length));
  } finally { book.close(); }
});

test('bulk tag receipts canonicalize order and preserve later edits; unchanged rows produce no audit', () => {
  const book = setup();
  try {
    const entries = [create(book), create(book)]; const input = request(book, entries, ' 여행,점심,여행 ');
    updateSelectedTags(book, 'editor', input);
    assert.equal(updateSelectedTags(book, 'editor', { ...input, tags: '점심, 여행', selections: [...input.selections].reverse() }).duplicate, true);
    set(book, entries[0], '나중 수정');
    assert.equal(updateSelectedTags(book, 'editor', input).duplicate, true);
    assert.deepEqual(transactionTags(book, entries[0].id).tags, ['나중 수정']);
    assert.throws(() => updateSelectedTags(book, 'editor', { ...input, mode: 'remove' }), /reused/);
    const before = count(book, 'transaction_tag_changes');
    assert.equal(updateSelectedTags(book, 'editor', request(book, entries, '없는 태그', 'remove')).changed, 0);
    assert.equal(count(book, 'transaction_tag_changes'), before);
    const maxTags = Array.from({ length: 10 }, (_, i) => `${i}${'a'.repeat(29)}`).join(',');
    set(book, entries[0], maxTags);
    assert.equal(updateSelectedTags(book, 'editor', request(book, [entries[0]], maxTags)).changed, 0);
  } finally { book.close(); }
});

test('later tag limit, stale metadata, ledger or audit errors roll back all earlier writes and receipts', () => {
  const book = setup();
  try {
    const first = create(book, { requestId: '00000000-0000-4000-8000-000000000001' });
    const second = create(book, { requestId: '00000000-0000-4000-8000-000000000002' });
    set(book, second, Array.from({ length: 10 }, (_, i) => `tag${i}`).join(','));
    assert.throws(() => updateSelectedTags(book, 'editor', request(book, [first, second])), /ten tags/);
    assert.deepEqual(transactionTags(book, first.id).tags, []);
    const stale = request(book, [first, second], '교체', 'replace'); set(book, second, '새 태그');
    assert.throws(() => updateSelectedTags(book, 'editor', stale), /changed/);
    assert.deepEqual(transactionTags(book, first.id).tags, []);
    const ledgerStale = request(book, [first, second]);
    const edit = manualEditPreview(book, 'editor', second.id);
    updateManualTransaction(book, 'editor', { ...edit.input, entryId: second.id, expectedHash: edit.expectedHash,
      updateRequestId: randomUUID(), memo: '수정' });
    assert.throws(() => updateSelectedTags(book, 'editor', ledgerStale), /changed/);
    assert.deepEqual(transactionTags(book, first.id).tags, []);
    const current = book.entries(); const input = request(book, current);
    book.db.exec(`CREATE TRIGGER reject_bulk_receipt BEFORE INSERT ON bulk_tag_requests
      BEGIN SELECT RAISE(ABORT, 'Receipt unavailable'); END;`);
    const auditBefore = count(book, 'transaction_tag_changes');
    assert.throws(() => updateSelectedTags(book, 'editor', input), /Receipt unavailable/);
    assert.equal(count(book, 'transaction_tag_changes'), auditBefore); assert.equal(count(book, 'bulk_tag_requests'), 0);
    assert.deepEqual(transactionTags(book, first.id).tags, []);
    book.db.exec('DROP TRIGGER reject_bulk_receipt'); assert.equal(updateSelectedTags(book, 'editor', input).changed, 2);
  } finally { book.close(); }
});

test('bulk tags reject invalid selections, foreign author, inaccessible transfer, canceled and imported transactions', () => {
  const book = setup();
  try {
    const good = create(book); const foreign = create(book, {}, 'owner');
    const transfer = create(book, { kind: 'transfer', counterId: 'private', categoryId: null }, 'owner');
    const canceled = create(book);
    reverseManualTransaction(book, 'editor', { entryId: canceled.id, date: '2026-10-02', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'editor', canceled.id).expectedHash, requestId: randomUUID() });
    const outside = create(book, { accountId: 'private', categoryId: null }, 'owner');
    book.record({ id: 'import', date: '2026-10-01', kind: 'import', postings: good.postings });
    for (const bad of [foreign, transfer, canceled, outside, book.entries().find(e => e.id === 'import')]) {
      assert.throws(() => updateSelectedTags(book, 'editor', request(book, [good, bad])));
    }
    const input = request(book, [good]);
    for (const overrides of [{ selections: [] }, { selections: [null] }, { selections: [input.selections[0], input.selections[0]] },
      { selections: Array.from({ length: 201 }, () => input.selections[0]) }, { selections: [{ ...input.selections[0], tagsHash: null }] },
      { requestId: 'bad' }, { mode: 'unknown' }, { tags: '' }, { tags: null }]) {
      assert.throws(() => updateSelectedTags(book, 'editor', { ...input, ...overrides }));
    }
    assert.throws(() => updateSelectedTags(book, 'viewer', input), /write access/);
    assert.equal(count(book, 'transaction_tag_changes'), 0); assert.equal(count(book, 'bulk_tag_requests'), 0);
  } finally { book.close(); }
});

test('bulk tag receipt and audit survive a database reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'budgetbook-bulk-tags-')); let book;
  try {
    const filename = join(dir, 'book.sqlite'); book = setup(filename);
    const entry = create(book); const input = request(book, [entry]);
    updateSelectedTags(book, 'editor', input); book.close(); book = new Book(filename);
    assert.equal(updateSelectedTags(book, 'editor', input).duplicate, true);
    assert.deepEqual(transactionTags(book, entry.id).tags, ['여행']); assert.equal(count(book, 'transaction_tag_changes'), 1);
    assert.equal(transactionHistory(book, 'viewer', 'bank', entry.id).tagChanges.length, 1);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP bulk tags permit checked locked selections, protect CSRF and retain tag search and sorting', async () => {
  const book = setup(); const entry = create(book); set(book, entry, '여행'); let sub = 'editor';
  setTransactionChecked(book, 'owner', 'bank', entry.id, true, entryFingerprint(entry));
  const compared = compareStatement(book, 'owner', 'bank', '2026-10-31', '-500');
  const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-31',
    statementExpression: '-500', expectedHash: compared.stateHash, requestId: randomUUID() }).saved;
  completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/register`;
  try {
    const html = await (await fetch(`${base}?accountId=bank&tag=${encodeURIComponent('여행')}&sort=memo-desc&status=checked`)).text();
    assert.match(html, /name="selection"/); assert.match(html, /formaction="\/admin\/register\/tags-selected"/);
    assert.match(html, /&quot;tagsHash&quot;/);
    const form = new URLSearchParams({ accountId: 'bank', csrf: 'bad', tag: '여행', sort: 'memo-desc', status: 'checked',
      requestId: randomUUID(), tagMode: 'remove', newTags: '여행', selection: JSON.stringify(selection(book, entry)) });
    const send = () => fetch(`${base}/tags-selected`, { method: 'POST', body: form });
    assert.equal((await send()).status, 403); form.set('csrf', 'token'); sub = 'viewer'; assert.equal((await send()).status, 400);
    sub = 'editor'; const response = await send(); assert.equal(response.status, 200);
    const after = await response.text(); assert.match(after, /조건에 맞는 0건/); assert.match(after, /name="tag" maxlength="30" value="여행"/);
    assert.match(after, /value="memo-desc" selected/); assert.match(after, /value="checked" selected/);
    assert.equal(accountRegister(book, 'viewer', 'bank', '2026-10-31').uncheckedCount, 0);
    assert.equal(compareStatement(book, 'owner', 'bank', '2026-10-31', '-500').stateHash, compared.stateHash);
    assert.equal((await send()).status, 200); assert.equal(count(book, 'bulk_tag_requests'), 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
