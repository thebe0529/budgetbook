import { assertDate } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { canAccessAccount, member } from './members.js';
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
  const receiptLimit = refund.creditAmount ?? refund.amount;
  return { refund, plan, allowed, received, receiptLimit, remaining: receiptLimit - received,
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
      if (audit.mode === 'linked' || audit.refundId !== refundId || audit.cashId !== cashId || audit.actor !== sub || audit.date !== date ||
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

function receiptEntry(book, sub, plan, entry) {
  if (!entry || !['manual', 'manual-split', 'import', 'adjustment'].includes(entry.kind) ||
    (entry.createdBy !== sub && member(book, sub)?.role !== 'owner') ||
    entry.budgetAllocations?.length || entry.postings.length !== 2) return null;
  const cash = entry.postings.find(p => p.side === 'debit' && book.accounts().get(p.accountId)?.type === 'asset' &&
    book.accounts().get(p.accountId)?.cash);
  const card = entry.postings.find(p => p.side === 'credit' && p.accountId === plan.cardId);
  if (!cash || !card || !Number.isSafeInteger(cash.amount) || cash.amount <= 0 || cash.amount !== card.amount ||
    !canAccessAccount(book, sub, cash.accountId, 'write')) return null;
  return { cashId: cash.accountId, amount: cash.amount };
}

function unavailableEntry(book, entryId) {
  return book.db.prepare('SELECT 1 FROM card_refund_receipts WHERE entry_id = ?').get(entryId) ||
    book.db.prepare('SELECT 1 FROM transaction_reversals WHERE original_id = ? OR reversal_id = ?').get(entryId, entryId) ||
    book.db.prepare(`SELECT 1 FROM adjustment_batches b JOIN adjustment_reversals r ON r.original_id = b.id
      JOIN json_each(b.data, '$.entryIds') e WHERE e.value = ?`).get(entryId);
}

export function cardRefundReceiptCandidates(book, sub, refundId) {
  const preview = cardRefundReceiptPreview(book, sub, refundId);
  if (!preview.allowed || preview.remaining <= 0) return [];
  return book.entries().filter(entry => {
    const match = receiptEntry(book, sub, preview.plan, entry);
    return match && entry.date >= preview.minimumDate && match.amount <= preview.remaining && !unavailableEntry(book, entry.id);
  }).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id)).slice(0, 200)
    .map(entry => ({ entry, ...receiptEntry(book, sub, preview.plan, entry), expectedEntryHash: entryFingerprint(entry) }));
}

export function linkCardRefundReceipt(book, sub, { refundId, entryId, reason, requestId, expectedHash, expectedEntryHash }) {
  if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 200) throw new Error('Receipt reason required (up to 200 characters)');
  reason = reason.trim();
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid receipt request ID');
  return book.atomic(() => {
    const preview = cardRefundReceiptPreview(book, sub, refundId);
    const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
    const entry = row && JSON.parse(row.data);
    const match = receiptEntry(book, sub, preview.plan, entry);
    if (!preview.allowed || !match) throw new Error('Existing receipt requires matching cash debit/card credit and author or owner write access');
    if (book.db.prepare('SELECT 1 FROM card_refunds WHERE id = ?').get(requestId) ||
      book.db.prepare('SELECT 1 FROM card_partial_cancellations WHERE id = ?').get(requestId) ||
      book.db.prepare('SELECT 1 FROM transaction_reversals WHERE request_id = ?').get(requestId)) throw new Error('Receipt request ID reused');
    const sent = book.db.prepare('SELECT data FROM card_refund_receipts WHERE id = ?').get(requestId);
    if (sent) {
      const audit = JSON.parse(sent.data);
      if (audit.mode !== 'linked' || audit.refundId !== refundId || audit.entryId !== entryId || audit.reason !== reason ||
        audit.actor !== sub || audit.expectedHash !== expectedHash || audit.expectedEntryHash !== expectedEntryHash) throw new Error('Receipt request ID reused');
      return { entry, duplicate: true };
    }
    if (expectedHash !== preview.expectedHash || expectedEntryHash !== entryFingerprint(entry)) throw new Error('Refund or existing entry changed; reload before linking');
    if (unavailableEntry(book, entryId)) throw new Error('Existing entry already linked or reversed');
    if (entry.date < preview.minimumDate) throw new Error('Receipt date precedes refund or previous receipt');
    if (match.amount > preview.remaining) throw new Error('Receipt exceeds remaining refund amount');
    const audit = { requestId, refundId, planId: preview.plan.id, entryId, ...match, cardId: preview.plan.cardId,
      date: entry.date, reason, expectedHash, expectedEntryHash, mode: 'linked', actor: sub,
      createdAt: new Date().toISOString(), remainingAfter: preview.remaining - match.amount };
    book.db.prepare('INSERT INTO card_refund_receipts (id, refund_id, entry_id, date, data) VALUES (?, ?, ?, ?, ?)')
      .run(requestId, refundId, entryId, entry.date, JSON.stringify(audit));
    return { entry, duplicate: false };
  });
}
