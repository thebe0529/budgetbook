import { canAccessAccount, member } from './members.js';
import { assertDate } from './ledger.js';
import { entryFingerprint } from './transaction-checks.js';
import { calculateAmount } from './amount-expression.js';

export function cardCancellationPreview(book, sub, planId) {
  const plan = book.cardPlan(planId);
  const row = plan && book.db.prepare('SELECT data FROM entries WHERE id = ?').get(plan.purchaseEntryId);
  const entry = row && JSON.parse(row.data);
  const accounts = book.accounts();
  if (!entry || !accounts.get(plan.cardId)?.card || !canAccessAccount(book, sub, plan.cardId) ||
    entry.postings.some(p => ['asset', 'liability'].includes(accounts.get(p.accountId)?.type) &&
      !canAccessAccount(book, sub, p.accountId))) throw new Error('Card purchase read access required');
  const allowed = (plan.createdBy === sub || member(book, sub)?.role === 'owner') &&
    entry.postings.every(p => !['asset', 'liability'].includes(accounts.get(p.accountId)?.type) ||
      canAccessAccount(book, sub, p.accountId, 'write'));
  const saved = book.db.prepare('SELECT data FROM transaction_reversals WHERE original_id = ?').get(entry.id);
  const partials = book.db.prepare('SELECT data FROM card_partial_cancellations WHERE plan_id = ? ORDER BY rowid').all(planId)
    .map(row => JSON.parse(row.data));
  return { plan, entry, allowed, hasPayments: plan.installments.some(item => item.paidEntryId),
    partials, remainingAmount: plan.cancellationId ? 0 : plan.installments.reduce((sum, item) => sum + item.amount, 0),
    expectedHash: entryFingerprint({ plan, entry }), cancellation: saved ? JSON.parse(saved.data) : null };
}

export function visibleCardPurchases(book, sub) {
  const rows = book.db.prepare('SELECT id FROM card_plans ORDER BY rowid DESC').all();
  const result = [];
  for (const row of rows) {
    const plan = book.cardPlan(row.id);
    if (!canAccessAccount(book, sub, plan.cardId)) continue;
    const preview = cardCancellationPreview(book, sub, row.id);
    result.push(preview);
    if (result.length === 200) break;
  }
  return result;
}

export function cancelCardPurchase(book, sub, { planId, date, reason, expectedHash, requestId }) {
  assertDate(date);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new Error('Cancellation reason required (up to 200 characters)');
  reason = reason.trim();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid cancellation request ID');
  return book.atomic(() => {
    const { plan, entry: original, allowed, hasPayments, cancellation, expectedHash: currentHash } = cardCancellationPreview(book, sub, planId);
    if (!allowed) throw new Error('Card purchase cancellation requires author or owner and write access');
    if (book.db.prepare('SELECT 1 FROM card_partial_cancellations WHERE id = ?').get(requestId)) throw new Error('Cancellation request ID reused');
    const sent = book.db.prepare('SELECT data FROM transaction_reversals WHERE request_id = ?').get(requestId);
    if (sent) {
      const audit = JSON.parse(sent.data);
      if (audit.planId !== planId || audit.actor !== sub || audit.date !== date || audit.reason !== reason || audit.expectedHash !== expectedHash) {
        throw new Error('Cancellation request ID reused');
      }
      return { entry: JSON.parse(book.db.prepare('SELECT data FROM entries WHERE id = ?').get(audit.reversalId).data), duplicate: true };
    }
    if (cancellation || plan.cancellationId) throw new Error('Card purchase already cancelled');
    if (hasPayments) throw new Error('Paid card purchase requires a refund workflow');
    if (expectedHash !== currentHash) throw new Error('Card purchase changed; reload before cancelling');
    if (date < original.date) throw new Error('Cancellation date precedes purchase');
    if (plan.lastPartialDate && date < plan.lastPartialDate) throw new Error('Cancellation date precedes latest partial cancellation');
    const amount = plan.installments.reduce((sum, item) => sum + item.amount, 0);
    const entry = { id: `card-cancellation:${requestId}`, date, kind: 'card-cancellation',
      createdBy: sub, sourceAccountId: plan.cardId, reversesEntryId: original.id,
      memo: `카드 구매 취소 (${reason}): ${original.memo || original.id}`,
      postings: original.postings.map(p => ({ ...p, amount, side: p.side === 'debit' ? 'credit' : 'debit' })),
      ...(original.budgetAllocations ? { budgetAllocations: original.budgetAllocations.map(a => ({ ...a, amount: -amount })) } : {}) };
    book.record(entry);
    const link = book.db.prepare('SELECT * FROM cash_schedule_links WHERE entry_id = ?').get(original.id);
    const audit = { originalId: original.id, reversalId: entry.id, planId, requestId, expectedHash, date, reason, amount,
      actor: sub, createdAt: new Date().toISOString(), detachedScheduleLink: link ? { ...link } : null };
    book.db.prepare('INSERT INTO transaction_reversals (original_id, reversal_id, request_id, data) VALUES (?, ?, ?, ?)')
      .run(original.id, entry.id, requestId, JSON.stringify(audit));
    book.db.prepare('UPDATE card_plans SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...plan, cancellationId: entry.id }), planId);
    if (link) book.db.prepare('DELETE FROM cash_schedule_links WHERE entry_id = ?').run(original.id);
    return { entry, duplicate: false };
  });
}

export function partiallyCancelCardPurchase(book, sub, { planId, date, reason, expectedHash, requestId, amountExpression }) {
  assertDate(date);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new Error('Cancellation reason required (up to 200 characters)');
  reason = reason.trim();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid cancellation request ID');
  const amount = calculateAmount(amountExpression);
  if (amount <= 0) throw new Error('Partial cancellation amount must be positive');
  return book.atomic(() => {
    const preview = cardCancellationPreview(book, sub, planId);
    const { plan, entry: original, allowed, hasPayments, remainingAmount, cancellation } = preview;
    if (!allowed) throw new Error('Card purchase cancellation requires author or owner and write access');
    if (book.db.prepare('SELECT 1 FROM transaction_reversals WHERE request_id = ?').get(requestId)) throw new Error('Cancellation request ID reused');
    const sent = book.db.prepare('SELECT data FROM card_partial_cancellations WHERE id = ?').get(requestId);
    if (sent) {
      const audit = JSON.parse(sent.data);
      if (audit.planId !== planId || audit.actor !== sub || audit.date !== date || audit.reason !== reason || audit.amount !== amount || audit.expectedHash !== expectedHash) throw new Error('Cancellation request ID reused');
      return { entry: JSON.parse(book.db.prepare('SELECT data FROM entries WHERE id = ?').get(audit.entryId).data), duplicate: true };
    }
    if (cancellation || plan.cancellationId) throw new Error('Card purchase already cancelled');
    if (hasPayments) throw new Error('Paid card purchase requires a refund workflow');
    if (expectedHash !== preview.expectedHash) throw new Error('Card purchase changed; reload before cancelling');
    if (date < original.date || (plan.lastPartialDate && date < plan.lastPartialDate)) throw new Error('Cancellation date precedes purchase or latest partial cancellation');
    if (amount >= remainingAmount) throw new Error('Partial amount must be below remaining purchase amount; use full cancellation');
    const entry = { id: `card-partial-cancellation:${requestId}`, date, kind: 'card-partial-cancellation', createdBy: sub,
      sourceAccountId: plan.cardId, reversesEntryId: original.id, memo: `카드 부분취소 (${reason}): ${original.memo || original.id}`,
      postings: original.postings.map(p => ({ ...p, amount, side: p.side === 'debit' ? 'credit' : 'debit' })),
      ...(original.budgetAllocations ? { budgetAllocations: original.budgetAllocations.map(a => ({ ...a, amount: -amount })) } : {}) };
    const remaining = remainingAmount - amount; const count = plan.installments.length;
    const installments = plan.installments.map((item, i) => ({ ...item, amount: Math.floor(remaining / count) + (i < remaining % count ? 1 : 0) }));
    book.record(entry);
    const audit = { requestId, planId, originalId: original.id, entryId: entry.id, date, amount, reason, expectedHash,
      actor: sub, createdAt: new Date().toISOString(), beforeInstallments: plan.installments, afterInstallments: installments };
    book.db.prepare('INSERT INTO card_partial_cancellations (id, plan_id, original_id, entry_id, date, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(requestId, planId, original.id, entry.id, date, JSON.stringify(audit));
    book.db.prepare('UPDATE card_plans SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...plan, installments, lastPartialDate: date }), planId);
    return { entry, duplicate: false };
  });
}
