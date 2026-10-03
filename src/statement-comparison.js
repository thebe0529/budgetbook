import { accountRegister } from './manual.js';
import { calculateAmount } from './amount-expression.js';
import { createHash } from 'node:crypto';
import { canAccessAccount } from './members.js';
import { assertDate } from './ledger.js';

export function compareStatement(book, sub, accountId, throughDate, statementExpression) {
  const register = accountRegister(book, sub, accountId, throughDate);
  if (!['asset', 'liability'].includes(register.account.type)) throw new Error('Asset or liability account required');
  const statementBalance = calculateAmount(statementExpression);
  const difference = statementBalance - register.balance;
  const uncheckedMovement = register.balance - register.checkedBalance;
  if (![register.balance, register.checkedBalance, difference, uncheckedMovement].every(Number.isSafeInteger)) {
    throw new Error('Comparison exceeds supported range');
  }
  return { account: register.account, throughDate, statementBalance, ledgerBalance: register.balance,
    difference, checkedBalance: register.checkedBalance, uncheckedMovement,
    uncheckedCount: register.uncheckedCount, transactionCount: register.rows.length,
    stateHash: createHash('sha256').update(JSON.stringify({ account: register.account, throughDate,
      entries: book.entries().filter(entry => entry.date <= throughDate && entry.postings.some(p => p.accountId === accountId)),
      checks: register.rows.map(row => ({ id: row.id, checked: row.checked })) })).digest('hex') };
}

export function saveStatementComparison(book, sub, input) {
  const { accountId, throughDate, statementExpression, expectedHash, requestId } = input;
  if (!canAccessAccount(book, sub, accountId, 'write')) throw new Error('Account write access required');
  assertDate(throughDate);
  const statementBalance = calculateAmount(statementExpression);
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) {
    throw new Error('Invalid comparison request ID');
  }
  return book.atomic(() => {
    const existing = book.db.prepare('SELECT data FROM statement_comparisons WHERE id = ?').get(requestId);
    if (existing) {
      const saved = JSON.parse(existing.data);
      if (saved.actor !== sub || saved.account.id !== accountId || saved.throughDate !== throughDate ||
          saved.statementBalance !== statementBalance || saved.stateHash !== expectedHash) throw new Error('Comparison request ID reused');
      return { saved, duplicate: true };
    }
    const comparison = compareStatement(book, sub, accountId, throughDate, statementExpression);
    if (comparison.stateHash !== expectedHash) throw new Error('Comparison changed; reload before saving');
    const saved = { ...comparison, id: requestId, actor: sub, savedAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO statement_comparisons (id, account_id, saved_at, data) VALUES (?, ?, ?, ?)')
      .run(requestId, accountId, saved.savedAt, JSON.stringify(saved));
    return { saved, duplicate: false };
  });
}

export function statementComparisonHistory(book, sub, accountId) {
  if (!canAccessAccount(book, sub, accountId)) throw new Error('Account read access required');
  const states = new Map();
  return book.db.prepare(`SELECT comparisons.data, reviews.actor AS review_actor, reviews.completed_at
    FROM statement_comparisons AS comparisons LEFT JOIN statement_reviews AS reviews ON reviews.comparison_id = comparisons.id
    WHERE comparisons.account_id = ? ORDER BY comparisons.saved_at DESC, comparisons.id DESC LIMIT 20`)
    .all(accountId).map(row => {
      const saved = JSON.parse(row.data);
      if (!states.has(saved.throughDate)) {
        states.set(saved.throughDate, compareStatement(book, sub, accountId, saved.throughDate, '0').stateHash);
      }
      return { ...saved, changed: saved.stateHash !== states.get(saved.throughDate),
        review: row.completed_at ? { actor: row.review_actor, completedAt: row.completed_at } : null };
    });
}

export function completeStatementReview(book, sub, comparisonId) {
  return book.atomic(() => {
    const row = book.db.prepare('SELECT data FROM statement_comparisons WHERE id = ?').get(comparisonId);
    if (!row) throw new Error('Comparison not found');
    const saved = JSON.parse(row.data);
    if (!canAccessAccount(book, sub, saved.account.id, 'write')) throw new Error('Account write access required');
    const current = compareStatement(book, sub, saved.account.id, saved.throughDate, String(saved.statementBalance));
    if (current.stateHash !== saved.stateHash) throw new Error('Comparison changed; save a new comparison before completing');
    if (current.difference !== 0 || current.uncheckedCount !== 0) throw new Error('Matching balance and all transactions confirmed are required');
    const existing = book.db.prepare('SELECT actor, completed_at AS completedAt FROM statement_reviews WHERE comparison_id = ?').get(comparisonId);
    if (existing) return { comparison: saved, review: { ...existing }, duplicate: true };
    const review = { actor: sub, completedAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO statement_reviews (comparison_id, actor, completed_at) VALUES (?, ?, ?)')
      .run(comparisonId, sub, review.completedAt);
    return { comparison: saved, review, duplicate: false };
  });
}
