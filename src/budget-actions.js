import { assertMonth } from './ledger.js';
import { member } from './members.js';
import { calculateAmount } from './amount-expression.js';

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

export function moveBudget(book, sub, input) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  const { month, fromCategoryId, toCategoryId, requestId } = input;
  assertMonth(month);
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('Valid budget move request ID required');
  }
  const categories = book.budgetCategories();
  if (!categories.has(fromCategoryId) || !categories.has(toCategoryId) || fromCategoryId === toCategoryId) {
    throw new Error('Select two different budget categories');
  }
  const amount = calculateAmount(input.amountExpression);
  if (amount <= 0) throw new Error('Budget move amount must be positive');
  const payload = { month, fromCategoryId, toCategoryId, amount, actor: sub };
  return book.atomic(() => {
    const old = book.db.prepare('SELECT data FROM budget_moves WHERE id = ?').get(requestId);
    if (old) {
      const previous = JSON.parse(old.data);
      if (JSON.stringify(previous.payload) !== JSON.stringify(payload)) throw new Error('Request ID reused with different budget move');
      return { ...previous, duplicate: true };
    }
    const assignment = id => book.db.prepare('SELECT amount FROM budget_assignments WHERE month = ? AND category_id = ?')
      .get(month, id)?.amount ?? 0;
    const fromAmount = assignment(fromCategoryId);
    const toAmount = assignment(toCategoryId);
    if (amount > fromAmount) throw new Error('Amount exceeds source monthly assignment');
    if (!Number.isSafeInteger(toAmount + amount)) throw new Error('Budget amount exceeds supported range');
    book.assignBudget(month, fromCategoryId, fromAmount - amount);
    book.assignBudget(month, toCategoryId, toAmount + amount);
    const result = { id: requestId, payload, createdAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO budget_moves (id, month, data) VALUES (?, ?, ?)')
      .run(requestId, month, JSON.stringify(result));
    return { ...result, duplicate: false };
  });
}

export function budgetMoves(book, sub, month) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  assertMonth(month);
  return book.db.prepare('SELECT data FROM budget_moves WHERE month = ? ORDER BY rowid DESC LIMIT 20')
    .all(month).map(row => JSON.parse(row.data));
}
