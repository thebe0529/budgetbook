import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureOwner, setMember } from '../src/members.js';
import { compareStatement, completeStatementReview, saveStatementComparison, statementComparisonHistory } from '../src/statement-comparison.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename);
  ensureOwner(book, 'owner');
  for (const [id, name, type] of [['bank', '공유 은행', 'asset'], ['private', '비공개 은행', 'asset'],
    ['card', '신용카드', 'liability'], ['equity', '기초', 'equity'], ['expense', '식비', 'expense']]) {
    book.createAccount({ id, name, type });
  }
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  const post = (id, date, debit, credit, amount) => book.record({ id, date, postings: [
    { accountId: debit, side: 'debit', amount }, { accountId: credit, side: 'credit', amount }] });
  post('opening', '2026-09-30', 'bank', 'equity', 10000);
  post('purchase', '2026-10-01', 'expense', 'bank', 2000);
  post('future', '2026-10-02', 'expense', 'bank', 1000);
  post('debt', '2026-10-01', 'expense', 'card', 5000);
  post('payment', '2026-10-02', 'card', 'bank', 3000);
  return book;
}

function savePreview(book, statementExpression = '8000') {
  const preview = compareStatement(book, 'owner', 'bank', '2026-10-01', statementExpression);
  return saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-01',
    statementExpression, expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
}

function confirmCutoff(book) {
  for (const entry of book.entries().filter(entry => ['opening', 'purchase'].includes(entry.id))) {
    setTransactionChecked(book, 'owner', 'bank', entry.id, true, entryFingerprint(entry));
  }
}

test('review completion requires unchanged comparison, matching balance and every transaction confirmed', () => {
  const book = setup();
  try {
    const unchecked = savePreview(book);
    assert.throws(() => completeStatementReview(book, 'owner', unchecked.id), /all transactions confirmed/);
    confirmCutoff(book);
    assert.throws(() => completeStatementReview(book, 'owner', unchecked.id), /changed/);
    const mismatched = savePreview(book, '8500');
    assert.throws(() => completeStatementReview(book, 'owner', mismatched.id), /Matching balance/);
    const ready = savePreview(book);
    assert.throws(() => completeStatementReview(book, 'viewer', ready.id), /write access/);
    assert.throws(() => completeStatementReview(book, 'owner', 'missing'), /not found/);
    const original = JSON.stringify(book.entries());
    const completed = completeStatementReview(book, 'owner', ready.id);
    assert.equal(completed.duplicate, false);
    assert.equal(completeStatementReview(book, 'owner', ready.id).duplicate, true);
    assert.equal(completeStatementReview(book, 'owner', ready.id).review.completedAt, completed.review.completedAt);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM statement_reviews').get().count, 1);
    assert.equal(JSON.stringify(book.entries()), original);
    const history = statementComparisonHistory(book, 'viewer', 'bank').find(item => item.id === ready.id);
    assert.equal(history.review.actor, 'owner');
    assert.equal(history.changed, false);
    setTransactionChecked(book, 'owner', 'bank', 'purchase', false);
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank').find(item => item.id === ready.id).changed, true);
    assert.throws(() => completeStatementReview(book, 'owner', ready.id), /changed/);
  } finally { book.close(); }
});

test('completed review persists and backdated transactions invalidate it without locking the ledger', () => {
  const directory = mkdtempSync(join(tmpdir(), 'review-'));
  const filename = join(directory, 'book.sqlite');
  let book = setup(filename);
  try {
    confirmCutoff(book);
    const ready = savePreview(book);
    const completed = completeStatementReview(book, 'owner', ready.id);
    book.close(); book = new Book(filename);
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].review.completedAt, completed.review.completedAt);
    book.record({ id: 'later', date: '2026-10-03', postings: [
      { accountId: 'expense', side: 'debit', amount: 100 }, { accountId: 'bank', side: 'credit', amount: 100 }] });
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].changed, false);
    book.record({ id: 'earlier', date: '2026-09-29', postings: [
      { accountId: 'expense', side: 'debit', amount: 100 }, { accountId: 'bank', side: 'credit', amount: 100 }] });
    const history = statementComparisonHistory(book, 'viewer', 'bank')[0];
    assert.equal(history.changed, true);
    assert.equal(history.ledgerBalance, 8000);
    assert.equal(history.review.completedAt, completed.review.completedAt);
  } finally { book.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('review completion HTTP enforces CSRF and access and shows completion followed by changes', async () => {
  const book = setup();
  setMember(book, 'owner', 'editor', 'editor', ['bank']);
  confirmCutoff(book);
  const ready = savePreview(book);
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'editor', role: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/balance-check`;
  const body = { csrf: 'token', comparisonId: ready.id };
  try {
    const page = await (await fetch(`${base}?accountId=bank`)).text();
    assert.match(page, /검토 완료 표시/);
    const viewer = await (await fetch(`${base}?accountId=bank`, { headers: { Cookie: 'viewer=1' } })).text();
    assert.ok(!viewer.includes('action="/admin/balance-check/complete"'));
    assert.equal((await fetch(`${base}/complete`, { method: 'POST', body: new URLSearchParams({ ...body, csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(`${base}/complete`, { method: 'POST', headers: { Cookie: 'viewer=1' }, body: new URLSearchParams(body) })).status, 400);
    const result = await fetch(`${base}/complete`, { method: 'POST', body: new URLSearchParams(body) });
    assert.equal(result.status, 200);
    assert.match(await result.text(), /검토 완료를 표시했습니다/);
    setTransactionChecked(book, 'owner', 'bank', 'purchase', false);
    const changed = await (await fetch(`${base}?accountId=bank`)).text();
    assert.match(changed, /완료 후 변경됨 · 재검토 필요/);
    assert.equal((await fetch(`${base}/complete`, { method: 'POST', body: new URLSearchParams(body) })).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('statement comparison includes opening and cutoff date, separates confirmed movement and changes no data', () => {
  const book = setup();
  try {
    const entry = book.entries().find(entry => entry.id === 'opening');
    setTransactionChecked(book, 'owner', 'bank', entry.id, true, entryFingerprint(entry));
    const before = JSON.stringify(book.entries());
    const comparison = compareStatement(book, 'viewer', 'bank', '2026-10-01', '9000-500');
    assert.equal(comparison.ledgerBalance, 8000);
    assert.equal(comparison.statementBalance, 8500);
    assert.equal(comparison.difference, 500);
    assert.equal(comparison.checkedBalance, 10000);
    assert.equal(comparison.uncheckedMovement, -2000);
    assert.equal(comparison.uncheckedCount, 1);
    assert.equal(comparison.transactionCount, 2);
    assert.equal(compareStatement(book, 'viewer', 'bank', '2026-10-01', '8000').difference, 0);
    assert.equal(compareStatement(book, 'viewer', 'bank', '2026-10-02', '0').difference, -4000);
    assert.equal(JSON.stringify(book.entries()), before);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM account_entry_checks').get().count, 1);
  } finally { book.close(); }
});

test('saved comparison remains immutable, rejects stale saves and detects later confirmation changes', () => {
  const book = setup();
  try {
    const preview = compareStatement(book, 'owner', 'bank', '2026-10-01', '8500');
    const input = { accountId: 'bank', throughDate: '2026-10-01', statementExpression: '8500',
      expectedHash: preview.stateHash, requestId: randomUUID() };
    const saved = saveStatementComparison(book, 'owner', input);
    assert.equal(saved.duplicate, false);
    assert.equal(saved.saved.difference, 500);
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].changed, false);
    const future = book.entries().find(entry => entry.id === 'future');
    setTransactionChecked(book, 'owner', 'bank', future.id, true, entryFingerprint(future));
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].changed, false);
    const opening = book.entries().find(entry => entry.id === 'opening');
    setTransactionChecked(book, 'owner', 'bank', opening.id, true, entryFingerprint(opening));
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].changed, true);
    assert.equal(saveStatementComparison(book, 'owner', input).duplicate, true);
    assert.throws(() => saveStatementComparison(book, 'owner', { ...input, requestId: randomUUID() }), /changed/);
    assert.throws(() => saveStatementComparison(book, 'owner', { ...input, statementExpression: '8000' }), /reused/);
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].uncheckedCount, 2);
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM statement_comparisons').get().count, 1);
    assert.equal(book.entries().length, 5);
  } finally { book.close(); }
});

test('comparison history persists across reopen and respects read and write permissions', () => {
  const directory = mkdtempSync(join(tmpdir(), 'comparison-'));
  const filename = join(directory, 'book.sqlite');
  let book = setup(filename);
  try {
    const input = { accountId: 'bank', throughDate: '2026-10-01', statementExpression: '8000',
      expectedHash: compareStatement(book, 'owner', 'bank', '2026-10-01', '8000').stateHash, requestId: randomUUID() };
    assert.throws(() => saveStatementComparison(book, 'viewer', input), /write access/);
    assert.throws(() => statementComparisonHistory(book, 'viewer', 'private'), /read access/);
    assert.throws(() => saveStatementComparison(book, 'owner', { ...input, requestId: 'bad' }), /request ID/);
    saveStatementComparison(book, 'owner', input);
    book.close(); book = new Book(filename);
    const saved = statementComparisonHistory(book, 'viewer', 'bank')[0];
    assert.equal(saved.id, input.requestId);
    assert.equal(saved.changed, false);
    book.record({ id: 'backdated', date: '2026-10-01', postings: [
      { accountId: 'expense', side: 'debit', amount: 100 }, { accountId: 'bank', side: 'credit', amount: 100 }] });
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].changed, true);
    assert.equal(statementComparisonHistory(book, 'viewer', 'bank')[0].ledgerBalance, 8000);
  } finally { book.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('comparison save endpoint checks CSRF and write access, retries safely and renders history', async () => {
  const book = setup();
  setMember(book, 'owner', 'editor', 'editor', ['bank']);
  const server = createImportApi(book, { auth: { session: req => ({
    sub: req.headers.cookie === 'viewer=1' ? 'viewer' : 'editor', role: 'editor', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/balance-check`;
  const body = { csrf: 'token', accountId: 'bank', throughDate: '2026-10-01', statementBalance: '8000',
    expectedHash: compareStatement(book, 'editor', 'bank', '2026-10-01', '8000').stateHash, requestId: randomUUID() };
  try {
    const viewerPage = await (await fetch(`${base}?accountId=bank&statementBalance=8000`, { headers: { Cookie: 'viewer=1' } })).text();
    assert.ok(!viewerPage.includes('action="/admin/balance-check/save"'));
    assert.equal((await fetch(`${base}/save`, { method: 'POST', body: new URLSearchParams({ ...body, csrf: 'bad' }) })).status, 403);
    assert.equal((await fetch(`${base}/save`, { method: 'POST', headers: { Cookie: 'viewer=1' }, body: new URLSearchParams(body) })).status, 400);
    for (let i = 0; i < 2; i++) {
      const response = await fetch(`${base}/save`, { method: 'POST', body: new URLSearchParams(body) });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /저장 당시와 동일/);
    }
    assert.equal(book.db.prepare('SELECT COUNT(*) AS count FROM statement_comparisons').get().count, 1);
    const stale = await fetch(`${base}/save`, { method: 'POST', body: new URLSearchParams({ ...body,
      requestId: randomUUID(), expectedHash: 'stale' }) });
    assert.equal(stale.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('statement comparison uses positive liability balances and rejects unauthorized or invalid comparisons', () => {
  const book = setup();
  try {
    assert.equal(compareStatement(book, 'owner', 'card', '2026-10-01', '5000').difference, 0);
    assert.equal(compareStatement(book, 'owner', 'card', '2026-10-02', '2000').difference, 0);
    assert.equal(compareStatement(book, 'owner', 'bank', '2026-09-01', '-100').difference, -100);
    assert.throws(() => compareStatement(book, 'viewer', 'private', '2026-10-01', '0'), /read access/);
    assert.throws(() => compareStatement(book, 'owner', 'expense', '2026-10-01', '0'), /Asset or liability/);
    assert.throws(() => compareStatement(book, 'owner', 'bank', '2026-02-30', '0'));
    for (const expression of ['', 'foo()', '1/0', '9007199254740992', '-9007199254740991']) {
      assert.throws(() => compareStatement(book, 'owner', 'bank', '2026-10-01', expression));
    }
  } finally { book.close(); }
});

test('statement comparison page scopes family accounts, links cutoff transactions and validates input', async () => {
  const book = setup();
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'viewer', role: 'viewer', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/balance-check`;
  try {
    const form = await (await fetch(base)).text();
    assert.match(form, /공유 은행/);
    assert.ok(!form.includes('비공개 은행'));
    const response = await fetch(`${base}?accountId=bank&throughDate=2026-10-01&statementBalance=8000`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /기준일 잔액이 일치합니다/);
    assert.match(html, /미확인 2건/);
    assert.match(html, /throughDate=2026-10-01&amp;status=unchecked/);
    assert.equal((await fetch(`${base}?accountId=private&statementBalance=0`)).status, 400);
    assert.equal((await fetch(`${base}?accountId=bank&throughDate=2026-02-30&statementBalance=0`)).status, 400);
    const malicious = await fetch(`${base}?accountId=bank&statementBalance=${encodeURIComponent('<script>bad()</script>')}`);
    assert.equal(malicious.status, 400);
    assert.ok(!(await malicious.text()).includes('<script>bad()</script>'));
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
