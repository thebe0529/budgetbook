const ACCOUNT_TYPES = new Set(['asset', 'liability', 'equity', 'income', 'expense']);
const SIDE = new Set(['debit', 'credit']);

export function assertDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new Error('Date must be a real YYYY-MM-DD date');
  }
}

export function validateAccount(account) {
  if (!account?.id || !account?.name || !ACCOUNT_TYPES.has(account.type)) {
    throw new Error('Account needs an id, name, and valid type');
  }
  if (account.cash && account.type !== 'asset') throw new Error('Cash account must be an asset');
  if (account.card && account.type !== 'liability') throw new Error('Card account must be a liability');
  if (account.onBudget !== undefined && typeof account.onBudget !== 'boolean') {
    throw new Error('onBudget must be a boolean');
  }
}

export function validateEntry(entry, accounts) {
  if (!entry?.id) throw new Error('Entry id is required');
  assertDate(entry.date);
  if (!Array.isArray(entry.postings) || entry.postings.length < 2) {
    throw new Error('At least two postings are required');
  }
  let debit = 0;
  let credit = 0;
  for (const posting of entry.postings) {
    if (!accounts.has(posting.accountId)) throw new Error(`Unknown account: ${posting.accountId}`);
    if (!SIDE.has(posting.side) || !Number.isSafeInteger(posting.amount) || posting.amount <= 0) {
      throw new Error('Posting amount must be a positive integer in minor currency units');
    }
    if (posting.side === 'debit') debit += posting.amount;
    else credit += posting.amount;
  }
  if (!Number.isSafeInteger(debit) || debit !== credit) throw new Error('Entry is not balanced');
}

export function balances(accounts, entries, throughDate = '9999-12-31') {
  const result = Object.fromEntries(accounts.keys().map(id => [id, 0]));
  for (const entry of entries) {
    if (entry.date > throughDate) continue;
    for (const posting of entry.postings) {
      const type = accounts.get(posting.accountId).type;
      const normalDebit = type === 'asset' || type === 'expense';
      result[posting.accountId] += posting.amount * ((posting.side === 'debit') === normalDebit ? 1 : -1);
    }
  }
  return result;
}

export function balanceSheet(accounts, entries, throughDate) {
  assertDate(throughDate);
  const amounts = balances(accounts, entries, throughDate);
  const sum = type => [...accounts.values()].filter(a => a.type === type)
    .reduce((total, a) => total + amounts[a.id], 0);
  const assets = sum('asset');
  const liabilities = sum('liability');
  const equity = sum('equity');
  const retainedResult = sum('income') - sum('expense');
  if (assets !== liabilities + equity + retainedResult) throw new Error('Ledger identity failed');
  return { asOf: throughDate, assets, liabilities, equity, retainedResult,
    netWorth: assets - liabilities, accounts: amounts };
}

export function incomeStatement(accounts, entries, fromDate, throughDate) {
  assertDate(fromDate);
  assertDate(throughDate);
  if (fromDate > throughDate) throw new Error('Invalid report period');
  const period = entries.filter(e => e.date >= fromDate && e.date <= throughDate);
  const amounts = balances(accounts, period);
  const income = [...accounts.values()].filter(a => a.type === 'income')
    .reduce((total, a) => total + amounts[a.id], 0);
  const expenses = [...accounts.values()].filter(a => a.type === 'expense')
    .reduce((total, a) => total + amounts[a.id], 0);
  return { fromDate, throughDate, income, expenses, result: income - expenses,
    accounts: Object.fromEntries([...accounts.values()].filter(a => ['income', 'expense'].includes(a.type))
      .map(a => [a.id, amounts[a.id]])) };
}

export function cashFlow(accounts, entries, fromDate, throughDate) {
  assertDate(fromDate);
  assertDate(throughDate);
  if (fromDate > throughDate) throw new Error('Invalid report period');
  const cashIds = new Set([...accounts.values()].filter(a => a.cash).map(a => a.id));
  const movements = entries.filter(e => e.date >= fromDate && e.date <= throughDate)
    .map(entry => ({ entryId: entry.id, date: entry.date,
      amount: entry.postings.filter(p => cashIds.has(p.accountId))
        .reduce((n, p) => n + (p.side === 'debit' ? p.amount : -p.amount), 0) }))
    .filter(m => m.amount !== 0);
  return { fromDate, throughDate, netChange: movements.reduce((n, m) => n + m.amount, 0), movements };
}

export function addMonths(date, months) {
  assertDate(date);
  const [year, month, day] = date.split('-').map(Number);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  return `${target.getUTCFullYear()}-${String(target.getUTCMonth() + 1).padStart(2, '0')}-${String(Math.min(day, lastDay)).padStart(2, '0')}`;
}

export function installmentSchedule(total, count, firstDueDate) {
  if (!Number.isSafeInteger(total) || total <= 0 || !Number.isInteger(count) || count < 1 || count > 120) {
    throw new Error('Invalid installment total or count');
  }
  assertDate(firstDueDate);
  const base = Math.floor(total / count);
  return Array.from({ length: count }, (_, i) => ({ index: i + 1,
    dueDate: addMonths(firstDueDate, i), amount: base + (i < total % count ? 1 : 0), paidEntryId: null }));
}

export function assertMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    throw new Error('Month must be YYYY-MM');
  }
}

export function budgetSummary(accounts, entries, categories, allocations, throughMonth) {
  assertMonth(throughMonth);
  const throughDate = `${throughMonth}-${new Date(Date.UTC(Number(throughMonth.slice(0, 4)),
    Number(throughMonth.slice(5, 7)), 0)).getUTCDate()}`;
  const accountBalances = balances(accounts, entries, throughDate);
  const availableFunds = [...accounts.values()].filter(a => a.onBudget &&
    ['asset', 'liability'].includes(a.type)).reduce((n, a) => n +
      accountBalances[a.id] * (a.type === 'liability' ? -1 : 1), 0);
  const result = Object.fromEntries([...categories.values()].map(c => [c.id,
    { categoryId: c.id, name: c.name, budgeted: 0, spent: 0, balance: 0 }]));
  for (const assignment of allocations) {
    if (assignment.month > throughMonth) continue;
    result[assignment.categoryId].balance += assignment.amount;
    if (assignment.month === throughMonth) result[assignment.categoryId].budgeted += assignment.amount;
  }
  for (const entry of entries) {
    if (entry.date > throughDate) continue;
    for (const allocation of entry.budgetAllocations ?? []) {
      result[allocation.categoryId].balance -= allocation.amount;
      if (entry.date.startsWith(throughMonth)) result[allocation.categoryId].spent += allocation.amount;
    }
  }
  const categoryBalance = Object.values(result).reduce((n, c) => n + c.balance, 0);
  return { throughMonth, availableFunds, readyToAssign: availableFunds - categoryBalance,
    categories: result };
}
