import { assertMonth, incomeStatement } from './ledger.js';
import { member } from './members.js';
import { serializeCsv } from './csv.js';

export const monthlyComparisonOptions = [['previous', '전월'], ['year', '전년 같은 달'], ['custom', '직접 지정한 월']];

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

export function monthlyComparison(book, sub, month, { comparison = 'previous', referenceMonth } = {}) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  validateMonth(month);
  if (!monthlyComparisonOptions.some(([value]) => value === comparison)) throw new Error('Invalid monthly comparison mode');
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
  const rows = [...accounts.values()].filter(account => ['income', 'expense'].includes(account.type))
    .map(account => ({ id: account.id, name: account.name, type: account.type,
      ...change(previous.accounts[account.id], current.accounts[account.id]) }));
  return { comparison, previousPeriod, currentPeriod, totals, rows };
}

export function monthlyComparisonCsv(book, sub, month, options) {
  const report = monthlyComparison(book, sub, month, options);
  const labels = { income: '수입', expenses: '지출', result: '순손익', expense: '지출' };
  const row = (section, type, name, item) => [section, type, name, report.previousPeriod.month,
    report.currentPeriod.month, item.previous, item.current, item.delta,
    item.percent === null ? '' : Number(item.percent.toFixed(2))];
  return serializeCsv([['구분', '유형', '계정', '비교 월', '조회 월', '비교 월 금액(원)', '조회 월 금액(원)', '증감(원)', '증감률(%)'],
    ...report.totals.map(item => row('합계', labels[item.key], '', item)),
    ...report.rows.map(item => row('계정', labels[item.type], item.name, item))]);
}
