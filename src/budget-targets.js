import { member } from './members.js';
import { assertMonth } from './ledger.js';
import { calculateAmount } from './amount-expression.js';

function owner(book, sub) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
}

export function setBudgetTarget(book, sub, categoryId, amountExpression) {
  owner(book, sub);
  if (!book.budgetCategories().has(categoryId)) throw new Error('Unknown budget category');
  const amount = calculateAmount(amountExpression);
  if (amount < 0) throw new Error('Budget target cannot be negative');
  if (amount === 0) book.db.prepare('DELETE FROM budget_targets WHERE category_id = ?').run(categoryId);
  else book.db.prepare(`INSERT INTO budget_targets (category_id, amount) VALUES (?, ?)
    ON CONFLICT(category_id) DO UPDATE SET amount=excluded.amount`).run(categoryId, amount);
}

export function budgetTargetPreview(book, sub, month) {
  owner(book, sub);
  assertMonth(month);
  const categories = book.budgetCategories();
  const assignment = book.db.prepare('SELECT amount FROM budget_assignments WHERE month = ? AND category_id = ?');
  const rows = book.db.prepare('SELECT category_id, amount FROM budget_targets ORDER BY category_id').all()
    .filter(row => categories.has(row.category_id)).map(row => {
      const budgeted = assignment.get(month, row.category_id)?.amount ?? 0;
      return { categoryId: row.category_id, target: row.amount, budgeted,
        needed: Math.max(0, row.amount - budgeted) };
    });
  const total = rows.reduce((sum, row) => sum + row.needed, 0);
  if (!Number.isSafeInteger(total)) throw new Error('Budget target total exceeds supported range');
  return { rows, total };
}

export function fillBudgetTargets(book, sub, month, requestId) {
  owner(book, sub);
  assertMonth(month);
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('Valid target fill request ID required');
  }
  return book.atomic(() => {
    const old = book.db.prepare('SELECT data FROM budget_goal_fills WHERE id = ?').get(requestId);
    if (old) {
      const result = JSON.parse(old.data);
      if (result.month !== month || result.actor !== sub) throw new Error('Request ID reused with different target fill');
      return { ...result, duplicate: true };
    }
    const preview = budgetTargetPreview(book, sub, month);
    const changes = preview.rows.filter(row => row.needed > 0);
    for (const row of changes) book.assignBudget(month, row.categoryId, row.target);
    const result = { month, actor: sub, count: changes.length, total: preview.total };
    book.db.prepare('INSERT INTO budget_goal_fills (id, data) VALUES (?, ?)').run(requestId, JSON.stringify(result));
    return { ...result, duplicate: false };
  });
}
