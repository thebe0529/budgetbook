import { createHash } from 'node:crypto';
import { canAccessAccount } from './members.js';

export const entryFingerprint = entry => createHash('sha256').update(JSON.stringify(entry)).digest('hex');

export function setTransactionChecked(book, sub, accountId, entryId, checked, expectedHash) {
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  if (typeof checked !== 'boolean') throw new Error('Invalid confirmation status');
  return book.atomic(() => {
    writeCheck(book, sub, accountId, entryId, checked, expectedHash);
  });
}

export function confirmTransactions(book, sub, accountId, selections) {
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 200 ||
      selections.some(item => !item || typeof item.entryId !== 'string' || typeof item.expectedHash !== 'string') ||
      new Set(selections.map(item => item.entryId)).size !== selections.length) {
    throw new Error('Select one to two hundred distinct transactions');
  }
  return book.atomic(() => {
    for (const item of selections) writeCheck(book, sub, accountId, item.entryId, true, item.expectedHash);
    return selections.length;
  });
}

function writeCheck(book, sub, accountId, entryId, checked, expectedHash) {
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  if (!entry || !entry.postings.some(p => p.accountId === accountId)) throw new Error('Account transaction not found');
  const lock = book.db.prepare('SELECT through_date FROM account_period_locks WHERE account_id = ?').get(accountId);
  if (lock && entry.date <= lock.through_date) {
    const existing = book.db.prepare('SELECT entry_hash FROM account_entry_checks WHERE account_id = ? AND entry_id = ?').get(accountId, entryId);
    if (checked && expectedHash === entryFingerprint(entry) && existing?.entry_hash === expectedHash) return;
    throw new Error('Account period is locked');
  }
  if (checked && expectedHash !== entryFingerprint(entry)) throw new Error('Transaction changed; reload before confirming');
  if (!checked) {
    book.db.prepare('DELETE FROM account_entry_checks WHERE account_id = ? AND entry_id = ?').run(accountId, entryId);
    return;
  }
  book.db.prepare(`INSERT INTO account_entry_checks (account_id, entry_id, entry_hash, actor, checked_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(account_id, entry_id) DO UPDATE SET
    entry_hash=excluded.entry_hash, actor=excluded.actor, checked_at=excluded.checked_at`)
    .run(accountId, entryId, entryFingerprint(entry), sub, new Date().toISOString());
}
