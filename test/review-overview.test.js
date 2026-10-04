import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountRegister } from '../src/manual.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { compareStatement, saveStatementComparison, completeStatementReview } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { reviewOverview } from '../src/review-overview.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book();
  ensureOwner(book, 'owner');
  book.createAccount({ id: 'equity', name: '기초', type: 'equity' });
  return book;
}

function addAccount(book, id, { type = 'asset', name = id, date = '2026-10-01' } = {}) {
  book.createAccount({ id, name, type });
  book.record({ id: `opening:${id}`, date, postings: [
    { accountId: id, side: type === 'asset' ? 'debit' : 'credit', amount: 100 },
    { accountId: 'equity', side: type === 'asset' ? 'credit' : 'debit', amount: 100 }] });
}

function save(book, id, { throughDate = '2026-10-01', amount = '100', confirm = true, complete = false } = {}) {
  if (confirm) for (const row of accountRegister(book, 'owner', id, throughDate).rows) {
    setTransactionChecked(book, 'owner', id, row.id, true, row.confirmationHash);
  }
  const preview = compareStatement(book, 'owner', id, throughDate, amount);
  const saved = saveStatementComparison(book, 'owner', { accountId: id, throughDate, statementExpression: amount,
    expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
  if (complete) completeStatementReview(book, 'owner', saved.id);
  return saved;
}

test('overview distinguishes every review status and includes current locks without changing ledger', () => {
  const book = setup();
  try {
    for (const id of ['none', 'changed', 'difference', 'unchecked', 'ready', 'reviewed']) addAccount(book, id);
    save(book, 'changed');
    setTransactionChecked(book, 'owner', 'changed', 'opening:changed', false);
    save(book, 'difference', { amount: '120' });
    save(book, 'unchecked', { confirm: false });
    save(book, 'ready');
    const reviewed = save(book, 'reviewed', { complete: true });
    lockAccountPeriod(book, 'owner', reviewed.id, randomUUID());
    const entries = JSON.stringify(book.entries());
    const overview = reviewOverview(book, 'owner', '2026-10-01');
    assert.equal(overview.rows.length, 6);
    assert.deepEqual(Object.fromEntries(overview.rows.map(row => [row.account.id, row.status])), {
      changed: 'changed', difference: 'difference', none: 'none', ready: 'ready', reviewed: 'reviewed', unchecked: 'unchecked' });
    assert.equal(overview.attentionCount, 5);
    assert.equal(overview.uncheckedAccountCount, 3);
    assert.equal(overview.rows.find(row => row.account.id === 'reviewed').lockedThroughDate, '2026-10-01');
    assert.equal(overview.rows.find(row => row.account.id === 'difference').comparison.difference, 20);
    assert.equal(JSON.stringify(book.entries()), entries);
    assert.throws(() => reviewOverview(book, 'owner', '2026-02-30'));
  } finally { book.close(); }
});

test('overview scopes family accounts and separates earlier completed review from later unchecked movements', () => {
  const book = setup();
  try {
    addAccount(book, 'shared', { type: 'liability', date: '2026-09-30' });
    addAccount(book, 'private');
    setMember(book, 'owner', 'viewer', 'viewer', ['shared']);
    setMember(book, 'owner', 'empty', 'viewer', []);
    save(book, 'shared', { throughDate: '2026-09-30', complete: true });
    book.record({ id: 'next', date: '2026-10-01', postings: [
      { accountId: 'shared', side: 'credit', amount: 10 }, { accountId: 'equity', side: 'debit', amount: 10 }] });
    save(book, 'shared', { throughDate: '2026-10-05', amount: '110', confirm: false });
    const overview = reviewOverview(book, 'viewer', '2026-10-01');
    assert.equal(overview.rows.length, 1);
    const row = overview.rows[0];
    assert.equal(row.balance, 110);
    assert.equal(row.comparison.throughDate, '2026-09-30');
    assert.equal(row.status, 'reviewed');
    assert.equal(row.olderCutoff, true);
    assert.equal(row.uncheckedCount, 1);
    assert.equal(row.needsAttention, true);
    assert.equal(reviewOverview(book, 'empty', '2026-10-01').rows.length, 0);
    assert.equal(reviewOverview(book, 'viewer', '2026-09-29').rows[0].balance, 0);
    assert.equal(reviewOverview(book, 'viewer', '2026-09-29').rows[0].comparison, null);
  } finally { book.close(); }
});

test('latest comparison uses save order rather than greatest cutoff date, including timestamp ties', () => {
  const book = setup();
  try {
    addAccount(book, 'bank', { date: '2026-09-01' });
    const first = save(book, 'bank', { throughDate: '2026-10-01', complete: true });
    const second = save(book, 'bank', { throughDate: '2026-09-30', amount: '120' });
    book.db.prepare('UPDATE statement_comparisons SET saved_at = ?').run('2026-10-04T00:00:00.000Z');
    const overview = reviewOverview(book, 'owner', '2026-10-01');
    assert.equal(overview.rows[0].comparison.id, second.id);
    assert.notEqual(overview.rows[0].comparison.id, first.id);
    assert.equal(overview.rows[0].status, 'difference');
  } finally { book.close(); }
});

test('overview HTTP supports attention filter and scoped links, escapes names and rejects invalid query', async () => {
  const book = setup();
  addAccount(book, 'shared', { name: '<script>공유</script>' });
  addAccount(book, 'done');
  addAccount(book, 'private', { name: '비공개 은행' });
  setMember(book, 'owner', 'viewer', 'viewer', ['shared', 'done']);
  save(book, 'done', { complete: true });
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'viewer', role: 'viewer', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/review-overview`;
  try {
    const response = await fetch(`${base}?throughDate=2026-10-01&status=attention`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /접근 가능한 2개 계좌 · 확인 필요 1개/);
    assert.match(html, /&lt;script&gt;공유&lt;\/script&gt;/);
    assert.ok(!html.includes('<script>공유</script>'));
    assert.ok(!html.includes('비공개 은행'));
    assert.ok(!html.includes('accountId=done'));
    assert.match(html, /accountId=shared&amp;throughDate=2026-10-01&amp;status=unchecked/);
    assert.equal((await fetch(`${base}?throughDate=2026-02-30`)).status, 400);
    assert.equal((await fetch(`${base}?status=bad`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
