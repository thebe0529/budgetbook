import { assertDate } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { cardCancellationPreview } from './card-cancellation.js';
import { normalizeRefundDistribution, distributeCardRefund } from './card-refund-allocation.js';

// Read-only calculation; saving must revalidate the original state and permissions.
export function cardReductionPreview(book, sub, kind, input) {
  if (!['partial', 'refund'].includes(kind)) throw new Error('Invalid card reduction preview');
  const { planId, date, expectedHash, requestId } = input;
  assertDate(date);
  if (typeof input.reason !== 'string' || !input.reason.trim() || input.reason.trim().length > 200) throw new Error('Reason required (up to 200 characters)');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid card reduction request ID');
  const amount = calculateAmount(input.amountExpression);
  if (amount <= 0) throw new Error('Reduction amount must be positive');
  const distribution = normalizeRefundDistribution(input.distributionMode, input.deductions);
  const preview = cardCancellationPreview(book, sub, planId);
  const { plan, entry, allowed, hasPayments, remainingAmount, unpaidAmount } = preview;
  if (!allowed) throw new Error('Card reduction requires author or owner and write access');
  if (preview.cancellation || plan.cancellationId) throw new Error('Card purchase already cancelled');
  if (expectedHash !== preview.expectedHash) throw new Error('Card purchase changed; reload before previewing');
  if (kind === 'partial' && hasPayments) throw new Error('Paid card purchase requires a refund workflow');
  if (kind === 'refund' && !hasPayments) throw new Error('Refund requires a paid purchase; use unpaid cancellation');
  const minimumDate = kind === 'refund' ? preview.minimumRefundDate : [entry.date, plan.lastPartialDate].filter(Boolean).sort().at(-1);
  if (date < minimumDate) throw new Error('Reduction date precedes purchase, payment or latest reduction');
  if (kind === 'partial' ? amount >= remainingAmount : amount > remainingAmount) throw new Error('Reduction exceeds limit; use full cancellation for unpaid purchases');
  const locks = book.db.prepare('SELECT account_id, through_date FROM account_period_locks').all();
  if (locks.some(lock => lock.through_date >= date && entry.postings.some(p => p.accountId === lock.account_id))) throw new Error('Account period is locked');
  if (book.db.prepare('SELECT 1 FROM card_refunds WHERE id = ?').get(requestId) ||
    book.db.prepare('SELECT 1 FROM card_partial_cancellations WHERE id = ?').get(requestId) ||
    book.db.prepare('SELECT 1 FROM card_refund_receipts WHERE id = ?').get(requestId) ||
    book.db.prepare('SELECT 1 FROM transaction_reversals WHERE request_id = ?').get(requestId)) throw new Error('Reduction request ID already used; reload purchase details');
  const unpaidReduction = kind === 'partial' ? amount : Math.min(amount, unpaidAmount);
  const creditAmount = kind === 'partial' ? 0 : amount - unpaidReduction;
  const afterInstallments = distributeCardRefund(plan.installments, unpaidReduction, distribution);
  return { plan, entry, kind, amount, unpaidReduction, creditAmount, beforeInstallments: plan.installments, afterInstallments,
    remainingAfter: remainingAmount - amount,
    input: { planId, date, requestId, expectedHash, reason: input.reason.trim(), amountExpression: String(amount),
      distributionMode: distribution.distributionMode,
      ...(distribution.distributionMode === 'manual' ? { deductions: distribution.deductions.map(item => ({ index: item.index, amountExpression: String(item.amount) })) } : {}) } };
}
