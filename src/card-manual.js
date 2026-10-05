import { createHash } from 'node:crypto';
import { calculateAmount } from './amount-expression.js';
import { assertDate } from './ledger.js';
import { canAccessAccount, member } from './members.js';
import { cardBillingRule, firstCardBillingDate, firstCardDueDate } from './card-billing.js';

const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function setCardCashDefault(book, sub, cardId, cashId) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  const accounts = book.accounts();
  const card = accounts.get(cardId);
  if (!card?.card || card.type !== 'liability') throw new Error('Select a card liability');
  if (!cashId) {
    book.db.prepare('DELETE FROM card_cash_defaults WHERE card_id = ?').run(cardId);
    return;
  }
  const cash = accounts.get(cashId);
  if (!cash?.cash || cash.type !== 'asset') throw new Error('Select a cash asset account');
  book.db.prepare(`INSERT INTO card_cash_defaults (card_id, cash_id) VALUES (?, ?)
    ON CONFLICT(card_id) DO UPDATE SET cash_id=excluded.cash_id`).run(cardId, cashId);
}

export function cardCashDefault(book, sub, cardId) {
  const cashId = book.db.prepare('SELECT cash_id FROM card_cash_defaults WHERE card_id = ?').get(cardId)?.cash_id;
  if (!cashId || !canAccessAccount(book, sub, cardId, 'write') ||
    !canAccessAccount(book, sub, cashId, 'write')) return null;
  const accounts = book.accounts();
  const card = accounts.get(cardId);
  const cash = accounts.get(cashId);
  return card?.card && card.type === 'liability' && cash?.cash && cash.type === 'asset' ? cashId : null;
}

export function recordCardPurchase(book, userSub, input) {
  const { requestId, date, cardId, expenseId, categoryId, memo = '' } = input;
  if (!validId(requestId)) throw new Error('Valid request ID required');
  if (!canAccessAccount(book, userSub, cardId, 'write')) throw new Error('Card write access required');
  assertDate(date);
  const previous = book.cardPlan(requestId);
  const automatic = !input.firstDueDate;
  const billingRule = automatic ? (previous?.billingRule ?? cardBillingRule(book, userSub, cardId)) : null;
  if (automatic && !billingRule) throw new Error('Set a card billing rule or enter the first payment date');
  const firstDueDate = automatic ? firstCardBillingDate(date, billingRule) : input.firstDueDate;
  if (automatic) firstCardDueDate(date, billingRule); // Also reject adjustment before the purchase date.
  assertDate(firstDueDate);
  if (firstDueDate < date) throw new Error('First payment date precedes purchase');
  if (typeof memo !== 'string' || memo.length > 500) throw new Error('Invalid memo');
  const amount = calculateAmount(input.amountExpression);
  const count = Number(input.count);
  if (!Number.isInteger(count) || count < 1 || count > 120 || amount < count) {
    throw new Error('Installments require at least one won per month');
  }
  const card = book.accounts().get(cardId);
  if (!card?.card || card.type !== 'liability') throw new Error('Select a card liability');
  if (categoryId && (!card.onBudget || !book.budgetCategories().has(categoryId))) {
    throw new Error('Invalid budget category');
  }
  const payload = { date, cardId, expenseId, amount, count, firstDueDate,
    ...(automatic ? { billingRule } : {}),
    categoryId: categoryId || null, memo: memo.trim() };
  const payloadHash = digest(payload);
  if (previous) {
    if (previous.createdBy !== userSub || previous.payloadHash !== payloadHash) {
      throw new Error('Request ID reused with different card purchase');
    }
    return { plan: previous, duplicate: true };
  }
  const plan = book.cardPurchase({ id: requestId, date, cardId, expenseId, amount,
    count, firstDueDate, categoryId: categoryId || null, memo: memo.trim(),
    createdBy: userSub, payloadHash, billingRule });
  return { plan, duplicate: false };
}

export function visibleCardSchedule(book, userSub, throughDate) {
  return book.pendingCardPayments(throughDate)
    .filter(item => canAccessAccount(book, userSub, item.cardId))
    .map(item => {
      const plan = book.cardPlan(item.planId);
      const purchase = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(plan.purchaseEntryId);
      return { ...item, memo: purchase ? JSON.parse(purchase.data).memo ?? '' : '' };
    });
}

export function recordCardPayment(book, userSub, input) {
  const { planId, index, date, cashId } = input;
  const plan = book.cardPlan(planId);
  if (!plan || !canAccessAccount(book, userSub, plan.cardId, 'write') ||
    !canAccessAccount(book, userSub, cashId, 'write')) {
    throw new Error('Card and cash account write access required');
  }
  if (!Number.isSafeInteger(index) || index < 1) throw new Error('Invalid installment index');
  return book.payInstallment({ planId, index, date, cashId });
}

export function recordCardPaymentBatch(book, userSub, { requestId, items, date, cashId }) {
  if (!validId(requestId)) throw new Error('Valid request ID required');
  if (!Array.isArray(items) || items.length < 2 || items.length > 100) throw new Error('Select two to one hundred installments');
  if (!canAccessAccount(book, userSub, cashId, 'write')) throw new Error('Cash account write access required');
  const normalized = items.map(item => {
    const plan = book.cardPlan(item?.planId);
    if (!plan || !canAccessAccount(book, userSub, plan.cardId, 'write')) throw new Error('Card write access required');
    if (!Number.isSafeInteger(item.index) || item.index < 1) throw new Error('Invalid installment index');
    return { planId: item.planId, index: item.index };
  }).sort((a, b) => a.planId.localeCompare(b.planId) || a.index - b.index);
  return book.payInstallments({ items: normalized, date, cashId, requestId, actor: userSub,
    payloadHash: digest({ items: normalized, date, cashId }) });
}
