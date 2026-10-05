import { canAccessAccount, member } from './members.js';
import { assertDate } from './ledger.js';
import { entryFingerprint } from './transaction-checks.js';

export function manualReversalPreview(book, sub, entryId) {
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  const accounts = book.accounts();
  if (book.db.prepare('SELECT 1 FROM card_refund_receipts WHERE entry_id = ?').get(entryId) ||
      !entry || !['manual', 'manual-split'].includes(entry.kind) || !entry.sourceAccountId ||
      (entry.createdBy !== sub && member(book, sub)?.role !== 'owner') ||
      !canAccessAccount(book, sub, entry.sourceAccountId, 'write') ||
      entry.postings.some(p => ['asset', 'liability'].includes(accounts.get(p.accountId)?.type) &&
        !canAccessAccount(book, sub, p.accountId, 'write'))) throw new Error('Transaction cannot be reversed');
  const reversal = book.db.prepare('SELECT data FROM transaction_reversals WHERE original_id = ?').get(entryId);
  return { entry, expectedHash: entryFingerprint(entry), reversal: reversal ? JSON.parse(reversal.data) : null };
}

export function reverseManualTransaction(book, sub, { entryId, date, reason, expectedHash, requestId }) {
  assertDate(date);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new Error('Reversal reason required (up to 200 characters)');
  reason = reason.trim();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid reversal request ID');
  return book.atomic(() => {
    const { entry: original, reversal } = manualReversalPreview(book, sub, entryId);
    const sent = book.db.prepare('SELECT data FROM transaction_reversals WHERE request_id = ?').get(requestId);
    if (sent) {
      const saved = JSON.parse(sent.data);
      if (saved.originalId !== entryId || saved.actor !== sub || saved.date !== date || saved.reason !== reason || saved.expectedHash !== expectedHash) {
        throw new Error('Reversal request ID reused');
      }
      const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(saved.reversalId);
      return { entry: JSON.parse(row.data), duplicate: true };
    }
    if (reversal) throw new Error('Transaction already reversed');
    if (expectedHash !== entryFingerprint(original)) throw new Error('Transaction changed; reload before reversing');
    if (date < original.date) throw new Error('Reversal date precedes original transaction');
    const entry = { id: `manual-reversal:${requestId}`, date, kind: 'manual-reversal',
      createdBy: sub, sourceAccountId: original.sourceAccountId, reversesEntryId: entryId,
      memo: `거래 취소 (${reason}): ${original.memo || original.id}`,
      postings: original.postings.map(p => ({ ...p, side: p.side === 'debit' ? 'credit' : 'debit' })),
      ...(original.budgetAllocations ? { budgetAllocations: original.budgetAllocations.map(item => ({ ...item, amount: -item.amount })) } : {}) };
    const scheduleLink = book.db.prepare('SELECT * FROM cash_schedule_links WHERE entry_id = ?').get(entryId);
    book.record(entry);
    const audit = { originalId: entryId, reversalId: entry.id, requestId, expectedHash, date, reason,
      actor: sub, createdAt: new Date().toISOString(), detachedScheduleLink: scheduleLink ? { ...scheduleLink } : null };
    book.db.prepare('INSERT INTO transaction_reversals (original_id, reversal_id, request_id, data) VALUES (?, ?, ?, ?)')
      .run(entryId, entry.id, requestId, JSON.stringify(audit));
    if (scheduleLink) book.db.prepare('DELETE FROM cash_schedule_links WHERE entry_id = ?').run(entryId);
    return { entry, duplicate: false };
  });
}
