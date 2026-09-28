import { randomUUID } from 'node:crypto';
import { assertDate, balances, addMonths } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { member } from './members.js';

const owner = (book, sub) => {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
};

export function listSchedules(book, sub) {
  owner(book, sub);
  return book.db.prepare('SELECT data FROM cash_schedules ORDER BY id').all()
    .map(row => JSON.parse(row.data));
}

export function saveSchedule(book, sub, input) {
  owner(book, sub);
  const { accountId, name, startDate, endDate, frequency } = input;
  assertDate(startDate);
  if (endDate) {
    assertDate(endDate);
    if (endDate < startDate) throw new Error('Schedule end precedes start');
  }
  if (!['once', 'monthly'].includes(frequency) ||
    typeof name !== 'string' || !name.trim() || name.length > 80 ||
    !book.accounts().get(accountId)?.cash) throw new Error('Invalid cash schedule');
  const amount = calculateAmount(input.amountExpression);
  if (amount === 0) throw new Error('Cash schedule amount cannot be zero');
  const id = input.id || randomUUID();
  const previous = book.db.prepare('SELECT 1 FROM cash_schedules WHERE id = ?').get(id);
  if (input.id && !previous) throw new Error('Unknown cash schedule');
  const schedule = { id, accountId, name: name.trim(), startDate,
    endDate: endDate || null, frequency, amount, active: true };
  book.db.prepare(`INSERT INTO cash_schedules (id, data) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(schedule));
  return schedule;
}

export function disableSchedule(book, sub, id) {
  owner(book, sub);
  const row = book.db.prepare('SELECT data FROM cash_schedules WHERE id = ?').get(id);
  if (!row) throw new Error('Unknown cash schedule');
  const schedule = { ...JSON.parse(row.data), active: false };
  book.db.prepare('UPDATE cash_schedules SET data = ? WHERE id = ?').run(JSON.stringify(schedule), id);
  return schedule;
}

export function forecast(book, sub, { asOf, throughDate, cardCashId, overrides = {} }) {
  owner(book, sub);
  assertDate(asOf);
  assertDate(throughDate);
  if (throughDate <= asOf) throw new Error('Forecast end must follow start');
  if (throughDate > addMonths(asOf, 120)) throw new Error('Forecast horizon is at most 10 years');
  const accounts = book.accounts();
  const cash = [...accounts.values()].filter(a => a.cash);
  if (cardCashId && !cash.some(a => a.id === cardCashId)) throw new Error('Invalid card payment account');
  const schedules = listSchedules(book, sub).filter(s => s.active);
  if (Object.keys(overrides).some(id => !schedules.some(s => s.id === id))) {
    throw new Error('Unknown simulation schedule');
  }
  const events = [];
  const append = (date, type, name, amount, accountId) => {
    if (date > asOf && date <= throughDate) events.push({ date, type, name, amount, accountId });
  };
  for (const s of schedules) {
    const amount = overrides[s.id] === undefined ? s.amount : calculateAmount(overrides[s.id]);
    if (s.frequency === 'once') {
      if (!s.endDate || s.startDate <= s.endDate) append(s.startDate, 'schedule', s.name, amount, s.accountId);
    } else {
      const [startYear, startMonth] = s.startDate.split('-').map(Number);
      const [currentYear, currentMonth] = asOf.split('-').map(Number);
      const first = Math.max(0, (currentYear - startYear) * 12 + currentMonth - startMonth - 1);
      for (let i = first; i < first + 123; i++) {
        const date = addMonths(s.startDate, i);
        if (date > throughDate || s.endDate && date > s.endDate) break;
        append(date, 'schedule', s.name, amount, s.accountId);
      }
    }
  }
  if (cardCashId) for (const p of book.pendingCardPayments(throughDate)) {
    append(p.dueDate, 'card', `${accounts.get(p.cardId)?.name ?? '카드'} ${p.index}회차`, -p.amount, cardCashId);
  }
  for (const entry of book.entries()) {
    if (entry.date <= asOf || entry.date > throughDate) continue;
    for (const a of cash) {
      const amount = entry.postings.filter(p => p.accountId === a.id)
        .reduce((sum, p) => sum + (p.side === 'debit' ? p.amount : -p.amount), 0);
      if (amount) append(entry.date, 'booked', entry.memo || entry.id, amount, a.id);
    }
  }
  const current = balances(accounts, book.entries(), asOf);
  const opening = Object.fromEntries(cash.map(a => [a.id, current[a.id]]));
  const projected = { ...opening };
  events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  for (const event of events) {
    projected[event.accountId] += event.amount;
    event.projectedBalance = projected[event.accountId];
  }
  const sum = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  return { opening, projected, openingTotal: sum(opening), projectedTotal: sum(projected), events };
}
