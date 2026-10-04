import { createHash } from 'node:crypto';
import { canAccessAccount, member } from './members.js';
import { entryFingerprint } from './transaction-checks.js';

export function normalizeTags(value) {
  if (typeof value !== 'string' || value.length > 500) throw new Error('Invalid tags');
  const tags = [...new Set(value.split(',').map(tag => tag.trim().normalize('NFC')).filter(Boolean))];
  if (tags.length > 10 || tags.some(tag => tag.length > 30 || /[\p{Cc}\p{Cf}]/u.test(tag))) throw new Error('Use up to ten tags of thirty characters');
  return tags.sort((a, b) => a.localeCompare(b, 'ko-KR'));
}
export const tagsFingerprint = tags => createHash('sha256').update(JSON.stringify(tags)).digest('hex');
export function transactionTags(book, entryId) {
  const row = book.db.prepare('SELECT data FROM transaction_tags WHERE entry_id = ?').get(entryId);
  const tags = row ? JSON.parse(row.data).tags : [];
  return { tags, tagsHash: tagsFingerprint(tags) };
}

export function tagEditPreview(book, sub, accountId, entryId) {
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  const accounts = book.accounts();
  if (!entry || !['manual', 'manual-split'].includes(entry.kind) || entry.sourceAccountId !== accountId ||
    (entry.createdBy !== sub && member(book, sub)?.role !== 'owner') ||
    entry.postings.some(p => ['asset', 'liability'].includes(accounts.get(p.accountId)?.type) && !canAccessAccount(book, sub, p.accountId, 'write')) ||
    book.db.prepare('SELECT 1 FROM transaction_reversals WHERE original_id = ?').get(entryId)) {
    throw new Error('Transaction tag write access required');
  }
  return { entry, ...transactionTags(book, entryId), expectedHash: entryFingerprint(entry) };
}

export function updateTransactionTags(book, sub, { accountId, entryId, tags: rawTags, expectedHash, tagsHash, requestId }) {
  const tags = normalizeTags(rawTags);
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Valid request ID required');
  const payloadHash = createHash('sha256').update(JSON.stringify({ sub, accountId, entryId, tags, expectedHash, tagsHash })).digest('hex');
  return book.atomic(() => {
    const previous = tagEditPreview(book, sub, accountId, entryId);
    const sent = book.db.prepare('SELECT data FROM transaction_tag_changes WHERE request_id = ?').get(requestId);
    if (sent) {
      if (JSON.parse(sent.data).payloadHash !== payloadHash) throw new Error('Request ID reused with different tags');
      return { duplicate: true };
    }
    if (previous.expectedHash !== expectedHash || previous.tagsHash !== tagsHash) throw new Error('Transaction or tags changed; reload before editing');
    const changedAt = new Date().toISOString();
    book.db.prepare(`INSERT INTO transaction_tags (entry_id, data) VALUES (?, ?)
      ON CONFLICT(entry_id) DO UPDATE SET data = excluded.data`).run(entryId, JSON.stringify({ tags }));
    book.db.prepare('INSERT INTO transaction_tag_changes (request_id, entry_id, data) VALUES (?, ?, ?)')
      .run(requestId, entryId, JSON.stringify({ payloadHash, before: previous.tags, after: tags, actor: sub, changedAt }));
    return { duplicate: false };
  });
}
