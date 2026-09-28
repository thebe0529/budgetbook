import { detailedReports } from './report-details.js';

const activityNames = { operating: '영업활동', investing: '투자활동', financing: '재무활동' };

function cell(value) {
  if (typeof value === 'number') return String(value);
  let text = String(value ?? '');
  // Spreadsheet programs can interpret imported text as formulas, including after leading whitespace.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function cashMovementsCsv(book, sub, fromDate, throughDate) {
  const report = detailedReports(book, sub, fromDate, throughDate);
  const names = book.accounts();
  const rows = [['일자', '활동', '계좌', '메모', '증감(원)', '분개 ID'],
    ...report.cashMovements.map(m => [m.date, activityNames[m.activity],
      names.get(m.accountId)?.name ?? '', m.memo, m.amount, m.id])];
  return `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
