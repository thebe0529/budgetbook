import { createHash, randomUUID } from 'node:crypto';
import { assertDate, validateEntry } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { member } from './members.js';

const owner = (book, sub) => {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
};

export function listAdjustments(book, sub) {
  owner(book, sub);
  const reversals = new Map(book.db.prepare('SELECT original_id, reversal_id FROM adjustment_reversals').all()
    .map(row => [row.original_id, row.reversal_id]));
  return book.db.prepare('SELECT data FROM adjustment_batches ORDER BY rowid DESC').all()
    .map(row => JSON.parse(row.data)).map(batch => ({ ...batch,
      reversalId: reversals.get(batch.id) ?? null }));
}

export function recordAdjustment(book, sub, { requestId, date, reason, rows }) {
  owner(book, sub);
  assertDate(date);
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId) ||
    typeof reason !== 'string' || !reason.trim() || reason.length > 200 ||
    !Array.isArray(rows) || rows.length < 1 || rows.length > 50) {
    throw new Error('Invalid adjustment batch');
  }
  const accounts = book.accounts();
  const categories = book.budgetCategories();
  const entries = rows.map(row => {
    const { debitId, creditId, categoryId, memo = '' } = row;
    if (!accounts.has(debitId) || !accounts.has(creditId) || debitId === creditId ||
      typeof memo !== 'string' || memo.length > 200) throw new Error('Invalid adjustment row');
    const amount = calculateAmount(row.amountExpression);
    if (amount <= 0) throw new Error('Adjustment amount must be positive');
    if (categoryId && (!categories.has(categoryId) || accounts.get(debitId).type !== 'expense' ||
      !accounts.get(creditId).onBudget || !['asset', 'liability'].includes(accounts.get(creditId).type))) {
      throw new Error('Invalid adjustment budget category');
    }
    return { memo: memo.trim(), postings: [{ accountId: debitId, side: 'debit', amount },
      { accountId: creditId, side: 'credit', amount }],
    ...(categoryId ? { budgetAllocations: [{ categoryId, amount }] } : {}) };
  });
  const payloadHash = createHash('sha256').update(JSON.stringify({ date, reason: reason.trim(), entries }))
    .digest('hex');
  const previous = book.db.prepare('SELECT data FROM adjustment_batches WHERE id = ?').get(requestId);
  if (previous) {
    const batch = JSON.parse(previous.data);
    if (batch.createdBy !== sub || batch.payloadHash !== payloadHash) {
      throw new Error('Request ID reused with different adjustment');
    }
    return { batch, duplicate: true };
  }
  const batch = book.adjustBatch({ id: requestId, date, reason: reason.trim(), entries,
    createdBy: sub, payloadHash });
  return { batch, duplicate: false };
}

export function reverseAdjustment(book, sub, { batchId, date, reason }) {
  owner(book, sub);
  assertDate(date);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) {
    throw new Error('Reversal reason required');
  }
  const source = book.db.prepare('SELECT data FROM adjustment_batches WHERE id = ?').get(batchId);
  const original = source && JSON.parse(source.data);
  if (!original || original.reversesBatchId) throw new Error('Original adjustment batch not found');
  const old = original.entryIds.map(id => {
    const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(id);
    if (!row) throw new Error('Adjustment entry missing');
    return JSON.parse(row.data);
  });
  if (date < original.date) throw new Error('Reversal date precedes original adjustment');
  const id = randomUUID();
  const batch = { id, date, reason: reason.trim(), reversesBatchId: batchId, createdBy: sub,
    entryIds: old.map((_, i) => `reverse:${id}:${i + 1}`) };
  const entries = old.map((entry, i) => ({ id: batch.entryIds[i], date,
    kind: 'adjustment-reversal', memo: `${reason.trim()}: ${entry.memo ?? ''}`,
    postings: entry.postings.map(p => ({ ...p, side: p.side === 'debit' ? 'credit' : 'debit' })),
    ...(entry.budgetAllocations ? { budgetAllocations: entry.budgetAllocations.map(a =>
      ({ ...a, amount: -a.amount })) } : {}) }));
  entries.forEach(entry => { validateEntry(entry, book.accounts()); book.validateBudgetAllocations(entry); });
  return book.atomic(() => {
    if (original.entryIds.some(entryId => book.db.prepare('SELECT 1 FROM card_refund_receipts WHERE entry_id = ?').get(entryId))) {
      throw new Error('Adjustment contains a linked card refund receipt and cannot be reversed');
    }
    book.db.prepare('INSERT INTO adjustment_reversals (original_id, reversal_id) VALUES (?, ?)')
      .run(batchId, id);
    entries.forEach(entry => book.record(entry));
    book.db.prepare('INSERT INTO adjustment_batches (id, data) VALUES (?, ?)')
      .run(id, JSON.stringify(batch));
    return batch;
  });
}
