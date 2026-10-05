import { assertMonth } from './ledger.js';
import { member } from './members.js';
import { serializeCsv } from './csv.js';

export const budgetActivitySortOptions = [['date-desc', '일자 최신순'], ['date-asc', '일자 오래된순'],
  ['amount-desc', '예산 지출 큰순'], ['amount-asc', '예산 지출 작은순']];

export function budgetActivityFilters(params) {
  const rawPage = params.get('page') || '1';
  if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) throw new Error('Invalid activity page');
  return { memo: params.get('memo') || '', sort: params.get('sort') || 'date-desc', page: Number(rawPage) };
}

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

export function budgetCategoryActivity(book, sub, month, categoryId, { memo = '', sort = 'date-desc', page = 1 } = {}) {
  const { budget } = budgetOverspending(book, sub, month);
  if (typeof memo !== 'string' || memo.length > 200) throw new Error('Invalid activity memo search');
  if (!budgetActivitySortOptions.some(([value]) => value === sort)) throw new Error('Invalid activity sort');
  if (!Number.isSafeInteger(page) || page < 1) throw new Error('Invalid activity page');
  memo = memo.trim().normalize('NFC');
  if (typeof categoryId !== 'string' || !Object.hasOwn(budget.categories, categoryId)) throw new Error('Unknown budget category');
  const category = budget.categories[categoryId];
  const accounts = book.accounts();
  const monthlyRows = book.entries().filter(entry => entry.date.startsWith(`${month}-`))
    .filter(entry => entry.budgetAllocations?.some(item => item.categoryId === categoryId))
    .map(entry => ({ id: entry.id, date: entry.date, memo: entry.memo ?? '', kind: entry.kind,
      amount: entry.budgetAllocations.filter(item => item.categoryId === categoryId).reduce((sum, item) => sum + item.amount, 0),
      accounts: [...new Set(entry.postings.map(posting => posting.accountId))]
        .filter(id => ['asset', 'liability'].includes(accounts.get(id)?.type)).map(id => ({ id, name: accounts.get(id).name })) }))
    .sort((a, b) => a.date === b.date ? 0 : a.date > b.date ? -1 : 1);
  const total = monthlyRows.reduce((sum, row) => sum + row.amount, 0);
  if (total !== category.spent) throw new Error('Budget category activity reconciliation failed');
  const search = memo.toLocaleLowerCase('ko-KR');
  const matchedRows = monthlyRows.filter(row => row.memo.normalize('NFC').toLocaleLowerCase('ko-KR').includes(search));
  const [field, direction] = sort.split('-');
  matchedRows.sort((a, b) => (direction === 'asc' ? 1 : -1) * (a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1));
  const pages = Math.max(1, Math.ceil(matchedRows.length / 200));
  page = Math.min(page, pages);
  const rows = matchedRows.slice((page - 1) * 200, page * 200);
  const monthIndex = Number(month.slice(0, 4)) * 12 + Number(month.slice(5)) - 1;
  const monthAt = index => index < 0 || index > 9999 * 12 + 11 ? null :
    `${String(Math.floor(index / 12)).padStart(4, '0')}-${String(index % 12 + 1).padStart(2, '0')}`;
  const monthEnd = new Date(`${month}-01T00:00:00Z`);
  monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0);
  return { month, category, opening: category.balance - category.budgeted + category.spent,
    deficit: Math.max(0, -category.balance), rows, matchedRows, total, monthlyCount: monthlyRows.length,
    matchedTotal: matchedRows.reduce((sum, row) => sum + row.amount, 0), matchedCount: matchedRows.length,
    page, pages, filters: { memo, sort, page }, previousMonth: monthAt(monthIndex - 1), nextMonth: monthAt(monthIndex + 1),
    fromDate: `${month}-01`, throughDate: `${month}-${String(monthEnd.getUTCDate()).padStart(2, '0')}` };
}

export function budgetCategoryActivityCsv(book, sub, month, categoryId, options) {
  const report = budgetCategoryActivity(book, sub, month, categoryId, options);
  const sortLabel = budgetActivitySortOptions.find(([value]) => value === report.filters.sort)[1];
  return serializeCsv([['월', '카테고리', '일자', '메모', '관련 계좌', '예산 지출(원)', '분개 ID', '메모 검색 조건', '정렬 조건'],
    ...report.matchedRows.map(row => [month, report.category.name, row.date, row.memo, row.accounts.map(account => account.name).join(' · '),
      row.amount, row.id, report.filters.memo, sortLabel])]);
}
