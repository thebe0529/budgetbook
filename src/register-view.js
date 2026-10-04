import { assertDate } from './ledger.js';

export const registerSortOptions = [['date-desc', '일자 최신순'], ['date-asc', '일자 오래된순'],
  ['movement-desc', '증감 큰순'], ['movement-asc', '증감 작은순'], ['memo-asc', '메모 오름차순'], ['memo-desc', '메모 내림차순']];
const memoOrder = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });

export function registerFilters(params) {
  const status = params.get('status') || 'all';
  const fromDate = params.get('fromDate') || '';
  const throughDate = params.get('throughDate') || '';
  const memo = (params.get('memo') || '').trim();
  const tag = (params.get('tag') || '').trim().normalize('NFC');
  const rawPage = params.get('page') || '1';
  const sort = params.get('sort') || 'date-desc';
  if (!['all', 'unchecked', 'checked'].includes(status)) throw new Error('Invalid transaction filter');
  if (fromDate) assertDate(fromDate);
  if (throughDate) assertDate(throughDate);
  if (fromDate && throughDate && fromDate > throughDate) throw new Error('Invalid date range');
  if (memo.length > 200) throw new Error('Memo search is too long');
  if (tag.length > 30 || /[,\p{Cc}\p{Cf}]/u.test(tag)) throw new Error('Invalid tag search');
  if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) throw new Error('Invalid page');
  if (!registerSortOptions.some(([value]) => value === sort)) throw new Error('Invalid transaction sort');
  return { status, fromDate, throughDate, memo, tag, sort, page: Number(rawPage) };
}

export function filteredRegisterRows(register, filters) {
  const rows = register.rows.filter(row =>
    (filters.status === 'all' || row.checked === (filters.status === 'checked')) &&
    (!filters.fromDate || row.date >= filters.fromDate) &&
    (!filters.throughDate || row.date <= filters.throughDate) &&
    row.memo.toLocaleLowerCase('ko-KR').includes(filters.memo.toLocaleLowerCase('ko-KR')) &&
    (!filters.tag || (row.tags ?? []).includes(filters.tag)));
  const sort = filters.sort ?? 'date-desc';
  if (!registerSortOptions.some(([value]) => value === sort)) throw new Error('Invalid transaction sort');
  const field = sort.startsWith('date-') ? 'date' : sort.startsWith('movement-') ? 'movement' : 'memo';
  const direction = sort.endsWith('-asc') ? 1 : -1;
  // Equal values retain the full register's order; balances belong to the ledger,
  // not to the display order. Filtering above also keeps the original array intact.
  return rows.sort((a, b) => direction * (field === 'memo' ? memoOrder.compare(a.memo, b.memo) :
    a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1));
}

export function registerPage(register, filters) {
  const rows = filteredRegisterRows(register, filters);
  const pages = Math.max(1, Math.ceil(rows.length / 200));
  const page = Math.min(filters.page, pages);
  return { rows: rows.slice((page - 1) * 200, page * 200), total: rows.length, pages, page,
    movement: rows.reduce((sum, row) => sum + row.movement, 0) };
}
