import { assertDate } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { canAccessAccount } from './members.js';
import { cardCancellationPreview } from './card-cancellation.js';
import { entryFingerprint } from './transaction-checks.js';

export function cardRefundReceiptPreview(book, sub, refundId) {
  const row = book.db.prepare('SELECT data FROM card_refunds WHERE id = ?').get(refundId);
  if (!row) throw new Error('Card refund not found');
  const refund = JSON.parse(row.data);
  const { plan, allowed } = cardCancellationPreview(book, sub, refund.planId);
  if (refund.method !== 'card-credit') throw new Error('Card credit refund required');
  const receipts = book.db.prepare('SELECT data FROM card_refund_receipts WHERE refund_id = ? ORDER BY rowid')
    .all(refundId).map(row => JSON.parse(row.data));
  const received = receipts.reduce((sum, receipt) => sum + receipt.amount, 0);
  return { refund, plan, allowed, received, remaining: refund.amount - received,
    minimumDate: [refund.date, ...receipts.map(receipt => receipt.date)].sort().at(-1),
    expectedHash: entryFingerprint({ refund, receipts }),
    receipts: receipts.map(receipt => canAccessAccount(book, sub, receipt.cashId) ? receipt :
      { restricted: true, amount: receipt.amount, date: receipt.date }) };
}

export function recordCardRefundReceipt(book, sub, { refundId, cashId, date, reason, amountExpression, requestId, expectedHash }) {
  assertDate(date);
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new Error('Receipt reason required (up to 200 characters)');
  reason = reason.trim();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid receipt request ID');
  const amount = calculateAmount(amountExpression);
  if (amount <= 0) throw new Error('Receipt amount must be positive');
  return book.atomic(() => {
    const { refund, plan, allowed, remaining, minimumDate, expectedHash: currentHash } = cardRefundReceiptPreview(book, sub, refundId);
    const cash = book.accounts().get(cashId);
    if (!allowed || !canAccessAccount(book, sub, cashId, 'write')) throw new Error('Receipt requires author or owner and card and cash write access');
    if (cash?.type !== 'asset' || !cash.cash) throw new Error('Select a cash asset account');
    if (book.db.prepare('SELECT 1 FROM card_refunds WHERE id = ?').get(requestId) ||
      book.db.prepare('SELECT 1 FROM card_partial_cancellations WHERE id = ?').get(requestId) ||
      book.db.prepare('SELECT 1 FROM transaction_reversals WHERE request_id = ?').get(requestId)) throw new Error('Receipt request ID reused');
    const sent = book.db.prepare('SELECT data FROM card_refund_receipts WHERE id = ?').get(requestId);
    if (sent) {
      const audit = JSON.parse(sent.data);
      if (audit.refundId !== refundId || audit.cashId !== cashId || audit.actor !== sub || audit.date !== date ||
        audit.reason !== reason || audit.amount !== amount || audit.expectedHash !== expectedHash) throw new Error('Receipt request ID reused');
      return { entry: JSON.parse(book.db.prepare('SELECT data FROM entries WHERE id = ?').get(audit.entryId).data), duplicate: true };
    }
    if (expectedHash !== currentHash) throw new Error('Refund receipt state changed; reload before receiving');
    if (date < minimumDate) throw new Error('Receipt date precedes refund or previous receipt');
    if (amount > remaining) throw new Error('Receipt exceeds remaining refund amount');
    const entry = { id: `card-refund-receipt:${requestId}`, date, kind: 'card-refund-receipt', createdBy: sub,
      sourceAccountId: cashId, memo: `카드 환불금 계좌 입금 (${reason}): ${refund.reason}`, refundId,
      postings: [{ accountId: cashId, side: 'debit', amount }, { accountId: plan.cardId, side: 'credit', amount }] };
    book.record(entry);
    const audit = { requestId, refundId, planId: plan.id, entryId: entry.id, cashId, cardId: plan.cardId,
      date, amount, reason, expectedHash, actor: sub, createdAt: new Date().toISOString(), remainingAfter: remaining - amount };
    book.db.prepare('INSERT INTO card_refund_receipts (id, refund_id, entry_id, date, data) VALUES (?, ?, ?, ?, ?)')
      .run(requestId, refundId, entry.id, date, JSON.stringify(audit));
    return { entry, duplicate: false };
  });
}
