import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountBudgetModePreview, changeAccountBudgetMode, accountBudgetModeHistory } from '../src/account-budget-mode.js';
import { createImportApi } from '../src/import-api.js';

function setup(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const account of [{ id: 'bank', name: '생활비', type: 'asset', onBudget: true }, { id: 'reserve', name: '<저축 & 계좌>', type: 'asset', cash: true },
    { id: 'card', name: '카드', type: 'liability', card: true }, { id: 'equity', name: '기초', type: 'equity' }, { id: 'expense', name: '비용', type: 'expense' }]) book.createAccount(account);
  setMember(book, 'owner', 'editor', 'editor', ['bank', 'reserve']); setMember(book, 'owner', 'viewer', 'viewer', ['reserve']);
  book.createBudgetCategory({ id: 'food', name: '식비' }); book.assignBudget('2026-10', 'food', 5000);
  for (const [id, amount] of [['bank', 10000], ['reserve', 5000]]) book.record({ id: `opening-${id}`, date: '2026-09-01', postings: [{ accountId: id, side: 'debit', amount }, { accountId: 'equity', side: 'credit', amount }] });
  book.record({ id: 'purchase', date: '2026-10-01', postings: [{ accountId: 'expense', side: 'debit', amount: 3000 }, { accountId: 'card', side: 'credit', amount: 3000 }] });
  return book;
}
const inputFor = (patch = {}) => ({ accountId: 'reserve', month: '2026-10', onBudget: true, reason: '가족 예산에 포함', requestId: randomUUID(), ...patch });
const preview = (book, input) => accountBudgetModePreview(book, 'owner', input);
const save = (book, input) => changeAccountBudgetMode(book, 'owner', { ...input, expectedHash: preview(book, input).expectedHash });
function expense(book, accountId, allocated = false, date = '2026-10-15') {
  book.record({ id: randomUUID(), date, postings: [{ accountId: 'expense', side: 'debit', amount: 100 }, { accountId, side: 'credit', amount: 100 }],
    ...(allocated ? { budgetAllocations: [{ categoryId: 'food', amount: 100 }] } : {}) });
}

test('budget mode previews asset and liability effects without writes and preserves allocations, balances and financial reports', () => {
  const book = setup();
  try {
    const input = inputFor(); const entries = book.entries(); const reports = book.reports('2026-09-01', '2026-12-31');
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const plan = preview(book, input);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    assert.equal(plan.canApply, true); assert.equal(plan.before.availableFunds, 10000); assert.equal(plan.after.availableFunds, 15000);
    assert.equal(plan.before.readyToAssign, 5000); assert.equal(plan.after.readyToAssign, 10000);
    assert.equal(plan.before.categoryBalance, plan.after.categoryBalance); assert.equal(plan.before.spent, plan.after.spent);
    save(book, input); assert.equal(book.accounts().get('reserve').onBudget, true); assert.equal(book.accounts().get('reserve').cash, true);
    assert.equal(book.budget('2026-09').availableFunds, 15000); // Setting applies to prior months too.
    const card = preview(book, inputFor({ accountId: 'card' })); assert.equal(card.after.availableFunds, 12000); assert.equal(card.unallocatedExpenseCount, 1);
    save(book, inputFor({ accountId: 'card' })); assert.equal(book.budget('2026-10').availableFunds, 12000); assert.equal(book.budget('2026-10').categories.food.spent, 0);
    assert.deepEqual(book.entries(), entries); assert.deepEqual(book.reports('2026-09-01', '2026-12-31'), reports);
    assert.equal(accountBudgetModeHistory(book, 'owner', 'reserve').length, 1);
  } finally { book.close(); }
});

test('off-budget conversion preserves existing allocations by blocking categorized histories and locked accounts', () => {
  const book = setup();
  try {
    expense(book, 'bank', true, '2027-01-01'); // Entire history matters, including beyond preview month.
    const input = inputFor({ accountId: 'bank', onBudget: false }); const plan = preview(book, input);
    assert.equal(plan.canApply, false); assert.equal(plan.allocatedCount, 1); assert.match(plan.blockers.join(' '), /예산 배분/);
    assert.throws(() => changeAccountBudgetMode(book, 'owner', { ...input, expectedHash: plan.expectedHash }), /blocked/);
    assert.equal(book.accounts().get('bank').onBudget, true); assert.equal(accountBudgetModeHistory(book, 'owner', 'bank').length, 0);
    const lock = { id: randomUUID(), accountId: 'reserve', throughDate: '2026-09-30' };
    book.db.prepare('INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)').run('reserve', lock.throughDate, JSON.stringify(lock));
    const locked = preview(book, inputFor()); assert.equal(locked.canApply, false); assert.match(locked.blockers.join(' '), /기간 잠금/);
    assert.throws(() => save(book, inputFor()), /blocked/);
    assert.equal(book.accounts().get('reserve').onBudget, undefined);
  } finally { book.close(); }
});

test('budget mode rejects stale ledger, assignment and account changes and retains exact retry outcomes after later changes', () => {
  const book = setup();
  try {
    const input = inputFor(); let plan = preview(book, input);
    expense(book, 'reserve'); assert.throws(() => changeAccountBudgetMode(book, 'owner', { ...input, expectedHash: plan.expectedHash }), /changed/);
    plan = preview(book, input); book.assignBudget('2026-10', 'food', 5500);
    assert.throws(() => changeAccountBudgetMode(book, 'owner', { ...input, expectedHash: plan.expectedHash }), /changed/);
    plan = preview(book, input); const renamed = { ...book.accounts().get('reserve'), name: '새 이름' };
    book.db.prepare('UPDATE accounts SET data = ? WHERE id = ?').run(JSON.stringify(renamed), 'reserve');
    assert.throws(() => changeAccountBudgetMode(book, 'owner', { ...input, expectedHash: plan.expectedHash }), /changed/);
    const fresh = { ...input, expectedHash: preview(book, input).expectedHash }; changeAccountBudgetMode(book, 'owner', fresh);
    save(book, inputFor({ onBudget: false, reason: '다시 분리' }));
    assert.equal(changeAccountBudgetMode(book, 'owner', fresh).duplicate, true); assert.equal(book.accounts().get('reserve').onBudget, false);
    for (const patch of [{ reason: '변경' }, { onBudget: false }, { month: '2026-11' }, { expectedHash: 'bad' }]) assert.throws(() => changeAccountBudgetMode(book, 'owner', { ...fresh, ...patch }), /reused/);
    assert.equal(accountBudgetModeHistory(book, 'owner', 'reserve').length, 2);
  } finally { book.close(); }
});

test('budget mode settings require current owner, valid financial account, month, boolean, reason and request ID', () => {
  const book = setup();
  try {
    for (const sub of ['editor', 'viewer', 'unknown']) {
      assert.throws(() => accountBudgetModePreview(book, sub, inputFor()), /Owner/);
      assert.throws(() => changeAccountBudgetMode(book, sub, inputFor()), /Owner/);
      assert.throws(() => accountBudgetModeHistory(book, sub, 'reserve'), /Owner/);
    }
    for (const patch of [{ accountId: 'expense' }, { accountId: 'missing' }, { onBudget: 'true' }, { onBudget: false }, { month: '2026-13' }, { reason: '' }, { reason: 'x'.repeat(201) }]) assert.throws(() => preview(book, inputFor(patch)));
    const input = inputFor(); const plan = preview(book, input);
    assert.throws(() => changeAccountBudgetMode(book, 'owner', { ...input, requestId: 'bad', expectedHash: plan.expectedHash }), /request ID/);
    assert.throws(() => changeAccountBudgetMode(book, 'owner', input), /changed/);
    assert.equal(accountBudgetModeHistory(book, 'owner', 'reserve').length, 0);
  } finally { book.close(); }
});

test('budget mode audit failure rolls back account settings and history and receipts persist after reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'account-budget-mode-')); let book;
  try {
    const file = join(dir, 'book.sqlite'); book = setup(file);
    const input = inputFor(); input.expectedHash = preview(book, input).expectedHash;
    book.db.exec("CREATE TRIGGER fail_budget_mode BEFORE INSERT ON account_budget_changes BEGIN SELECT RAISE(ABORT, 'mode failure'); END");
    assert.throws(() => changeAccountBudgetMode(book, 'owner', input), /mode failure/);
    assert.equal(book.accounts().get('reserve').onBudget, undefined); assert.equal(accountBudgetModeHistory(book, 'owner', 'reserve').length, 0);
    book.db.exec('DROP TRIGGER fail_budget_mode'); const saved = changeAccountBudgetMode(book, 'owner', input);
    book.close(); book = new Book(file); assert.equal(changeAccountBudgetMode(book, 'owner', input).duplicate, true);
    assert.deepEqual(accountBudgetModeHistory(book, 'owner', 'reserve')[0].after, saved.after);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP budget mode shows escaped global-impact previews, hides blocked save and enforces CSRF and owner', async () => {
  const book = setup(); let sub = 'owner';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/accounts`;
  const input = { ...inputFor({ reason: '<포함 & 확인>' }), onBudget: 'true', csrf: 'token' };
  const post = (path, body) => fetch(base + path, { method: 'POST', body: new URLSearchParams(body) });
  try {
    const accounts = await (await fetch(base)).text(); assert.match(accounts, /예산 포함 설정/);
    const settings = await (await fetch(`${base}/budget-mode?accountId=reserve&month=2026-10`)).text(); assert.match(settings, /적용 시작일 없이 전체 기간/);
    for (const path of ['/budget-mode/preview', '/budget-mode']) assert.equal((await post(path, { ...input, csrf: 'bad' })).status, 403);
    sub = 'editor'; assert.equal((await fetch(`${base}/budget-mode?accountId=reserve`)).status, 400);
    for (const path of ['/budget-mode/preview', '/budget-mode']) assert.equal((await post(path, input)).status, 400); sub = 'owner';
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n;
    const response = await post('/budget-mode/preview', input); assert.equal(response.status, 200); const html = await response.text();
    assert.match(html, /&lt;저축 &amp; 계좌&gt;/); assert.match(html, /&lt;포함 &amp; 확인&gt;/); assert.match(html, /15,000원/);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes);
    const final = { ...input, expectedHash: html.match(/name="expectedHash" value="([^\"]+)"/)[1] };
    assert.equal((await post('/budget-mode', final)).status, 200); const retry = await post('/budget-mode', final); assert.equal(retry.status, 200); assert.match(await retry.text(), /이미 처리한/);
    expense(book, 'bank', true);
    const blocked = await (await post('/budget-mode/preview', { ...input, accountId: 'bank', onBudget: 'false' })).text();
    assert.match(blocked, /기존 예산 배분/); assert.doesNotMatch(blocked, /action="\/admin\/accounts\/budget-mode"/);
    assert.equal((await post('/budget-mode', { ...final, onBudget: 'yes' })).status, 400);
    assert.equal(accountBudgetModeHistory(book, 'owner', 'reserve').length, 1);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
