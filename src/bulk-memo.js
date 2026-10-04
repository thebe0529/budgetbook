import { createHash } from 'node:crypto';
import { canAccessAccount } from './members.js';
import { buildManualEntry } from './manual.js';
import { manualEditPreview } from './manual-edit.js';
import { buildSplitEntry, editableManual } from './split-manual.js';
import { entryFingerprint } from './transaction-checks.js';

export function updateSelectedMemos(book, sub, { accountId, selections, memo, requestId }) {
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  if (typeof memo !== 'string' || memo.length > 500) throw new Error('Invalid memo');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Valid request ID required');
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 200 || selections.some(item =>
    !item || typeof item.entryId !== 'string' || typeof item.expectedHash !== 'string') ||
    new Set(selections.map(item => item.entryId)).size !== selections.length) throw new Error('Select one to two hundred distinct transactions');
  memo = memo.trim();
  const ordered = selections.map(item => ({ entryId: item.entryId, expectedHash: item.expectedHash }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId));
  const payloadHash = createHash('sha256').update(JSON.stringify({ sub, accountId, memo, selections: ordered })).digest('hex');
  return book.atomic(() => {
    const accounts = book.accounts();
    const originals = ordered.map(selection => {
      const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(selection.entryId);
      const entry = row && JSON.parse(row.data);
      if (!entry || entry.sourceAccountId !== accountId || !['manual', 'manual-split'].includes(entry.kind) ||
        entry.postings.some(p => ['asset', 'liability'].includes(accounts.get(p.accountId)?.type) &&
          !canAccessAccount(book, sub, p.accountId, 'write'))) throw new Error('Selected manual transaction cannot be edited');
      const previous = entry.kind === 'manual' ? manualEditPreview(book, sub, entry.id).entry : editableManual(book, sub, entry.id);
      if (!previous) throw new Error('Selected manual transaction cannot be edited');
      return previous;
    });
    const sent = book.db.prepare('SELECT data FROM bulk_memo_requests WHERE request_id = ?').get(requestId);
    if (sent) {
      const saved = JSON.parse(sent.data);
      if (saved.payloadHash !== payloadHash) throw new Error('Request ID reused with different memo update');
      return { count: saved.entryIds.length, duplicate: true };
    }
    for (let i = 0; i < originals.length; i++) {
      if (entryFingerprint(originals[i]) !== ordered[i].expectedHash) throw new Error('Transaction changed; reload before editing');
    }
    const changedAt = new Date().toISOString();
    for (const previous of originals) {
      const revision = previous.revision ?? 1;
      let next;
      if (previous.kind === 'manual') {
        const input = manualEditPreview(book, sub, previous.id).input;
        next = buildManualEntry(book, sub, { ...input, memo }, previous.id, previous.createdBy, revision + 1);
      } else {
        const lines = previous.postings.filter(p => p.accountId !== previous.sourceAccountId).map((p, index) => ({
          counterId: p.accountId, amountExpression: String(p.amount), categoryId: previous.budgetAllocations?.[index]?.categoryId ?? null }));
        next = buildSplitEntry(book, sub, { date: previous.date, kind: previous.splitKind,
          accountId: previous.sourceAccountId, memo, lines }, previous.id, previous.createdBy, revision + 1);
      }
      book.db.prepare(`INSERT INTO entry_revisions (entry_id, revision, data, actor_sub, changed_at)
        VALUES (?, ?, ?, ?, ?)`).run(previous.id, revision, JSON.stringify(previous), sub, changedAt);
      book.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify(next), previous.id);
    }
    book.db.prepare('INSERT INTO bulk_memo_requests (request_id, data) VALUES (?, ?)').run(requestId,
      JSON.stringify({ payloadHash, accountId, memo, actor: sub, changedAt, entryIds: originals.map(entry => entry.id) }));
    return { count: originals.length, duplicate: false };
  });
}
