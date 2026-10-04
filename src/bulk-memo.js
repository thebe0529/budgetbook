import { createHash } from 'node:crypto';
import { canAccessAccount } from './members.js';
import { buildManualEntry } from './manual.js';
import { manualEditPreview } from './manual-edit.js';
import { buildSplitEntry, editableManual } from './split-manual.js';
import { entryFingerprint } from './transaction-checks.js';

export function updateSelectedMemos(book, sub, input) {
  return updateSelectedDetails(book, sub, input, 'memo');
}

export function updateSelectedCategories(book, sub, input) {
  return updateSelectedDetails(book, sub, input, 'category');
}

function updateSelectedDetails(book, sub, { accountId, selections, memo, categoryId, requestId }, mode) {
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  if (mode === 'memo' && (typeof memo !== 'string' || memo.length > 500)) throw new Error('Invalid memo');
  if (mode === 'category' && (typeof categoryId !== 'string' ||
    (categoryId && !book.budgetCategories().has(categoryId)) || !book.accounts().get(accountId)?.onBudget)) {
    throw new Error('Invalid budget category or off-budget account');
  }
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Valid request ID required');
  if (!Array.isArray(selections) || selections.length < 1 || selections.length > 200 || selections.some(item =>
    !item || typeof item.entryId !== 'string' || typeof item.expectedHash !== 'string') ||
    new Set(selections.map(item => item.entryId)).size !== selections.length) throw new Error('Select one to two hundred distinct transactions');
  if (mode === 'memo') memo = memo.trim();
  else categoryId = categoryId || null;
  const change = mode === 'memo' ? { memo } : { categoryId };
  const table = mode === 'memo' ? 'bulk_memo_requests' : 'bulk_category_requests';
  const ordered = selections.map(item => ({ entryId: item.entryId, expectedHash: item.expectedHash }))
    .sort((a, b) => a.entryId.localeCompare(b.entryId));
  const payloadHash = createHash('sha256').update(JSON.stringify({ sub, accountId, ...change, selections: ordered })).digest('hex');
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
      if (mode === 'category' && (previous.kind === 'manual' ?
        manualEditPreview(book, sub, previous.id).input.kind : previous.splitKind) !== 'expense') {
        throw new Error('Only manual expense transactions can change budget category');
      }
      return previous;
    });
    const sent = book.db.prepare(`SELECT data FROM ${table} WHERE request_id = ?`).get(requestId);
    if (sent) {
      const saved = JSON.parse(sent.data);
      if (saved.payloadHash !== payloadHash) throw new Error('Request ID reused with different bulk update');
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
        next = buildManualEntry(book, sub, { ...input, ...change }, previous.id, previous.createdBy, revision + 1);
      } else {
        const lines = previous.postings.filter(p => p.accountId !== previous.sourceAccountId).map((p, index) => ({
          counterId: p.accountId, amountExpression: String(p.amount), categoryId: mode === 'category' ? categoryId : previous.budgetAllocations?.[index]?.categoryId ?? null }));
        next = buildSplitEntry(book, sub, { date: previous.date, kind: previous.splitKind,
          accountId: previous.sourceAccountId, memo: mode === 'memo' ? memo : previous.memo, lines }, previous.id, previous.createdBy, revision + 1);
      }
      book.db.prepare(`INSERT INTO entry_revisions (entry_id, revision, data, actor_sub, changed_at)
        VALUES (?, ?, ?, ?, ?)`).run(previous.id, revision, JSON.stringify(previous), sub, changedAt);
      book.db.prepare('UPDATE entries SET data = ? WHERE id = ?').run(JSON.stringify(next), previous.id);
    }
    book.db.prepare(`INSERT INTO ${table} (request_id, data) VALUES (?, ?)`).run(requestId,
      JSON.stringify({ payloadHash, accountId, ...change, actor: sub, changedAt, entryIds: originals.map(entry => entry.id) }));
    return { count: originals.length, duplicate: false };
  });
}
