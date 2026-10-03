import { randomUUID } from 'node:crypto';
import { assertDate, balances, addMonths } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { member } from './members.js';
import { cardCashDefault } from './card-manual.js';

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
    endDate: endDate || null, frequency, amount, active: previous ?
      JSON.parse(book.db.prepare('SELECT data FROM cash_schedules WHERE id = ?').get(id).data).active : true };
  book.db.prepare(`INSERT INTO cash_schedules (id, data) VALUES (?, ?)
    ON CONFLICT(id) DO UPDATE SET data = excluded.data`).run(id, JSON.stringify(schedule));
  return schedule;
}

function occurrence(schedule, date) {
  assertDate(date);
  if (date < schedule.startDate || schedule.endDate && date > schedule.endDate) return false;
  if (schedule.frequency === 'once') return date === schedule.startDate;
  const [year, month] = date.split('-').map(Number);
  const [startYear, startMonth] = schedule.startDate.split('-').map(Number);
  const offset = (year - startYear) * 12 + month - startMonth;
  return offset >= 0 && addMonths(schedule.startDate, offset) === date;
}

function cashMovement(entry, accountId) {
  return entry.postings.filter(p => p.accountId === accountId)
    .reduce((sum, p) => sum + (p.side === 'debit' ? p.amount : -p.amount), 0);
}

function matches(schedule, date, entry) {
  const distance = Math.abs(Date.parse(`${entry.date}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`));
  return distance <= 31 * 86400000 && cashMovement(entry, schedule.accountId) === schedule.amount;
}

export function linkedOccurrences(book, sub) {
  owner(book, sub);
  return book.db.prepare('SELECT schedule_id, occurrence_date, entry_id FROM cash_schedule_links').all();
}

export function linkOccurrence(book, sub, { scheduleId, date, entryId }) {
  owner(book, sub);
  const schedule = listSchedules(book, sub).find(s => s.id === scheduleId);
  if (!schedule || !occurrence(schedule, date)) throw new Error('Unknown schedule occurrence');
  const entry = book.entries().find(e => e.id === entryId);
  if (!entry || !matches(schedule, date, entry)) throw new Error('Actual cash movement does not match schedule');
  book.db.prepare(`INSERT INTO cash_schedule_links (schedule_id, occurrence_date, entry_id, linked_at)
    VALUES (?, ?, ?, ?)`).run(scheduleId, date, entryId, new Date().toISOString());
}

export function unlinkOccurrence(book, sub, { scheduleId, date }) {
  owner(book, sub);
  assertDate(date);
  if (book.db.prepare('DELETE FROM cash_schedule_links WHERE schedule_id = ? AND occurrence_date = ?')
    .run(scheduleId, date).changes !== 1) throw new Error('Unknown schedule link');
}

export function matchingEntries(book, sub, scheduleId, date) {
  owner(book, sub);
  const schedule = listSchedules(book, sub).find(s => s.id === scheduleId);
  if (!schedule || !occurrence(schedule, date)) throw new Error('Unknown schedule occurrence');
  const used = new Set(linkedOccurrences(book, sub).map(link => link.entry_id));
  return book.entries().filter(entry => !used.has(entry.id) && matches(schedule, date, entry));
}

// Link only unambiguous matches; ambiguous or absent candidates remain for review.
export function autoLinkMatches(book, sub, { scheduleId, dates }) {
  owner(book, sub);
  if (!listSchedules(book, sub).some(s => s.id === scheduleId)) throw new Error('Unknown cash schedule');
  if (!Array.isArray(dates) || dates.length > 123 || new Set(dates).size !== dates.length) {
    throw new Error('Invalid matching dates');
  }
  return book.atomic(() => {
    const alreadyLinked = new Set(linkedOccurrences(book, sub)
      .filter(link => link.schedule_id === scheduleId).map(link => link.occurrence_date));
    const choices = dates.filter(date => !alreadyLinked.has(date))
      .map(date => ({ date, candidates: matchingEntries(book, sub, scheduleId, date) }));
    const candidateCounts = new Map();
    for (const { candidates } of choices) for (const entry of candidates) {
      candidateCounts.set(entry.id, (candidateCounts.get(entry.id) ?? 0) + 1);
    }
    const linked = [];
    for (const { date, candidates } of choices) {
      if (candidates.length !== 1 || candidateCounts.get(candidates[0].id) !== 1) continue;
      linkOccurrence(book, sub, { scheduleId, date, entryId: candidates[0].id });
      linked.push({ date, entryId: candidates[0].id });
    }
    return linked;
  });
}

export function disableSchedule(book, sub, id) {
  owner(book, sub);
  const row = book.db.prepare('SELECT data FROM cash_schedules WHERE id = ?').get(id);
  if (!row) throw new Error('Unknown cash schedule');
  const schedule = { ...JSON.parse(row.data), active: false };
  book.db.prepare('UPDATE cash_schedules SET data = ? WHERE id = ?').run(JSON.stringify(schedule), id);
  return schedule;
}

export function forecast(book, sub, { asOf, throughDate, cardCashId, useCardDefaults = false, overrides = {} }) {
  owner(book, sub);
  assertDate(asOf);
  assertDate(throughDate);
  if (throughDate <= asOf) throw new Error('Forecast end must follow start');
  if (throughDate > addMonths(asOf, 120)) throw new Error('Forecast horizon is at most 10 years');
  const accounts = book.accounts();
  const cash = [...accounts.values()].filter(a => a.cash);
  if (typeof useCardDefaults !== 'boolean' || useCardDefaults && cardCashId) throw new Error('Invalid card forecast mode');
  if (cardCashId && !cash.some(a => a.id === cardCashId)) throw new Error('Invalid card payment account');
  const schedules = listSchedules(book, sub).filter(s => s.active);
  const entries = book.entries();
  const linked = new Set(linkedOccurrences(book, sub).filter(row => {
    const schedule = schedules.find(s => s.id === row.schedule_id);
    const entry = entries.find(e => e.id === row.entry_id);
    return schedule && entry && occurrence(schedule, row.occurrence_date) &&
      matches(schedule, row.occurrence_date, entry);
  }).map(row => `${row.schedule_id}:${row.occurrence_date}`));
  if (Object.keys(overrides).some(id => !schedules.some(s => s.id === id))) {
    throw new Error('Unknown simulation schedule');
  }
  const events = [];
  const append = (date, type, name, amount, accountId, scheduleId) => {
    if (date > asOf && date <= throughDate) events.push({ date, type, name, amount, accountId,
      ...(scheduleId ? { scheduleId } : {}) });
  };
  for (const s of schedules) {
    const amount = overrides[s.id] === undefined ? s.amount : calculateAmount(overrides[s.id]);
    if (s.frequency === 'once') {
      if ((!s.endDate || s.startDate <= s.endDate) &&
        !linked.has(`${s.id}:${s.startDate}`)) append(s.startDate, 'schedule', s.name, amount, s.accountId, s.id);
    } else {
      const [startYear, startMonth] = s.startDate.split('-').map(Number);
      const [currentYear, currentMonth] = asOf.split('-').map(Number);
      const first = Math.max(0, (currentYear - startYear) * 12 + currentMonth - startMonth - 1);
      for (let i = first; i < first + 123; i++) {
        const date = addMonths(s.startDate, i);
        if (date > throughDate || s.endDate && date > s.endDate) break;
        if (!linked.has(`${s.id}:${date}`)) append(date, 'schedule', s.name, amount, s.accountId, s.id);
      }
    }
  }
  const missingCardAccounts = new Map();
  if (cardCashId || useCardDefaults) for (const p of book.pendingCardPayments(throughDate)) {
    if (p.dueDate <= asOf) continue;
    const accountId = useCardDefaults ? cardCashDefault(book, sub, p.cardId) : cardCashId;
    if (!accountId) {
      const missing = missingCardAccounts.get(p.cardId) ?? { cardId: p.cardId,
        name: accounts.get(p.cardId)?.name ?? '카드', count: 0, amount: 0 };
      missing.count++;
      missing.amount += p.amount;
      missingCardAccounts.set(p.cardId, missing);
      continue;
    }
    append(p.dueDate, 'card', `${accounts.get(p.cardId)?.name ?? '카드'} ${p.index}회차`, -p.amount, accountId);
  }
  for (const entry of entries) {
    if (entry.date <= asOf || entry.date > throughDate) continue;
    for (const a of cash) {
      const amount = cashMovement(entry, a.id);
      if (amount) append(entry.date, 'booked', entry.memo || entry.id, amount, a.id);
    }
  }
  const current = balances(accounts, entries, asOf);
  const opening = Object.fromEntries(cash.map(a => [a.id, current[a.id]]));
  const projected = { ...opening };
  events.sort((a, b) => a.date.localeCompare(b.date) || a.type.localeCompare(b.type));
  for (const event of events) {
    projected[event.accountId] += event.amount;
    event.projectedBalance = projected[event.accountId];
  }
  const sum = obj => Object.values(obj).reduce((a, b) => a + b, 0);
  return { opening, projected, openingTotal: sum(opening), projectedTotal: sum(projected), events,
    missingCardAccounts: [...missingCardAccounts.values()] };
}
