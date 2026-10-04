import { assertMonth, incomeStatement } from './ledger.js';
import { member } from './members.js';
import { serializeCsv } from './csv.js';

export const monthlyComparisonOptions = [['previous', '전월'], ['year', '전년 같은 달'], ['custom', '직접 지정한 월']];
export const monthlyAccountTypes = [['all', '전체'], ['income', '수입'], ['expense', '지출']];
export const monthlySortOptions = [['original', '기존 계정순'], ['name-asc', '계정명 오름차순'], ['name-desc', '계정명 내림차순'],
  ['previous-desc', '비교 월 금액 큰순'], ['previous-asc', '비교 월 금액 작은순'],
  ['current-desc', '조회 월 금액 큰순'], ['current-asc', '조회 월 금액 작은순'],
  ['delta-desc', '증감액 큰순'], ['delta-asc', '증감액 작은순'], ['percent-desc', '증감률 큰순'], ['percent-asc', '증감률 작은순']];
const accountNameOrder = new Intl.Collator('ko-KR', { numeric: true, sensitivity: 'base' });

export function monthlyComparisonFilters(params) {
  const hideZero = params.get('hideZero') ?? 'false';
  if (!['true', 'false'].includes(hideZero)) throw new Error('Invalid zero amount filter');
  return { comparison: params.get('comparison') || 'previous', referenceMonth: params.get('referenceMonth'),
    accountType: params.get('accountType') || 'all', accountQuery: params.get('accountQuery') || '', hideZero: hideZero === 'true',
    sort: params.get('sort') || 'original' };
}

function validateMonth(month) {
  assertMonth(month);
  if (Number(month.slice(0, 4)) < 1) throw new Error('Month must be between 0001-01 and 9999-12');
}

function period(month) {
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { month, fromDate: `${month}-01`, throughDate: `${month}-${String(last.getUTCDate()).padStart(2, '0')}` };
}
function change(previous, current) {
  const delta = current - previous;
  return { previous, current, delta, percent: previous === 0 ? (current === 0 ? 0 : null) : delta / Math.abs(previous) * 100 };
}

export function monthlyComparison(book, sub, month, { comparison = 'previous', referenceMonth,
  accountType = 'all', accountQuery = '', hideZero = false, sort = 'original' } = {}) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  validateMonth(month);
  if (!monthlyComparisonOptions.some(([value]) => value === comparison)) throw new Error('Invalid monthly comparison mode');
  if (!monthlyAccountTypes.some(([value]) => value === accountType)) throw new Error('Invalid monthly account type');
  if (!monthlySortOptions.some(([value]) => value === sort)) throw new Error('Invalid monthly account sort');
  if (typeof hideZero !== 'boolean') throw new Error('Invalid zero amount filter');
  if (typeof accountQuery !== 'string' || accountQuery.length > 100 || /[\p{Cc}\p{Cf}]/u.test(accountQuery)) throw new Error('Invalid account search');
  accountQuery = accountQuery.trim().normalize('NFC');
  const year = Number(month.slice(0, 4)); const number = Number(month.slice(5));
  if ((comparison === 'previous' && month === '0001-01') || (comparison === 'year' && year === 1)) {
    throw new Error('Reference month precedes the supported year range');
  }
  const previousMonth = comparison === 'custom' ? referenceMonth : comparison === 'year' ?
    `${String(year - 1).padStart(4, '0')}-${String(number).padStart(2, '0')}` :
    `${String(number === 1 ? year - 1 : year).padStart(4, '0')}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}`;
  validateMonth(previousMonth);
  if (previousMonth === month) throw new Error('Choose a different reference month');
  const previousPeriod = period(previousMonth); const currentPeriod = period(month);
  const accounts = book.accounts(); const entries = book.entries();
  const previous = incomeStatement(accounts, entries, previousPeriod.fromDate, previousPeriod.throughDate);
  const current = incomeStatement(accounts, entries, currentPeriod.fromDate, currentPeriod.throughDate);
  const totals = ['income', 'expenses', 'result'].map(key => ({ key, ...change(previous[key], current[key]) }));
  const allRows = [...accounts.values()].filter(account => ['income', 'expense'].includes(account.type))
    .map(account => ({ id: account.id, name: account.name, type: account.type,
      ...change(previous.accounts[account.id], current.accounts[account.id]) }));
  const search = accountQuery.toLocaleLowerCase('ko-KR');
  const rows = allRows.filter(row => (accountType === 'all' || row.type === accountType) &&
    row.name.normalize('NFC').toLocaleLowerCase('ko-KR').includes(search) &&
    (!hideZero || row.previous !== 0 || row.current !== 0));
  if (sort !== 'original') {
    const [field, order] = sort.split('-'); const direction = order === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      // Undefined percentage changes always follow numeric values, in either direction.
      // Equal values retain account order; use unrounded values for percentage sorting.
      if (a[field] === null || b[field] === null) return a[field] === b[field] ? 0 : a[field] === null ? 1 : -1;
      return direction * (field === 'name' ? accountNameOrder.compare(a.name, b.name) :
        a[field] === b[field] ? 0 : a[field] > b[field] ? 1 : -1);
    });
  }
  return { comparison, previousPeriod, currentPeriod, totals, rows, totalAccounts: allRows.length,
    filters: { accountType, accountQuery, hideZero, sort } };
}

export function monthlyComparisonCsv(book, sub, month, options) {
  const report = monthlyComparison(book, sub, month, options);
  const labels = { income: '수입', expenses: '지출', result: '순손익', expense: '지출' };
  const row = (section, type, name, item) => [section, type, name, report.previousPeriod.month,
    report.currentPeriod.month, item.previous, item.current, item.delta,
    item.percent === null ? '' : Number(item.percent.toFixed(2)),
    monthlyAccountTypes.find(([value]) => value === report.filters.accountType)[1], report.filters.accountQuery,
    report.filters.hideZero ? '예' : '아니오', monthlySortOptions.find(([value]) => value === report.filters.sort)[1]];
  return serializeCsv([['구분', '유형', '계정', '비교 월', '조회 월', '비교 월 금액(원)', '조회 월 금액(원)', '증감(원)', '증감률(%)',
    '계정 유형 조건', '계정명 검색 조건', '양쪽 월 0원 계정 제외', '계정 정렬 조건'],
    ...report.totals.map(item => row('전체 합계 (계정 필터 미적용)', labels[item.key], '', item)),
    ...report.rows.map(item => row('계정', labels[item.type], item.name, item))]);
}
