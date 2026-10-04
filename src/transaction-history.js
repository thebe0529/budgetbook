import { canAccessAccount } from './members.js';

export function transactionHistory(book, sub, accountId, entryId) {
  const denied = () => { throw new Error('Transaction history read access required'); };
  const accounts = book.accounts();
  if (!['asset', 'liability'].includes(accounts.get(accountId)?.type) ||
    !canAccessAccount(book, sub, accountId)) denied();
  const load = id => {
    const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  };
  const requested = load(entryId);
  if (!requested || !requested.postings.some(p => p.accountId === accountId)) denied();
  const original = requested.kind === 'manual-reversal' ? load(requested.reversesEntryId) : requested;
  if (!original || !['manual', 'manual-split'].includes(original.kind)) denied();
  const revisions = book.db.prepare('SELECT * FROM entry_revisions WHERE entry_id = ? ORDER BY revision')
    .all(original.id);
  const versions = [...revisions.map(row => JSON.parse(row.data)), original];
  const row = book.db.prepare('SELECT data FROM transaction_reversals WHERE original_id = ?').get(original.id);
  const audit = row ? JSON.parse(row.data) : null;
  const reversal = audit ? load(audit.reversalId) : null;
  // Check every historical financial account before returning any audit details.
  for (const entry of [...versions, ...(reversal ? [reversal] : [])]) {
    if (entry.postings.some(p => !accounts.has(p.accountId) ||
      (['asset', 'liability'].includes(accounts.get(p.accountId).type) &&
        !canAccessAccount(book, sub, p.accountId)))) denied();
  }
  const snapshot = entry => ({ id: entry.id, revision: entry.revision ?? 1, date: entry.date,
    memo: entry.memo ?? '', postings: entry.postings.map(p => ({ ...p, accountName: accounts.get(p.accountId).name })),
    budgetAllocations: (entry.budgetAllocations ?? []).map(item => ({ ...item,
      categoryName: book.budgetCategories().get(item.categoryId)?.name ?? item.categoryId })) });
  return { accountId, originalId: original.id,
    versions: versions.map((entry, index) => ({ ...snapshot(entry),
      actor: index ? revisions[index - 1].actor_sub : entry.createdBy,
      changedAt: index ? revisions[index - 1].changed_at : null })),
    reversal: audit && reversal ? { entry: snapshot(reversal), actor: audit.actor,
      reason: audit.reason, createdAt: audit.createdAt, date: audit.date } : null };
}
