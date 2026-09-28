import { assertDate } from './ledger.js';
import { canAccessAccount } from './members.js';

export function listReviewEvents(book, userSub) {
  return book.db.prepare("SELECT data FROM import_events WHERE channel_id LIKE 'push:%' ORDER BY rowid DESC")
    .all().map(row => JSON.parse(row.data))
    .filter(event => canAccessAccount(book, userSub, event.accountId));
}

export function reviewEvent(book, userSub, eventId) {
  const row = book.db.prepare('SELECT data FROM import_events WHERE id = ?').get(eventId);
  const event = row && JSON.parse(row.data);
  return event?.channelId?.startsWith('push:') && canAccessAccount(book, userSub, event.accountId) ?
    event : null;
}

export function approveEvent(book, userSub, { eventId, kind, counterAccountId,
  categoryId, amount, date, payee }) {
  return book.atomic(() => {
    const event = reviewEvent(book, userSub, eventId);
    if (!event || !canAccessAccount(book, userSub, event.accountId, 'write')) {
      throw new Error('Event not found or write access denied');
    }
    if (event.status === 'approved') return { entryId: event.approvedEntryId, duplicate: true };
    if (!['expense', 'income'].includes(kind) || !Number.isSafeInteger(amount) || amount <= 0) {
      throw new Error('Invalid type or amount');
    }
    assertDate(date);
    const accounts = book.accounts();
    const primary = accounts.get(event.accountId);
    const counter = accounts.get(counterAccountId);
    if (!counter || counter.type !== kind || !['asset', 'liability'].includes(primary.type)) {
      throw new Error('Invalid counter account');
    }
    if (kind === 'income' && primary.type !== 'asset') {
      throw new Error('Income must enter an asset account');
    }
    if (categoryId && (kind !== 'expense' || !primary.onBudget ||
      !book.budgetCategories().has(categoryId))) throw new Error('Invalid budget category');
    const accountSide = kind === 'expense' ?
      (primary.type === 'asset' ? 'credit' : 'credit') : 'debit';
    const entry = { id: `import:${event.id}`, date, kind: 'import',
      memo: payee?.trim() || event.rawText.slice(0, 200), sourceEventId: event.id,
      postings: [{ accountId: counterAccountId,
        side: kind === 'expense' ? 'debit' : 'credit', amount },
      { accountId: event.accountId, side: accountSide, amount }],
      ...(categoryId ? { budgetAllocations: [{ categoryId, amount }] } : {}) };
    book.record(entry);
    event.status = 'approved';
    event.approvedEntryId = entry.id;
    event.approvedBy = userSub;
    event.approvedAt = new Date().toISOString();
    event.finalValues = { kind, amount, date, counterAccountId,
      ...(categoryId ? { categoryId } : {}), payee: payee ?? '' };
    book.db.prepare('UPDATE import_events SET data = ? WHERE id = ?')
      .run(JSON.stringify(event), event.id);
    return { entryId: entry.id, duplicate: false };
  });
}
