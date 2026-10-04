import { assertMonth, incomeStatement } from './ledger.js';
import { member } from './members.js';
import { serializeCsv } from './csv.js';

function period(month) {
  const last = new Date(`${month}-01T00:00:00Z`);
  last.setUTCMonth(last.getUTCMonth() + 1, 0);
  return { month, fromDate: `${month}-01`, throughDate: `${month}-${String(last.getUTCDate()).padStart(2, '0')}` };
}
function change(previous, current) {
  const delta = current - previous;
  return { previous, current, delta, percent: previous === 0 ? (current === 0 ? 0 : null) : delta / Math.abs(previous) * 100 };
}

export function monthlyComparison(book, sub, month) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  assertMonth(month);
  const year = Number(month.slice(0, 4)); const number = Number(month.slice(5));
  if (year < 1 || month === '0001-01') throw new Error('Comparison month must be between 0001-02 and 9999-12');
  const previousMonth = `${String(number === 1 ? year - 1 : year).padStart(4, '0')}-${String(number === 1 ? 12 : number - 1).padStart(2, '0')}`;
  const previousPeriod = period(previousMonth); const currentPeriod = period(month);
  const accounts = book.accounts(); const entries = book.entries();
  const previous = incomeStatement(accounts, entries, previousPeriod.fromDate, previousPeriod.throughDate);
  const current = incomeStatement(accounts, entries, currentPeriod.fromDate, currentPeriod.throughDate);
  const totals = ['income', 'expenses', 'result'].map(key => ({ key, ...change(previous[key], current[key]) }));
  const rows = [...accounts.values()].filter(account => ['income', 'expense'].includes(account.type))
    .map(account => ({ id: account.id, name: account.name, type: account.type,
      ...change(previous.accounts[account.id], current.accounts[account.id]) }));
  return { previousPeriod, currentPeriod, totals, rows };
}

export function monthlyComparisonCsv(book, sub, month) {
  const report = monthlyComparison(book, sub, month);
  const labels = { income: '수입', expenses: '지출', result: '순손익', expense: '지출' };
  const row = (section, type, name, item) => [section, type, name, report.previousPeriod.month,
    report.currentPeriod.month, item.previous, item.current, item.delta,
    item.percent === null ? '' : Number(item.percent.toFixed(2))];
  return serializeCsv([['구분', '유형', '계정', '전월', '조회 월', '전월 금액(원)', '조회 월 금액(원)', '증감(원)', '증감률(%)'],
    ...report.totals.map(item => row('합계', labels[item.key], '', item)),
    ...report.rows.map(item => row('계정', labels[item.type], item.name, item))]);
}
