import { assertDate, balances } from './ledger.js';
import { member } from './members.js';

function owner(book, sub) {
  if (member(book, sub)?.role !== 'owner') throw new Error('Owner access required');
}

export function detailedReports(book, sub, fromDate, throughDate) {
  owner(book, sub);
  assertDate(fromDate);
  assertDate(throughDate);
  if (fromDate > throughDate) throw new Error('Invalid report period');
  const accounts = book.accounts();
  const entries = book.entries();
  const summary = book.reports(fromDate, throughDate);
  const groups = new Map(book.accountGroups().map(g => [g.id, g.name]));
  const periodBalances = balances(accounts, entries.filter(e => e.date >= fromDate && e.date <= throughDate));
  const positions = [...accounts.values()].filter(a => ['asset', 'liability', 'equity'].includes(a.type))
    .map(a => ({ id: a.id, name: a.name, type: a.type, group: groups.get(a.groupId) ?? '그룹 없음',
      amount: summary.balanceSheet.accounts[a.id] }));
  const performance = [...accounts.values()].filter(a => ['income', 'expense'].includes(a.type))
    .map(a => ({ id: a.id, name: a.name, type: a.type, amount: periodBalances[a.id] }));
  const cash = [...accounts.values()].filter(a => a.cash);
  const openingDate = new Date(`${fromDate}T00:00:00Z`);
  openingDate.setUTCDate(openingDate.getUTCDate() - 1);
  const opening = fromDate === '0001-01-01' ? Object.fromEntries(cash.map(a => [a.id, 0])) :
    balances(accounts, entries, openingDate.toISOString().slice(0, 10));
  const cashRows = cash.map(a => ({ id: a.id, name: a.name, opening: opening[a.id],
    receipts: 0, payments: 0, closing: summary.balanceSheet.accounts[a.id] }));
  const cashMovements = [];
  for (const entry of entries) {
    if (entry.date < fromDate || entry.date > throughDate) continue;
    for (const row of cashRows) {
      const amount = entry.postings.filter(p => p.accountId === row.id)
        .reduce((total, p) => total + (p.side === 'debit' ? p.amount : -p.amount), 0);
      if (!amount) continue;
      if (amount > 0) row.receipts += amount;
      else row.payments += -amount;
      cashMovements.push({ id: entry.id, date: entry.date, memo: entry.memo ?? '',
        accountId: row.id, amount });
    }
  }
  for (const row of cashRows) {
    if (row.opening + row.receipts - row.payments !== row.closing) {
      throw new Error('Cash reconciliation failed');
    }
  }
  const cashTotals = cashRows.reduce((t, r) => ({ opening: t.opening + r.opening,
    receipts: t.receipts + r.receipts, payments: t.payments + r.payments,
    closing: t.closing + r.closing }), { opening: 0, receipts: 0, payments: 0, closing: 0 });
  if (cashTotals.closing - cashTotals.opening !== summary.cashFlow.netChange) {
    throw new Error('Cash flow reconciliation failed');
  }
  return { summary, positions, performance, cashRows, cashTotals, cashMovements };
}

export function accountActivity(book, sub, accountId, fromDate, throughDate) {
  owner(book, sub);
  assertDate(fromDate);
  assertDate(throughDate);
  if (fromDate > throughDate) throw new Error('Invalid report period');
  const account = book.accounts().get(accountId);
  if (!account) throw new Error('Unknown account');
  const entries = book.entries();
  const debitNormal = ['asset', 'expense'].includes(account.type);
  const lines = entries.filter(e => e.date >= fromDate && e.date <= throughDate)
    .flatMap(e => e.postings.filter(p => p.accountId === accountId).map(p => ({
      entryId: e.id, date: e.date, memo: e.memo ?? '', side: p.side, amount: p.amount,
      movement: p.amount * ((p.side === 'debit') === debitNormal ? 1 : -1),
    })));
  const total = lines.reduce((sum, line) => sum + line.movement, 0);
  const expected = balances(book.accounts(), entries.filter(e => e.date >= fromDate && e.date <= throughDate))[accountId];
  if (total !== expected) throw new Error('Account activity reconciliation failed');
  return { account, total, lines };
}
