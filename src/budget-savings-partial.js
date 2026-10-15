import { member } from './members.js';
import { calculateAmount } from './amount-expression.js';
import { assertMonth } from './ledger.js';
import { entryFingerprint } from './transaction-checks.js';
import { budgetSavingsPreview } from './budget-savings.js';

export function budgetSavingsPriorities(book, sub) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  return new Map(book.db.prepare('SELECT category_id, priority FROM budget_savings_priorities').all().map(row => [row.category_id, row.priority]));
}

export function setBudgetSavingsPriority(book, sub, categoryId, value) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  if (!book.budgetCategories().has(categoryId) || !book.db.prepare('SELECT 1 FROM budget_savings_targets WHERE category_id = ?').get(categoryId)) throw new Error('Active savings target required');
  if (!/^(?:[1-9][0-9]?|100)$/.test(String(value))) throw new Error('Savings priority must be 1 to 100');
  book.db.prepare(`INSERT INTO budget_savings_priorities (category_id, priority) VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE SET priority=excluded.priority`).run(categoryId, Number(value));
}

export function budgetSavingsPartialPreview(book, sub, month, amountExpression) {
  const base = budgetSavingsPreview(book, sub, month);
  const limit = calculateAmount(amountExpression);
  if (limit < 0 || limit > Math.max(0, base.readyToAssign)) throw new Error('Savings allocation limit must be within unassigned funds');
  const priorities = budgetSavingsPriorities(book, sub);
  let remaining = limit;
  const rows = base.rows.map(row => ({ ...row, priority: priorities.get(row.categoryId) ?? 50 }))
    .sort((a, b) => a.priority - b.priority || a.categoryId.localeCompare(b.categoryId)).map(row => {
      const assigned = Math.min(row.needed, remaining); remaining -= assigned;
      return { ...row, assigned, afterBudgeted: row.budgeted + assigned, afterBalance: row.balance + assigned, remainingNeeded: row.needed - assigned };
    });
  const total = limit - remaining;
  const result = { month, limit, rows, total, totalNeeded: base.total, remainingNeeded: base.total - total,
    unusedLimit: remaining, readyToAssign: base.readyToAssign, afterReadyToAssign: base.readyToAssign - total };
  return { ...result, expectedHash: entryFingerprint({ ...result, sourceHash: base.expectedHash }) };
}

export function fillBudgetSavingsPartial(book, sub, month, amountExpression, requestId, expectedHash) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  assertMonth(month);
  const limit = calculateAmount(amountExpression);
  if (limit < 0) throw new Error('Savings allocation limit cannot be negative');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Valid savings fill request ID required');
  return book.atomic(() => {
    const old = book.db.prepare('SELECT data FROM budget_savings_fills WHERE id = ?').get(requestId);
    if (old) {
      const saved = JSON.parse(old.data);
      if (saved.mode !== 'limited' || saved.month !== month || saved.actor !== sub || saved.limit !== limit || saved.expectedHash !== expectedHash) throw new Error('Request ID reused with different savings fill');
      return { ...saved, duplicate: true };
    }
    const preview = budgetSavingsPartialPreview(book, sub, month, String(limit));
    if (preview.expectedHash !== expectedHash) throw new Error('Budget, savings target or priority changed; preview again');
    if (preview.total === 0) throw new Error('No savings allocation to save');
    const changes = preview.rows.filter(row => row.assigned > 0);
    for (const row of changes) book.assignBudget(month, row.categoryId, row.afterBudgeted);
    const saved = { ...preview, mode: 'limited', id: requestId, actor: sub, count: changes.length, createdAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO budget_savings_fills (id, month, data) VALUES (?, ?, ?)').run(requestId, month, JSON.stringify(saved));
    return { ...saved, duplicate: false };
  });
}
