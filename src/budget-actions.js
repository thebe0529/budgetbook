import { assertMonth } from './ledger.js';
import { member } from './members.js';

export function previousBudgetPreview(book, sub, month) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  assertMonth(month);
  const [year, number] = month.split('-').map(Number);
  const previousYear = number === 1 ? year - 1 : year;
  const fromMonth = previousYear < 0 ? null :
    `${String(previousYear).padStart(4, '0')}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}`;
  const source = fromMonth ? book.db.prepare('SELECT category_id, amount FROM budget_assignments WHERE month = ?')
    .all(fromMonth) : [];
  const existing = new Set(book.db.prepare('SELECT category_id FROM budget_assignments WHERE month = ?')
    .all(month).map(row => row.category_id));
  const categories = book.budgetCategories();
  const rows = source.filter(row => categories.has(row.category_id) && !existing.has(row.category_id));
  return { fromMonth, month, rows, total: rows.reduce((sum, row) => sum + row.amount, 0) };
}

export function copyPreviousBudget(book, sub, month) {
  return book.atomic(() => {
    const preview = previousBudgetPreview(book, sub, month);
    for (const row of preview.rows) book.assignBudget(month, row.category_id, row.amount);
    return { fromMonth: preview.fromMonth, count: preview.rows.length, total: preview.total };
  });
}
