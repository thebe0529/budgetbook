import { assertMonth } from './ledger.js';
import { member } from './members.js';
import { serializeCsv } from './csv.js';

export function budgetOverspending(book, sub, month) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  assertMonth(month);
  const budget = book.budget(month);
  const categories = Object.values(budget.categories).filter(category => category.balance < 0)
    .map(category => ({ ...category, deficit: -category.balance,
      opening: category.balance - category.budgeted + category.spent }))
    .sort((a, b) => b.deficit - a.deficit);
  return { budget, categories, deficit: categories.reduce((sum, category) => sum + category.deficit, 0),
    overAssigned: Math.max(0, -budget.readyToAssign) };
}

export function budgetCategoryActivity(book, sub, month, categoryId) {
  const { budget } = budgetOverspending(book, sub, month);
  if (typeof categoryId !== 'string' || !Object.hasOwn(budget.categories, categoryId)) throw new Error('Unknown budget category');
  const category = budget.categories[categoryId];
  const accounts = book.accounts();
  const rows = book.entries().filter(entry => entry.date.startsWith(`${month}-`))
    .filter(entry => entry.budgetAllocations?.some(item => item.categoryId === categoryId))
    .map(entry => ({ id: entry.id, date: entry.date, memo: entry.memo ?? '', kind: entry.kind,
      amount: entry.budgetAllocations.filter(item => item.categoryId === categoryId).reduce((sum, item) => sum + item.amount, 0),
      accounts: [...new Set(entry.postings.map(posting => posting.accountId))]
        .filter(id => ['asset', 'liability'].includes(accounts.get(id)?.type)).map(id => ({ id, name: accounts.get(id).name })) }))
    .sort((a, b) => a.date === b.date ? 0 : a.date > b.date ? -1 : 1);
  const total = rows.reduce((sum, row) => sum + row.amount, 0);
  if (total !== category.spent) throw new Error('Budget category activity reconciliation failed');
  return { month, category, opening: category.balance - category.budgeted + category.spent,
    deficit: Math.max(0, -category.balance), rows, total };
}

export function budgetCategoryActivityCsv(book, sub, month, categoryId) {
  const report = budgetCategoryActivity(book, sub, month, categoryId);
  return serializeCsv([['월', '카테고리', '일자', '메모', '관련 계좌', '예산 지출(원)', '분개 ID'],
    ...report.rows.map(row => [month, report.category.name, row.date, row.memo, row.accounts.map(account => account.name).join(' · '), row.amount, row.id])]);
}
