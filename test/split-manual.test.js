import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountRegister, createCategory, createLedgerAccount, recordManual } from '../src/manual.js';
import { editableManual, recordSplitManual, updateSplitManual } from '../src/split-manual.js';
import { createImportApi } from '../src/import-api.js';

test('split rows post once to source and editing updates budget with revision history', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset', onBudget: true });
    const food = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
    const transport = createLedgerAccount(book, 'owner', { name: '교통', type: 'expense' });
    const category = createCategory(book, 'owner', '생활비');
    setMember(book, 'owner', 'editor', 'editor', [bank.id]);
    setMember(book, 'owner', 'viewer', 'viewer', [bank.id]);
    const input = { requestId: randomUUID(), date: '2026-10-10', kind: 'expense',
      accountId: bank.id, memo: '장보기', lines: [
        { counterId: food.id, amountExpression: '10000+2500', categoryId: category.id },
        { counterId: transport.id, amountExpression: '3000', categoryId: category.id },
      ] };
    const first = recordSplitManual(book, 'editor', input);
    assert.equal(first.duplicate, false);
    assert.equal(recordSplitManual(book, 'editor', input).duplicate, true);
    assert.equal(accountRegister(book, 'editor', bank.id, '2026-10-31').balance, -15_500);
    assert.equal(book.budget('2026-10').categories[category.id].spent, 15_500);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.expenses, 15_500);
    assert.equal(editableManual(book, 'viewer', first.entry.id), null);
    assert.throws(() => updateSplitManual(book, 'viewer', first.entry.id, 1, input), /cannot be edited/);
    assert.throws(() => recordSplitManual(book, 'editor', { ...input, memo: '다른 거래' }), /reused/);
    assert.throws(() => updateSplitManual(book, 'editor', first.entry.id, 1, { ...input,
      lines: [{ ...input.lines[0], amountExpression: '7000' },
        { ...input.lines[1], categoryId: null }] }), /All expense splits/);
    assert.equal(book.entries()[0].revision, 1);
    const next = updateSplitManual(book, 'editor', first.entry.id, 1, { ...input,
      lines: [{ ...input.lines[0], amountExpression: '7000' },
        { ...input.lines[1], amountExpression: '2000' }] });
    assert.equal(next.revision, 2);
    assert.equal(book.entries().length, 1);
    assert.equal(accountRegister(book, 'owner', bank.id, '2026-10-31').balance, -9000);
    assert.equal(book.budget('2026-10').categories[category.id].spent, 9000);
    assert.throws(() => updateSplitManual(book, 'editor', first.entry.id, 1, input), /reload/);
    const history = book.db.prepare('SELECT revision, actor_sub, data FROM entry_revisions WHERE entry_id = ?')
      .all(first.entry.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].actor_sub, 'editor');
    assert.equal(JSON.parse(history[0].data).postings[2].amount, 15_500);
  } finally { book.close(); }
});

test('split entry page accepts repeated rows with CSRF and offers an edit link', async () => {
  const book = new Book();
  ensureOwner(book, 'owner');
  const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset' });
  const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
  const auth = { session: () => ({ sub: 'owner', role: 'owner', csrf: 'token' }) };
  const server = createImportApi(book, { auth });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${url}/admin/split?accountId=${bank.id}`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /id="split-rows"/);
    const script = await fetch(`${url}/admin/assets/split.js`);
    assert.equal(script.status, 200);
    assert.match(await script.text(), /addRow/);
    const body = new URLSearchParams({ csrf: 'token', accountId: bank.id, requestId: randomUUID(),
      kind: 'expense', date: '2026-12-01', memo: '행 입력' });
    for (const amount of ['500+200', '300']) {
      body.append('counterId', expense.id);
      body.append('lineAmount', amount);
      body.append('lineCategory', '');
    }
    const denied = await fetch(`${url}/admin/split`, { method: 'POST', body: new URLSearchParams({
      ...Object.fromEntries(body), csrf: 'invalid',
    }) });
    assert.equal(denied.status, 403);
    const response = await fetch(`${url}/admin/split`, { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.match(await response.text(), /분할 거래 수정/);
    assert.equal(accountRegister(book, 'owner', bank.id, '2026-12-31').balance, -1000);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('split transfer enforces destination rights and imported or simple entries cannot be edited', () => {
  const book = new Book();
  try {
    ensureOwner(book, 'owner');
    const bank = createLedgerAccount(book, 'owner', { name: '은행', type: 'asset' });
    const savings = createLedgerAccount(book, 'owner', { name: '저축', type: 'asset' });
    const card = createLedgerAccount(book, 'owner', { name: '카드', type: 'liability' });
    const expense = createLedgerAccount(book, 'owner', { name: '식비', type: 'expense' });
    setMember(book, 'owner', 'editor', 'editor', [bank.id]);
    const input = { requestId: randomUUID(), date: '2026-11-01', kind: 'transfer',
      accountId: bank.id, lines: [
        { counterId: savings.id, amountExpression: '200' },
        { counterId: card.id, amountExpression: '300' },
      ] };
    assert.throws(() => recordSplitManual(book, 'editor', input), /destination access/);
    const first = recordSplitManual(book, 'owner', input);
    assert.equal(book.entries()[0].postings.length, 3);
    assert.equal(accountRegister(book, 'owner', bank.id, '2026-11-30').balance, -500);
    assert.equal(editableManual(book, 'editor', first.entry.id), null);
    const simple = recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-11-02',
      kind: 'expense', accountId: bank.id, counterId: expense.id, amountExpression: '100' });
    assert.equal(editableManual(book, 'owner', simple.entry.id), null);
    assert.throws(() => updateSplitManual(book, 'owner', simple.entry.id, 1, input), /cannot be edited/);
  } finally { book.close(); }
});
