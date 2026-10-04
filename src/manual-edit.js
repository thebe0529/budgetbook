import { createHash } from 'node:crypto';
import { buildManualEntry } from './manual.js';
import { canAccessAccount, member } from './members.js';
import { entryFingerprint } from './transaction-checks.js';

export function manualEditPreview(book, sub, entryId) {
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  const accounts = book.accounts();
  const denied = () => { throw new Error('Manual transaction cannot be edited'); };
  if (!entry || entry.kind !== 'manual' || !entry.sourceAccountId || entry.postings.length !== 2 ||
    (entry.createdBy !== sub && member(book, sub)?.role !== 'owner') ||
    !canAccessAccount(book, sub, entry.sourceAccountId, 'write') ||
    entry.postings.some(p => ['asset', 'liability'].includes(accounts.get(p.accountId)?.type) &&
      !canAccessAccount(book, sub, p.accountId, 'write')) ||
    book.db.prepare('SELECT 1 FROM transaction_reversals WHERE original_id = ?').get(entryId)) denied();
  const source = entry.postings.find(p => p.accountId === entry.sourceAccountId);
  const counter = entry.postings.find(p => p.accountId !== entry.sourceAccountId);
  if (!source || !counter) denied();
  const counterType = accounts.get(counter.accountId)?.type;
  // Older manual entries did not persist their input kind.
  const kind = counterType === 'expense' ? 'expense' : counterType === 'income' ? 'income' :
    counterType === 'equity' ? 'opening' : ['asset', 'liability'].includes(counterType) ? 'transfer' : null;
  if (!kind || (kind === 'opening' && member(book, sub)?.role !== 'owner')) denied();
  return { entry, expectedHash: entryFingerprint(entry), input: { date: entry.date, kind,
    accountId: entry.sourceAccountId, counterId: counter.accountId, amountExpression: String(source.amount),
    categoryId: entry.budgetAllocations?.[0]?.categoryId ?? '', memo: entry.memo ?? '' } };
}

export function updateManualTransaction(book, sub, { entryId, expectedHash, updateRequestId, ...input }) {
  if (typeof updateRequestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(updateRequestId)) {
    throw new Error('Valid update request ID required');
  }
  return book.atomic(() => {
    const preview = manualEditPreview(book, sub, entryId);
    const previous = preview.entry;
    if (input.accountId !== previous.sourceAccountId) throw new Error('Source account cannot be changed');
    if (input.kind !== preview.input.kind) throw new Error('Transaction type cannot be changed');
    const next = buildManualEntry(book, sub, input, entryId, previous.createdBy, (previous.revision ?? 1) + 1);
    const requestHash = createHash('sha256').update(JSON.stringify({ entryId, expectedHash,
      payloadHash: next.payloadHash })).digest('hex');
    const sent = book.db.prepare('SELECT * FROM entry_update_requests WHERE request_id = ?').get(updateRequestId);
    if (sent) {
      if (sent.entry_id !== entryId || sent.actor_sub !== sub || sent.payload_hash !== requestHash) {
        throw new Error('Request ID reused with different manual update');
      }
      return { entry: previous, duplicate: true };
    }
    if (expectedHash !== preview.expectedHash) throw new Error('Transaction changed; reload before editing');
    book.db.prepare(`INSERT INTO entry_revisions (entry_id, revision, data, actor_sub, changed_at)
      VALUES (?, ?, ?, ?, ?)`).run(entryId, previous.revision ?? 1, JSON.stringify(previous), sub, new Date().toISOString());
    // The database guard checks both the original and replacement account periods.
    book.db.prepare('UPDATE entries SET date = ?, data = ? WHERE id = ?').run(next.date, JSON.stringify(next), entryId);
    book.db.prepare(`INSERT INTO entry_update_requests
      (request_id, entry_id, actor_sub, payload_hash, applied_revision) VALUES (?, ?, ?, ?, ?)`)
      .run(updateRequestId, entryId, sub, requestHash, next.revision);
    return { entry: next, duplicate: false };
  });
}
