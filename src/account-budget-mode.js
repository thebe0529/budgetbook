import { member } from './members.js';
import { assertMonth, budgetSummary } from './ledger.js';
import { entryFingerprint } from './transaction-checks.js';

function accountFor(book, sub, accountId) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  const account = book.accounts().get(accountId);
  if (!account || !['asset', 'liability'].includes(account.type)) throw new Error('Asset or liability account required');
  return account;
}

function payloadFor(book, sub, input) {
  accountFor(book, sub, input.accountId); assertMonth(input.month);
  if (typeof input.onBudget !== 'boolean') throw new Error('Boolean budget mode required');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200) throw new Error('Budget mode change reason required (up to 200 characters)');
  return { accountId: input.accountId, onBudget: input.onBudget, month: input.month, reason: input.reason.trim(), actor: sub };
}

function previewFor(book, sub, payload) {
  const account = accountFor(book, sub, payload.accountId);
  if (Boolean(account.onBudget) === payload.onBudget) throw new Error('Select a different budget mode');
  const accounts = book.accounts(); const afterAccounts = new Map(accounts);
  afterAccounts.set(account.id, { ...account, onBudget: payload.onBudget });
  const entries = book.entries(); const categories = book.budgetCategories();
  const assignments = book.db.prepare('SELECT month, category_id, amount FROM budget_assignments').all()
    .map(row => ({ month: row.month, categoryId: row.category_id, amount: row.amount }));
  const summarize = values => {
    const budget = budgetSummary(values, entries, categories, assignments, payload.month);
    const result = { availableFunds: budget.availableFunds, readyToAssign: budget.readyToAssign,
      budgeted: Object.values(budget.categories).reduce((sum, row) => sum + row.budgeted, 0),
      spent: Object.values(budget.categories).reduce((sum, row) => sum + row.spent, 0),
      categoryBalance: Object.values(budget.categories).reduce((sum, row) => sum + row.balance, 0) };
    if (!Object.values(result).every(Number.isSafeInteger)) throw new Error('Budget mode preview exceeds supported range');
    return result;
  };
  const related = entries.filter(entry => entry.postings.some(posting => posting.accountId === account.id));
  const allocated = related.filter(entry => entry.budgetAllocations?.length);
  const unallocatedExpenses = related.filter(entry => !entry.budgetAllocations?.length && entry.postings.some(posting => accounts.get(posting.accountId)?.type === 'expense'));
  const lockRecord = book.db.prepare('SELECT data FROM account_period_locks WHERE account_id = ?').get(account.id);
  const lock = lockRecord ? JSON.parse(lockRecord.data) : null;
  const blockers = [];
  if (lock) blockers.push('기간 잠금 중인 계좌는 예산 포함 상태를 변경할 수 없습니다.');
  if (!payload.onBudget && allocated.length) blockers.push('기존 예산 배분이 연결된 계좌는 오프버짓으로 전환할 수 없습니다. 자동 이관은 아직 지원하지 않습니다.');
  const result = { payload, account, before: summarize(accounts), after: summarize(afterAccounts), relatedCount: related.length,
    allocatedCount: allocated.length, unallocatedExpenseCount: unallocatedExpenses.length, blockers, canApply: blockers.length === 0 };
  return { ...result, expectedHash: entryFingerprint({ ...result, relatedHashes: related.map(entryFingerprint), lock }) };
}

export function accountBudgetModePreview(book, sub, input) {
  return previewFor(book, sub, payloadFor(book, sub, input));
}

export function changeAccountBudgetMode(book, sub, input) {
  const payload = payloadFor(book, sub, input);
  if (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error('Valid budget mode change request ID required');
  return book.atomic(() => {
    const old = book.db.prepare('SELECT data FROM account_budget_changes WHERE id = ?').get(input.requestId);
    if (old) {
      const saved = JSON.parse(old.data);
      if (JSON.stringify(saved.payload) !== JSON.stringify(payload) || saved.expectedHash !== input.expectedHash) throw new Error('Budget mode request ID reused');
      return { ...saved, duplicate: true };
    }
    const preview = previewFor(book, sub, payload);
    if (preview.expectedHash !== input.expectedHash) throw new Error('Account or budget changed; preview again');
    if (!preview.canApply) throw new Error('Budget mode change blocked');
    book.db.prepare('UPDATE accounts SET data = ? WHERE id = ?').run(JSON.stringify({ ...preview.account, onBudget: payload.onBudget }), payload.accountId);
    const saved = { ...preview, id: input.requestId, createdAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO account_budget_changes (id, account_id, data) VALUES (?, ?, ?)').run(input.requestId, payload.accountId, JSON.stringify(saved));
    return { ...saved, duplicate: false };
  });
}

export function accountBudgetModeHistory(book, sub, accountId) {
  accountFor(book, sub, accountId);
  return book.db.prepare('SELECT data FROM account_budget_changes WHERE account_id = ? ORDER BY rowid DESC LIMIT 20')
    .all(accountId).map(row => JSON.parse(row.data));
}
