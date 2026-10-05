import { assertDate } from './ledger.js';
import { canAccessAccount, member } from './members.js';

export function validateBillingRule(rule) {
  if (!rule || !Number.isInteger(rule.closingDay) || rule.closingDay < 1 || rule.closingDay > 31 ||
    !Number.isInteger(rule.paymentDay) || rule.paymentDay < 1 || rule.paymentDay > 31 ||
    !Number.isInteger(rule.paymentMonthOffset) || rule.paymentMonthOffset < 0 || rule.paymentMonthOffset > 2) {
    throw new Error('Invalid card billing rule');
  }
  // Every purchase through the closing date must have a payment date after that date.
  if (rule.paymentMonthOffset === 0 && rule.paymentDay <= rule.closingDay) {
    throw new Error('Same-month payment must follow closing day');
  }
  return { closingDay: rule.closingDay, paymentDay: rule.paymentDay, paymentMonthOffset: rule.paymentMonthOffset };
}

function monthDate(year, month, offset, day) {
  const index = (year - 1) * 12 + month - 1 + offset;
  if (index < 0 || index >= 9999 * 12) throw new Error('Card schedule exceeds supported dates');
  const y = Math.floor(index / 12) + 1; const m = index % 12 + 1;
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const last = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export function firstCardDueDate(date, input) {
  assertDate(date);
  const rule = validateBillingRule(input);
  const [year, month] = date.split('-').map(Number);
  const closing = monthDate(year, month, 0, rule.closingDay);
  return monthDate(year, month, (date > closing ? 1 : 0) + rule.paymentMonthOffset, rule.paymentDay);
}

export function cardBillingDates(firstDueDate, count, input) {
  assertDate(firstDueDate);
  const rule = validateBillingRule(input);
  if (!Number.isInteger(count) || count < 1 || count > 120) throw new Error('Invalid installment count');
  const [year, month] = firstDueDate.split('-').map(Number);
  return Array.from({ length: count }, (_, offset) => monthDate(year, month, offset, rule.paymentDay));
}

export function cardBillingRule(book, sub, cardId) {
  if (!canAccessAccount(book, sub, cardId)) throw new Error('Card read access required');
  const row = book.db.prepare('SELECT data FROM card_billing_rules WHERE card_id = ?').get(cardId);
  return row ? JSON.parse(row.data) : null;
}

export function setCardBillingRule(book, sub, cardId, input) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
  const card = book.accounts().get(cardId);
  if (!card?.card || card.type !== 'liability') throw new Error('Select a card liability');
  if (input === null) {
    book.db.prepare('DELETE FROM card_billing_rules WHERE card_id = ?').run(cardId);
    return;
  }
  const rule = validateBillingRule(input);
  book.db.prepare(`INSERT INTO card_billing_rules (card_id, data) VALUES (?, ?)
    ON CONFLICT(card_id) DO UPDATE SET data=excluded.data`).run(cardId, JSON.stringify(rule));
}
