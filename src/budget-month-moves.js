import { assertMonth, budgetSummary } from './ledger.js';
import { member } from './members.js';
import { calculateAmount } from './amount-expression.js';
import { entryFingerprint } from './transaction-checks.js';

function payloadFor(book, sub, input) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  const { fromMonth, toMonth, fromCategoryId, toCategoryId } = input;
  assertMonth(fromMonth); assertMonth(toMonth);
  if (fromMonth === toMonth) throw new Error('Select two different budget months');
  const categories = book.budgetCategories();
  if (!categories.has(fromCategoryId) || !categories.has(toCategoryId)) throw new Error('Budget category required');
  const amount = calculateAmount(input.amountExpression);
  if (amount <= 0) throw new Error('Budget move amount must be positive');
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200) throw new Error('Budget month move reason required (up to 200 characters)');
  return { fromMonth, toMonth, fromCategoryId, toCategoryId, amount, reason: input.reason.trim(), actor: sub };
}

function previewFor(book, payload) {
  const { fromMonth, toMonth, fromCategoryId, toCategoryId, amount } = payload;
  const assignments = book.db.prepare('SELECT month, category_id, amount FROM budget_assignments').all()
    .map(row => ({ month: row.month, categoryId: row.category_id, amount: row.amount }));
  const assignment = (month, id) => assignments.find(row => row.month === month && row.categoryId === id)?.amount ?? 0;
  const fromBefore = assignment(fromMonth, fromCategoryId); const toBefore = assignment(toMonth, toCategoryId);
  if (amount > fromBefore) throw new Error('Amount exceeds source monthly assignment');
  if (!Number.isSafeInteger(toBefore + amount)) throw new Error('Budget amount exceeds supported range');
  const after = assignments.filter(row => !(row.month === fromMonth && row.categoryId === fromCategoryId) && !(row.month === toMonth && row.categoryId === toCategoryId));
  after.push({ month: fromMonth, categoryId: fromCategoryId, amount: fromBefore - amount },
    { month: toMonth, categoryId: toCategoryId, amount: toBefore + amount });
  const accounts = book.accounts(); const entries = book.entries(); const categories = book.budgetCategories();
  const ids = [...new Set([fromCategoryId, toCategoryId])];
  const summarize = (values, month) => {
    const summary = budgetSummary(accounts, entries, categories, values, month);
    const result = { readyToAssign: summary.readyToAssign, categories: ids.map(id => summary.categories[id]) };
    if (![result.readyToAssign, ...result.categories.flatMap(row => [row.budgeted, row.spent, row.balance])].every(Number.isSafeInteger)) throw new Error('Budget summary exceeds supported range');
    return result;
  };
  const impacts = [fromMonth, toMonth].sort().map(month => ({ month, before: summarize(assignments, month), after: summarize(after, month) }));
  const result = { payload, fromBefore, fromAfter: fromBefore - amount, toBefore, toAfter: toBefore + amount, impacts };
  return { ...result, expectedHash: entryFingerprint(result) };
}

export function budgetMonthMovePreview(book, sub, input) {
  return previewFor(book, payloadFor(book, sub, input));
}

export function moveBudgetMonth(book, sub, input) {
  const payload = payloadFor(book, sub, input);
  if (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error('Valid budget month move request ID required');
  return book.atomic(() => {
    const old = book.db.prepare('SELECT data FROM budget_month_moves WHERE id = ?').get(input.requestId);
    if (old) {
      const saved = JSON.parse(old.data);
      if (JSON.stringify(saved.payload) !== JSON.stringify(payload) || saved.expectedHash !== input.expectedHash) throw new Error('Request ID reused with different budget month move');
      return { ...saved, duplicate: true };
    }
    const preview = previewFor(book, payload);
    if (preview.expectedHash !== input.expectedHash) throw new Error('Budget changed; preview the month move again');
    book.assignBudget(payload.fromMonth, payload.fromCategoryId, preview.fromAfter);
    book.assignBudget(payload.toMonth, payload.toCategoryId, preview.toAfter);
    const saved = { ...preview, id: input.requestId, createdAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO budget_month_moves (id, from_month, to_month, data) VALUES (?, ?, ?, ?)')
      .run(saved.id, payload.fromMonth, payload.toMonth, JSON.stringify(saved));
    return { ...saved, duplicate: false };
  });
}

export function budgetMonthMoves(book, sub, month) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  assertMonth(month);
  return book.db.prepare('SELECT data FROM budget_month_moves WHERE from_month = ? OR to_month = ? ORDER BY rowid DESC LIMIT 20')
    .all(month, month).map(row => JSON.parse(row.data));
}
