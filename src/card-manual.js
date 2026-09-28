import { createHash } from 'node:crypto';
import { calculateAmount } from './amount-expression.js';
import { assertDate } from './ledger.js';
import { canAccessAccount } from './members.js';

const validId = id => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id);
const digest = data => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function recordCardPurchase(book, userSub, input) {
  const { requestId, date, cardId, expenseId, firstDueDate, categoryId, memo = '' } = input;
  if (!validId(requestId)) throw new Error('Valid request ID required');
  if (!canAccessAccount(book, userSub, cardId, 'write')) throw new Error('Card write access required');
  assertDate(date);
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
    categoryId: categoryId || null, memo: memo.trim() };
  const payloadHash = digest(payload);
  const previous = book.cardPlan(requestId);
  if (previous) {
    if (previous.createdBy !== userSub || previous.payloadHash !== payloadHash) {
      throw new Error('Request ID reused with different card purchase');
    }
    return { plan: previous, duplicate: true };
  }
  const plan = book.cardPurchase({ id: requestId, date, cardId, expenseId, amount,
    count, firstDueDate, categoryId: categoryId || null, memo: memo.trim(),
    createdBy: userSub, payloadHash });
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
