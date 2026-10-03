import { assertDate } from './ledger.js';

export function registerFilters(params) {
  const status = params.get('status') || 'all';
  const fromDate = params.get('fromDate') || '';
  const throughDate = params.get('throughDate') || '';
  const memo = (params.get('memo') || '').trim();
  const rawPage = params.get('page') || '1';
  if (!['all', 'unchecked', 'checked'].includes(status)) throw new Error('Invalid transaction filter');
  if (fromDate) assertDate(fromDate);
  if (throughDate) assertDate(throughDate);
  if (fromDate && throughDate && fromDate > throughDate) throw new Error('Invalid date range');
  if (memo.length > 200) throw new Error('Memo search is too long');
  if (!/^[1-9]\d*$/.test(rawPage) || !Number.isSafeInteger(Number(rawPage))) throw new Error('Invalid page');
  return { status, fromDate, throughDate, memo, page: Number(rawPage) };
}

export function registerPage(register, filters) {
  const rows = register.rows.filter(row =>
    (filters.status === 'all' || row.checked === (filters.status === 'checked')) &&
    (!filters.fromDate || row.date >= filters.fromDate) &&
    (!filters.throughDate || row.date <= filters.throughDate) &&
    row.memo.toLocaleLowerCase('ko-KR').includes(filters.memo.toLocaleLowerCase('ko-KR')));
  const pages = Math.max(1, Math.ceil(rows.length / 200));
  const page = Math.min(filters.page, pages);
  return { rows: rows.slice((page - 1) * 200, page * 200), total: rows.length, pages, page,
    movement: rows.reduce((sum, row) => sum + row.movement, 0) };
}
