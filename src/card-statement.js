import { assertMonth } from './ledger.js';
import { canAccessAccount } from './members.js';
import { calculateAmount } from './amount-expression.js';
import { entryFingerprint } from './transaction-checks.js';

export function cardMonthlySchedule(book, sub, cardId, month) {
  assertMonth(month);
  const card = book.accounts().get(cardId);
  if (!card?.card || card.type !== 'liability' || !canAccessAccount(book, sub, cardId)) throw new Error('Card read access required');
  const rows = []; const sources = [];
  for (const record of book.db.prepare('SELECT data FROM card_plans').all()) {
    const plan = JSON.parse(record.data);
    if (plan.cardId !== cardId || plan.cancellationId) continue;
    const installments = plan.installments.filter(item => item.amount > 0 && item.dueDate.slice(0, 7) === month);
    if (!installments.length) continue;
    const original = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(plan.purchaseEntryId);
    if (!original) throw new Error('Card purchase entry missing');
    const entry = JSON.parse(original.data);
    for (const item of installments) {
      const payment = item.paidEntryId && book.db.prepare('SELECT data FROM entries WHERE id = ?').get(item.paidEntryId);
      if (item.paidEntryId && !payment) throw new Error('Card payment entry missing');
      const paid = payment ? JSON.parse(payment.data) : null;
      rows.push({ planId: plan.id, purchaseEntryId: plan.purchaseEntryId, index: item.index, dueDate: item.dueDate,
        amount: item.amount, memo: entry.memo ?? '', paidEntryId: item.paidEntryId ?? null, paymentDate: paid?.date ?? null });
      sources.push({ planId: plan.id, index: item.index, purchaseHash: entryFingerprint(entry), paymentHash: paid ? entryFingerprint(paid) : null,
        refundedAmount: plan.refundedAmount ?? 0, lastRefundDate: plan.lastRefundDate ?? null, lastPartialDate: plan.lastPartialDate ?? null });
    }
  }
  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.planId.localeCompare(b.planId) || a.index - b.index);
  sources.sort((a, b) => a.planId.localeCompare(b.planId) || a.index - b.index);
  const sum = values => {
    const total = values.reduce((value, item) => value + item.amount, 0);
    if (!Number.isSafeInteger(total)) throw new Error('Card statement total exceeds supported range');
    return total;
  };
  return { card, month, rows, scheduledTotal: sum(rows), paidTotal: sum(rows.filter(row => row.paidEntryId)),
    pendingTotal: sum(rows.filter(row => !row.paidEntryId)),
    stateHash: entryFingerprint({ card, month, rows, sources }) };
}

export function compareCardStatement(book, sub, { cardId, month, statementExpression = '0', adjustmentExpression = '0', adjustmentReason = '' }) {
  const schedule = cardMonthlySchedule(book, sub, cardId, month);
  const statementAmount = calculateAmount(statementExpression);
  const adjustmentAmount = calculateAmount(adjustmentExpression);
  if (typeof adjustmentReason !== 'string' || adjustmentReason.trim().length > 200 || (adjustmentAmount !== 0 && !adjustmentReason.trim())) throw new Error('Adjustment reason required (up to 200 characters)');
  const expectedAmount = schedule.scheduledTotal + adjustmentAmount;
  const difference = statementAmount - expectedAmount;
  if (![expectedAmount, difference].every(Number.isSafeInteger)) throw new Error('Card comparison exceeds supported range');
  return { ...schedule, statementAmount, adjustmentAmount, adjustmentReason: adjustmentReason.trim(), expectedAmount, difference };
}

export function saveCardStatementComparison(book, sub, input) {
  const { cardId, month, requestId, expectedHash } = input;
  if (!canAccessAccount(book, sub, cardId, 'write')) throw new Error('Card write access required');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid card comparison request ID');
  return book.atomic(() => {
    const comparison = compareCardStatement(book, sub, input);
    const old = book.db.prepare('SELECT data FROM card_statement_comparisons WHERE id = ?').get(requestId);
    if (old) {
      const saved = JSON.parse(old.data);
      if (saved.actor !== sub || saved.card.id !== cardId || saved.month !== month || saved.stateHash !== expectedHash ||
        saved.statementAmount !== comparison.statementAmount || saved.adjustmentAmount !== comparison.adjustmentAmount ||
        saved.adjustmentReason !== comparison.adjustmentReason) throw new Error('Card comparison request ID reused');
      return { saved, duplicate: true };
    }
    if (comparison.stateHash !== expectedHash) throw new Error('Card schedule changed; reload before saving comparison');
    const saved = { ...comparison, id: requestId, actor: sub, savedAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO card_statement_comparisons (id, card_id, month, data) VALUES (?, ?, ?, ?)')
      .run(requestId, cardId, month, JSON.stringify(saved));
    return { saved, duplicate: false };
  });
}

export function cardStatementHistory(book, sub, cardId, month) {
  const current = cardMonthlySchedule(book, sub, cardId, month);
  return book.db.prepare('SELECT data FROM card_statement_comparisons WHERE card_id = ? AND month = ? ORDER BY rowid DESC LIMIT 20')
    .all(cardId, month).map(row => { const saved = JSON.parse(row.data); return { ...saved, changed: saved.stateHash !== current.stateHash }; });
}
