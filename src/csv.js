function cell(value) {
  if (typeof value === 'number') return String(value);
  let text = String(value ?? '');
  // Imported text must not be interpreted as a spreadsheet formula.
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function serializeCsv(rows) {
  return `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`;
}
