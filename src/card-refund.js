import { assertDate } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { cardCancellationPreview } from './card-cancellation.js';

// Card credit only: an actual bank reimbursement is a separate cash transaction.
export function refundPaidCardPurchase(book, sub, { planId, date, reason, expectedHash, requestId, amountExpression }) {
  assertDate(date);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new Error('Refund reason required (up to 200 characters)');
  reason = reason.trim();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid refund request ID');
  const amount = calculateAmount(amountExpression);
  if (amount <= 0) throw new Error('Refund amount must be positive');
  return book.atomic(() => {
    const preview = cardCancellationPreview(book, sub, planId);
    const { plan, entry: original, allowed, fullyPaid, payments, remainingAmount, minimumRefundDate } = preview;
    if (!allowed) throw new Error('Card refund requires author or owner and write access');
    if (book.db.prepare('SELECT 1 FROM transaction_reversals WHERE request_id = ?').get(requestId) ||
      book.db.prepare('SELECT 1 FROM card_partial_cancellations WHERE id = ?').get(requestId)) throw new Error('Refund request ID reused');
    const sent = book.db.prepare('SELECT data FROM card_refunds WHERE id = ?').get(requestId);
    if (sent) {
      const audit = JSON.parse(sent.data);
      if (audit.planId !== planId || audit.actor !== sub || audit.date !== date || audit.reason !== reason || audit.amount !== amount || audit.expectedHash !== expectedHash) throw new Error('Refund request ID reused');
      return { entry: JSON.parse(book.db.prepare('SELECT data FROM entries WHERE id = ?').get(audit.entryId).data), duplicate: true };
    }
    if (plan.cancellationId || !fullyPaid) throw new Error('Refund requires a fully paid purchase');
    if (expectedHash !== preview.expectedHash) throw new Error('Card purchase changed; reload before refunding');
    if (date < minimumRefundDate) throw new Error('Refund date precedes purchase, payment or previous refund');
    if (amount > remainingAmount) throw new Error('Refund exceeds remaining purchase amount');
    const entry = { id: `card-refund:${requestId}`, date, kind: 'card-refund', createdBy: sub,
      sourceAccountId: plan.cardId, reversesEntryId: original.id, memo: `카드대금 차감 환불 (${reason}): ${original.memo || original.id}`,
      postings: original.postings.map(p => ({ ...p, amount, side: p.side === 'debit' ? 'credit' : 'debit' })),
      ...(original.budgetAllocations ? { budgetAllocations: original.budgetAllocations.map(a => ({ ...a, amount: -amount })) } : {}) };
    const refundedAmount = (plan.refundedAmount ?? 0) + amount;
    book.record(entry);
    const audit = { requestId, planId, originalId: original.id, entryId: entry.id, date, amount, reason, expectedHash,
      actor: sub, createdAt: new Date().toISOString(), method: 'card-credit', paymentEntryIds: payments.map(p => p.id),
      refundedBefore: plan.refundedAmount ?? 0, refundedAfter: refundedAmount, remainingAfter: remainingAmount - amount };
    book.db.prepare('INSERT INTO card_refunds (id, plan_id, original_id, entry_id, date, data) VALUES (?, ?, ?, ?, ?, ?)')
      .run(requestId, planId, original.id, entry.id, date, JSON.stringify(audit));
    book.db.prepare('UPDATE card_plans SET data = ? WHERE id = ?')
      .run(JSON.stringify({ ...plan, refundedAmount, lastRefundDate: date }), planId);
    return { entry, duplicate: false };
  });
}
