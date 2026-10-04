import { canAccessAccount } from './members.js';

// A copy is a new draft, so it does not inherit the original ID, author or checks.
export function transactionCopyPreview(book, sub, entryId) {
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  const accounts = book.accounts();
  const denied = () => { throw new Error('Transaction cannot be copied'); };
  if (!entry || !['manual', 'manual-split'].includes(entry.kind) || !entry.sourceAccountId ||
    !['asset', 'liability'].includes(accounts.get(entry.sourceAccountId)?.type) ||
    !canAccessAccount(book, sub, entry.sourceAccountId, 'write') ||
    entry.postings.some(p => !accounts.has(p.accountId) ||
      (['asset', 'liability'].includes(accounts.get(p.accountId).type) &&
        !canAccessAccount(book, sub, p.accountId, 'write'))) ||
    book.db.prepare('SELECT 1 FROM transaction_reversals WHERE original_id = ?').get(entryId)) denied();
  const date = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' });
  if (entry.kind === 'manual-split') {
    if (!['expense', 'income', 'transfer'].includes(entry.splitKind)) denied();
    return { entry, input: { date, kind: entry.splitKind, accountId: entry.sourceAccountId, memo: entry.memo ?? '',
      lines: entry.postings.filter(p => p.accountId !== entry.sourceAccountId).map((p, index) => ({
        counterId: p.accountId, amountExpression: String(p.amount), categoryId: entry.budgetAllocations?.[index]?.categoryId ?? null })) } };
  }
  const source = entry.postings.find(p => p.accountId === entry.sourceAccountId);
  const counter = entry.postings.find(p => p.accountId !== entry.sourceAccountId);
  if (entry.postings.length !== 2 || !source || !counter) denied();
  const type = accounts.get(counter.accountId).type;
  const kind = type === 'expense' ? 'expense' : type === 'income' ? 'income' :
    ['asset', 'liability'].includes(type) ? 'transfer' : null;
  // Opening balances are deliberately not offered as repeatable transactions.
  if (!kind) denied();
  return { entry, input: { date, kind, accountId: entry.sourceAccountId, counterId: counter.accountId,
    amountExpression: String(source.amount), categoryId: entry.budgetAllocations?.[0]?.categoryId ?? '', memo: entry.memo ?? '' } };
}
