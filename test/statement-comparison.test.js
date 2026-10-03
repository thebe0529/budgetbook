import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { compareStatement } from '../src/statement-comparison.js';
import { entryFingerprint, setTransactionChecked } from '../src/transaction-checks.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book();
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
