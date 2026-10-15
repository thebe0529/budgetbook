import { member } from './members.js';
import { assertMonth } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { entryFingerprint } from './transaction-checks.js';

function owner(book, sub) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
}

export function setBudgetSavingsTarget(book, sub, categoryId, amountExpression) {
  owner(book, sub);
  if (!book.budgetCategories().has(categoryId)) throw new Error('Unknown budget category');
  const amount = calculateAmount(amountExpression);
  if (amount < 0) throw new Error('Savings target cannot be negative');
  if (amount === 0) book.db.prepare('DELETE FROM budget_savings_targets WHERE category_id = ?').run(categoryId);
  else book.db.prepare(`INSERT INTO budget_savings_targets (category_id, amount) VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE SET amount=excluded.amount`).run(categoryId, amount);
}

export function budgetSavingsPreview(book, sub, month) {
  owner(book, sub); assertMonth(month);
  const budget = book.budget(month);
  const rows = book.db.prepare('SELECT category_id, amount FROM budget_savings_targets ORDER BY category_id').all()
    .filter(row => budget.categories[row.category_id]).map(row => {
      const current = budget.categories[row.category_id];
      const needed = Math.max(0, row.amount - current.balance);
      const result = { categoryId: row.category_id, name: current.name, target: row.amount, budgeted: current.budgeted,
        balance: current.balance, needed, afterBudgeted: current.budgeted + needed, afterBalance: current.balance + needed };
      if (![result.target, result.budgeted, result.balance, result.needed, result.afterBudgeted, result.afterBalance].every(Number.isSafeInteger)) throw new Error('Savings target exceeds supported range');
      return result;
    });
  const total = rows.reduce((sum, row) => sum + row.needed, 0);
  const afterReadyToAssign = budget.readyToAssign - total;
  if (![total, budget.readyToAssign, afterReadyToAssign].every(Number.isSafeInteger)) throw new Error('Savings target total exceeds supported range');
  const result = { month, rows, total, readyToAssign: budget.readyToAssign, afterReadyToAssign };
  return { ...result, expectedHash: entryFingerprint(result) };
}

export function fillBudgetSavings(book, sub, month, requestId, expectedHash) {
  owner(book, sub); assertMonth(month);
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Valid savings fill request ID required');
  return book.atomic(() => {
    const old = book.db.prepare('SELECT data FROM budget_savings_fills WHERE id = ?').get(requestId);
    if (old) {
      const saved = JSON.parse(old.data);
      if (saved.mode === 'limited' || saved.month !== month || saved.actor !== sub || saved.expectedHash !== expectedHash) throw new Error('Request ID reused with different savings fill');
      return { ...saved, duplicate: true };
    }
    const preview = budgetSavingsPreview(book, sub, month);
    if (preview.expectedHash !== expectedHash) throw new Error('Budget or savings target changed; reload before filling');
    const changes = preview.rows.filter(row => row.needed > 0);
    for (const row of changes) book.assignBudget(month, row.categoryId, row.afterBudgeted);
    const saved = { ...preview, id: requestId, actor: sub, count: changes.length, createdAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO budget_savings_fills (id, month, data) VALUES (?, ?, ?)').run(requestId, month, JSON.stringify(saved));
    return { ...saved, duplicate: false };
  });
}

export function budgetSavingsFills(book, sub, month) {
  owner(book, sub); assertMonth(month);
  return book.db.prepare('SELECT data FROM budget_savings_fills WHERE month = ? ORDER BY rowid DESC LIMIT 20')
    .all(month).map(row => JSON.parse(row.data));
}
