import { createHash } from 'node:crypto';
import { canAccessAccount } from './members.js';

export const entryFingerprint = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');

export function setTransactionChecked(book, sub, accountId, entryId, checked, expectedHash) {
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  if (typeof checked !== 'boolean') throw new Error('Invalid confirmation status');
  return book.atomic(() => {
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  if (!entry || !entry.postings.some(p => p.accountId === accountId)) throw new Error('Account transaction not found');
  if (checked && expectedHash !== entryFingerprint(entry)) throw new Error('Transaction changed; reload before confirming');
  if (!checked) {
    book.db.prepare('DELETE FROM account_entry_checks WHERE account_id = ? AND entry_id = ?').run(accountId, entryId);
    return;
  }
  book.db.prepare(`INSERT INTO account_entry_checks (account_id, entry_id, entry_hash, actor, checked_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, entry_id) DO UPDATE SET
    entry_hash=excluded.entry_hash, actor=excluded.actor, checked_at=excluded.checked_at`)
    .run(accountId, entryId, entryFingerprint(entry), sub, new Date().toISOString());
  });
}
