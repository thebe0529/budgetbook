import { member, canAccessAccount } from './members.js';
import { compareStatement } from './statement-comparison.js';

function assertOwner(book, sub, requestId) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('Invalid lock request ID');
  }
}

export function accountPeriodLock(book, sub, accountId) {
  if (!canAccessAccount(book, sub, accountId)) throw new Error('Account read access required');
  const row = book.db.prepare('SELECT data FROM account_period_locks WHERE account_id = ?').get(accountId);
  return row ? JSON.parse(row.data) : null;
}

export function lockAccountPeriod(book, sub, comparisonId, requestId) {
  assertOwner(book, sub, requestId);
  return book.atomic(() => {
    const existing = book.db.prepare('SELECT data FROM account_lock_events WHERE id = ?').get(requestId);
    if (existing) {
      const event = JSON.parse(existing.data);
      if (event.action !== 'lock' || event.actor !== sub || event.lock.comparisonId !== comparisonId) throw new Error('Lock request ID reused');
      return { lock: event.lock, duplicate: true };
    }
    const row = book.db.prepare('SELECT data FROM statement_comparisons WHERE id = ?').get(comparisonId);
    if (!row) throw new Error('Comparison not found');
    const saved = JSON.parse(row.data);
    if (!book.db.prepare('SELECT 1 FROM statement_reviews WHERE comparison_id = ?').get(comparisonId)) throw new Error('Completed review required');
    const current = compareStatement(book, sub, saved.account.id, saved.throughDate, String(saved.statementBalance));
    if (current.stateHash !== saved.stateHash || current.difference !== 0 || current.uncheckedCount !== 0) {
      throw new Error('Comparison changed; complete a new review before locking');
    }
    const previous = accountPeriodLock(book, sub, saved.account.id);
    if (previous && previous.throughDate >= saved.throughDate) throw new Error('A later lock cutoff is required');
    const lock = { id: requestId, accountId: saved.account.id, throughDate: saved.throughDate,
      comparisonId, actor: sub, createdAt: new Date().toISOString() };
    book.db.prepare(`INSERT INTO account_period_locks (account_id, through_date, data) VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET through_date=excluded.through_date, data=excluded.data`)
      .run(lock.accountId, lock.throughDate, JSON.stringify(lock));
    const event = { action: 'lock', actor: sub, lock, previous, createdAt: lock.createdAt };
    book.db.prepare('INSERT INTO account_lock_events (id, account_id, data) VALUES (?, ?, ?)').run(requestId, lock.accountId, JSON.stringify(event));
    return { lock, duplicate: false };
  });
}

export function unlockAccountPeriod(book, sub, { accountId, expectedLockId, reason, requestId }) {
  assertOwner(book, sub, requestId);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) throw new Error('Unlock reason required (up to 500 characters)');
  reason = reason.trim();
  return book.atomic(() => {
    const existing = book.db.prepare('SELECT data FROM account_lock_events WHERE id = ?').get(requestId);
    if (existing) {
      const event = JSON.parse(existing.data);
      if (event.action !== 'unlock' || event.actor !== sub || event.lock.accountId !== accountId ||
          event.lock.id !== expectedLockId || event.reason !== reason) throw new Error('Lock request ID reused');
      return { lock: event.lock, duplicate: true };
    }
    const lock = accountPeriodLock(book, sub, accountId);
    if (!lock || lock.id !== expectedLockId) throw new Error('Lock changed; reload before unlocking');
    book.db.prepare('DELETE FROM account_period_locks WHERE account_id = ?').run(accountId);
    const event = { action: 'unlock', actor: sub, lock, reason, createdAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO account_lock_events (id, account_id, data) VALUES (?, ?, ?)').run(requestId, accountId, JSON.stringify(event));
    return { lock, duplicate: false };
  });
}

export function accountLockHistory(book, sub, accountId) {
  if (!canAccessAccount(book, sub, accountId)) throw new Error('Account read access required');
  return book.db.prepare('SELECT data FROM account_lock_events WHERE account_id = ? ORDER BY rowid DESC LIMIT 20')
    .all(accountId).map(row => JSON.parse(row.data));
}
