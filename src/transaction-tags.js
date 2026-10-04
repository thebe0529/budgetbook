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
    writeTags(book, sub, { entryId, tags, previous: previous.tags, requestId, payloadHash, changedAt: new Date().toISOString() });
    return { duplicate: false };
  });
}

function writeTags(book, sub, { entryId, tags, previous, requestId, payloadHash, changedAt, batchId }) {
  book.db.prepare(`INSERT INTO transaction_tags (entry_id, data) VALUES (?, ?)
    ON CONFLICT(entry_id) DO UPDATE SET data = excluded.data`).run(entryId, JSON.stringify({ tags }));
  book.db.prepare('INSERT INTO transaction_tag_changes (request_id, entry_id, data) VALUES (?, ?, ?)')
    .run(requestId, entryId, JSON.stringify({ payloadHash, before: previous, after: tags, actor: sub, changedAt, batchId }));
}

export function updateSelectedTags(book, sub, { accountId, selections, tags: rawTags, mode, requestId }) {
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  if (!['add', 'remove', 'replace'].includes(mode)) throw new Error('Invalid tag operation');
  const tags = normalizeTags(rawTags);
  if (mode !== 'replace' && !tags.length) throw new Error('Select tags to add or remove');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Valid request ID required');
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 200 || selections.some(item =>
    !item || typeof item.entryId !== 'string' || typeof item.expectedHash !== 'string' || typeof item.tagsHash !== 'string') ||
    new Set(selections.map(item => item.entryId)).size !== selections.length) throw new Error('Select one to two hundred distinct transactions');
  const ordered = selections.map(({ entryId, expectedHash, tagsHash }) => ({ entryId, expectedHash, tagsHash }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId));
  const payloadHash = createHash('sha256').update(JSON.stringify({ sub, accountId, mode, tags, selections: ordered })).digest('hex');
  return book.atomic(() => {
    const originals = ordered.map(item => tagEditPreview(book, sub, accountId, item.entryId));
    const sent = book.db.prepare('SELECT data FROM bulk_tag_requests WHERE request_id = ?').get(requestId);
    if (sent) {
      const saved = JSON.parse(sent.data);
      if (saved.payloadHash !== payloadHash) throw new Error('Request ID reused with different bulk tags');
      return { count: saved.count, changed: saved.changed, duplicate: true };
    }
    const changedAt = new Date().toISOString(); let changed = 0;
    for (let i = 0; i < originals.length; i++) {
      const previous = originals[i]; const selection = ordered[i];
      if (previous.expectedHash !== selection.expectedHash || previous.tagsHash !== selection.tagsHash) {
        throw new Error('Transaction or tags changed; reload before editing');
      }
      const next = mode === 'replace' ? tags : mode === 'remove' ? previous.tags.filter(tag => !tags.includes(tag)) :
        normalizeTags([...new Set([...previous.tags, ...tags])].join(','));
      if (tagsFingerprint(next) === previous.tagsHash) continue;
      writeTags(book, sub, { entryId: selection.entryId, tags: next, previous: previous.tags,
        requestId: `${requestId}:${selection.entryId}`, payloadHash, changedAt, batchId: requestId });
      changed++;
    }
    book.db.prepare('INSERT INTO bulk_tag_requests (request_id, data) VALUES (?, ?)').run(requestId,
      JSON.stringify({ payloadHash, accountId, mode, tags, actor: sub, changedAt, entryIds: ordered.map(item => item.entryId), count: ordered.length, changed }));
    return { count: ordered.length, changed, duplicate: false };
  });
}
