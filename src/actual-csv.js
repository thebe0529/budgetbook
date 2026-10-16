import { canAccessAccount } from './members.js';
import { assertDate } from './ledger.js';
import { entryFingerprint } from './transaction-checks.js';
import { receiveImport } from './imports.js';

// Strict comma-separated CSV: quoted commas/newlines and doubled quotes, without evaluating cells.
function parseCsv(text) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 100000 || text.includes('\0')) throw new Error('CSV must contain at most 100 KB of UTF-8 text');
  text = text.replace(/^\uFEFF/, '');
  const rows = []; let row = []; let cell = ''; let quoted = false; let closed = false;
  const finishCell = () => { if (row.length >= 40) throw new Error('CSV supports at most 40 columns'); row.push(cell); cell = ''; closed = false; };
  const finishRow = () => { finishCell(); if (row.some(value => value !== '')) rows.push(row); row = []; if (rows.length > 201) throw new Error('CSV supports at most 200 transactions'); };
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') { cell += '"'; index++; } else { quoted = false; closed = true; }
      } else cell += char;
    } else if (char === ',') finishCell();
    else if (char === '\r' || char === '\n') { if (char === '\r' && text[index + 1] === '\n') index++; finishRow(); }
    else if (char === '"' && cell === '' && !closed) quoted = true;
    else {
      if (closed || char === '"') throw new Error('Malformed CSV quoting');
      cell += char;
    }
    if (row.length > 40 || cell.length > 2000) throw new Error('CSV column or field limit exceeded');
  }
  if (quoted) throw new Error('Unclosed CSV quote');
  if (row.length || cell || closed) finishRow();
  return rows;
}

function wholeAmount(value) {
  const text = value.trim();
  if (!/^-?(?:[0-9]+|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.0{1,2})?$/.test(text)) throw new Error('CSV amount must be a signed whole-won number (only .00 decimals supported)');
  const amount = Number(text.replaceAll(',', ''));
  if (!Number.isSafeInteger(amount) || amount === 0) throw new Error('CSV amount must be a nonzero safe whole-won amount');
  return amount;
}

function csvRows(csvText) {
  const parsed = parseCsv(csvText); const header = parsed.shift()?.map(value => value.trim().toLowerCase());
  if (!header || new Set(header).size !== header.length || header.some(value => !value) || !['date', 'amount'].every(value => header.includes(value))) throw new Error('Unique Date and Amount CSV headers required');
  if (!parsed.length) throw new Error('CSV contains no transactions');
  const sourceAccounts = new Set();
  const rows = parsed.map((cells, index) => {
    if (cells.length !== header.length) throw new Error(`CSV record ${index + 2} has incorrect column count`);
    const values = Object.fromEntries(header.map((name, column) => [name, cells[column]]));
    const date = values.date.trim(); assertDate(date);
    const sourceAccount = values.account?.trim() ?? '';
    if (header.includes('account') && !sourceAccount) throw new Error('CSV Account values cannot be blank');
    if (sourceAccount) sourceAccounts.add(sourceAccount);
    const payee = values.payee ?? ''; const notes = values.notes ?? ''; const category = values.category ?? '';
    if ([sourceAccount, payee, notes, category].some(value => value.length > 500)) throw new Error('CSV text fields must be at most 500 characters');
    if ([values.cleared ?? '', values.reconciled ?? ''].some(value => value.length > 50)) throw new Error('CSV status fields are too long');
    if (/^\(SPLIT\b/i.test(notes.trimStart()) || values.parentid?.trim() || /^(?:true|1)$/i.test((values.isparent ?? '').trim()) || /^(?:true|1)$/i.test((values.ischild ?? '').trim()) ||
      values.split_amount?.trim() && !/^-?0(?:\.0{1,2})?$/.test(values.split_amount.trim())) throw new Error('Split transactions are not supported; export simple transactions separately');
    if (/^(?:transfer|이체)\s*:/i.test(payee.trimStart())) throw new Error('Transfers are not supported by simple CSV import');
    return { date, amount: wholeAmount(values.amount), payee, notes, category, sourceAccount,
      cleared: values.cleared ?? '', reconciled: values.reconciled ?? '' };
  });
  if (sourceAccounts.size > 1) throw new Error('Export one account at a time');
  // Sorting makes BOM/newline/column/record order changes idempotent; identical legitimate records remain separate.
  rows.sort((a, b) => { const left = JSON.stringify(a); const right = JSON.stringify(b); return left < right ? -1 : left > right ? 1 : 0; });
  const inflow = rows.filter(row => row.amount > 0).reduce((sum, row) => sum + row.amount, 0);
  const outflow = rows.filter(row => row.amount < 0).reduce((sum, row) => sum - row.amount, 0);
  if (![inflow, outflow, inflow - outflow].every(Number.isSafeInteger)) throw new Error('CSV totals exceed supported range');
  return { rows, sourceAccount: [...sourceAccounts][0] ?? '', inflow, outflow };
}

function accountFor(book, sub, accountId) {
  const account = book.accounts().get(accountId);
  if (!account || !['asset', 'liability'].includes(account.type) || !canAccessAccount(book, sub, accountId, 'write')) throw new Error('Financial account write access required');
  return account;
}
const rowKey = row => entryFingerprint({ date: row.date, amount: row.amount, payee: row.payee, notes: row.notes });

export function actualCsvPreview(book, sub, { accountId, csvText }) {
  const account = accountFor(book, sub, accountId); const data = csvRows(csvText);
  if (account.type === 'liability' && data.inflow > 0) throw new Error('Positive card/liability CSV amounts need a payment or refund workflow; simple import supports expenses only');
  const batchId = entryFingerprint({ accountId, rows: data.rows });
  const existing = book.db.prepare('SELECT data FROM actual_csv_batches WHERE id = ?').get(batchId);
  const previous = book.db.prepare('SELECT id, data FROM import_events WHERE channel_id = ?').all(`csv:${accountId}`)
    .map(row => { const event = JSON.parse(row.data); return { id: row.id, key: event.csvRow ? rowKey(event.csvRow) : null }; });
  const inputKeys = new Set(data.rows.map(rowKey));
  const overlaps = existing ? [] : previous.filter(row => row.key && inputKeys.has(row.key));
  const overlapIds = overlaps.map(row => row.id).sort();
  const existingKeys = new Set(overlaps.map(row => row.key));
  const rows = data.rows.map(row => ({ ...row, possibleDuplicate: existingKeys.has(rowKey(row)) }));
  const result = { account, sourceAccount: data.sourceAccount, batchId, rows, inflow: data.inflow, outflow: data.outflow,
    duplicate: Boolean(existing), possibleDuplicateCount: rows.filter(row => row.possibleDuplicate).length };
  return { ...result, expectedHash: entryFingerprint({ batchId, account, existing: Boolean(existing), overlapIds }) };
}

export function importActualCsv(book, sub, input) {
  accountFor(book, sub, input.accountId);
  if (input.confirmSimple !== true) throw new Error('Confirm this CSV contains only simple income and expense transactions');
  if (typeof input.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.requestId) ||
    typeof input.expectedHash !== 'string' || !/^[0-9a-f]{64}$/.test(input.expectedHash)) throw new Error('Valid CSV request ID and preview hash required');
  return book.atomic(() => {
    const preview = actualCsvPreview(book, sub, input);
    const old = book.db.prepare('SELECT data FROM actual_csv_requests WHERE id = ?').get(input.requestId);
    if (old) {
      const receipt = JSON.parse(old.data);
      if (receipt.batchId !== preview.batchId || receipt.actor !== sub || receipt.expectedHash !== input.expectedHash) throw new Error('CSV request ID reused');
      return { ...JSON.parse(book.db.prepare('SELECT data FROM actual_csv_batches WHERE id = ?').get(receipt.batchId).data), duplicate: true };
    }
    const existing = book.db.prepare('SELECT data FROM actual_csv_batches WHERE id = ?').get(preview.batchId);
    let batch;
    if (existing) batch = JSON.parse(existing.data);
    else {
      if (preview.expectedHash !== input.expectedHash) throw new Error('CSV target or review events changed; preview again');
      if (preview.possibleDuplicateCount && input.confirmDuplicates !== true) throw new Error('Confirm possible duplicate records before importing');
      const eventIds = preview.rows.map(({ possibleDuplicate, ...row }, index) => {
        const rawText = JSON.stringify(row);
        const { event } = receiveImport(book, { id: `csv:${input.accountId}`, accountId: input.accountId }, { rawText, externalId: `${preview.batchId}:${index}` }, `actualcsv:${preview.batchId}:${index}`);
        event.source = 'actual-csv'; event.csvRow = row; event.batchId = preview.batchId; event.importedBy = sub;
        event.parsed = { date: row.date, amount: row.amount, payee: [row.payee, row.notes].filter(Boolean).join(' · ') };
        event.status = 'parsed-pending-review';
        book.db.prepare('UPDATE import_events SET data = ? WHERE id = ?').run(JSON.stringify(event), event.id);
        return event.id;
      });
      batch = { id: preview.batchId, accountId: input.accountId, sourceAccount: preview.sourceAccount, actor: sub,
        createdAt: new Date().toISOString(), count: eventIds.length, inflow: preview.inflow, outflow: preview.outflow, eventIds,
        possibleDuplicateCount: preview.possibleDuplicateCount, confirmedDuplicates: input.confirmDuplicates === true };
      book.db.prepare('INSERT INTO actual_csv_batches (id, account_id, data) VALUES (?, ?, ?)').run(batch.id, batch.accountId, JSON.stringify(batch));
    }
    book.db.prepare('INSERT INTO actual_csv_requests (id, data) VALUES (?, ?)').run(input.requestId,
      JSON.stringify({ batchId: batch.id, actor: sub, expectedHash: input.expectedHash }));
    return { ...batch, duplicate: Boolean(existing) };
  });
}
