import { createHash, randomUUID } from 'node:crypto';
import { assertDate } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { canAccessAccount, member, visibleAccounts } from './members.js';

export function createGroup(book, userSub, name, type) {
  if (member(book, userSub)?.role !== 'owner') throw new Error('Owner access required');
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid group name');
  return book.createAccountGroup({ id: randomUUID(), name: name.trim(), type });
}

export function createLedgerAccount(book, userSub, options) {
  if (member(book, userSub)?.role !== 'owner') throw new Error('Owner access required');
  const { name, type, groupId, onBudget, cash, card } = options;
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid account name');
  if ((onBudget || cash || card || groupId) && !['asset', 'liability'].includes(type)) {
    throw new Error('Only asset and liability accounts can use these options');
  }
  if (onBudget && !['asset', 'liability'].includes(type)) throw new Error('Invalid on-budget account');
  return book.createAccount({ id: randomUUID(), name: name.trim(), type,
    ...(groupId ? { groupId } : {}), onBudget: Boolean(onBudget), cash: Boolean(cash), card: Boolean(card) });
}

export function createCategory(book, userSub, name) {
  if (member(book, userSub)?.role !== 'owner') throw new Error('Owner access required');
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid category name');
  return book.createBudgetCategory({ id: randomUUID(), name: name.trim() });
}

export function recordManual(book, userSub, input) {
  const { date, kind, accountId, counterId, categoryId, amountExpression, memo = '', requestId } = input;
  if (!canAccessAccount(book, userSub, accountId, 'write')) throw new Error('Account write access required');
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('Valid request ID required');
  }
  assertDate(date);
  if (typeof memo !== 'string' || memo.length > 500) throw new Error('Invalid memo');
  const amount = calculateAmount(amountExpression);
  if (amount <= 0) throw new Error('Amount must be positive');
  const accounts = book.accounts();
  const account = accounts.get(accountId);
  const counter = accounts.get(counterId);
  if (!['asset', 'liability'].includes(account.type)) throw new Error('Select an asset or liability account');
  if (!counter) throw new Error('Counter account not found');
  const postings = [];
  if (kind === 'expense' && counter.type === 'expense') {
    postings.push({ accountId: counterId, side: 'debit', amount },
      { accountId, side: 'credit', amount });
  } else if (kind === 'income' && account.type === 'asset' && counter.type === 'income') {
    postings.push({ accountId, side: 'debit', amount },
      { accountId: counterId, side: 'credit', amount });
  } else if (kind === 'transfer' && account.type === 'asset' &&
    ['asset', 'liability'].includes(counter.type) && counterId !== accountId) {
    if (!canAccessAccount(book, userSub, counterId, 'write')) throw new Error('Transfer destination access required');
    postings.push({ accountId: counterId, side: 'debit', amount },
      { accountId, side: 'credit', amount });
  } else if (kind === 'opening' && member(book, userSub)?.role === 'owner' && counter.type === 'equity') {
    postings.push({ accountId, side: account.type === 'asset' ? 'debit' : 'credit', amount },
      { accountId: counterId, side: account.type === 'asset' ? 'credit' : 'debit', amount });
  } else throw new Error('Invalid transaction type or counter account');
  if (categoryId && (kind !== 'expense' || !account.onBudget ||
    !book.budgetCategories().has(categoryId))) throw new Error('Invalid budget category');
  const payload = { date, kind, accountId, counterId, categoryId: categoryId || null,
    amount, memo: memo.trim(), userSub };
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const entry = { id: `manual:${requestId}`, date, kind: 'manual', memo: payload.memo,
    createdBy: userSub, payloadHash, postings,
    ...(categoryId ? { budgetAllocations: [{ categoryId, amount }] } : {}) };
  const existing = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entry.id);
  if (existing) {
    const previous = JSON.parse(existing.data);
    if (previous.payloadHash !== payloadHash) throw new Error('Request ID reused with different transaction');
    return { entry: previous, duplicate: true };
  }
  try { book.record(entry); }
  catch (error) {
    if (!String(error.code).startsWith('SQLITE_CONSTRAINT')) throw error;
    const previous = JSON.parse(book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entry.id).data);
    if (previous.payloadHash !== payloadHash) throw new Error('Request ID reused with different transaction');
    return { entry: previous, duplicate: true };
  }
  return { entry, duplicate: false };
}

export function accountRegister(book, userSub, accountId, throughDate) {
  assertDate(throughDate);
  if (!canAccessAccount(book, userSub, accountId)) throw new Error('Account read access required');
  const account = book.accounts().get(accountId);
  const normalDebit = account.type === 'asset';
  let balance = 0;
  const rows = [];
  for (const entry of book.entries()) {
    if (entry.date > throughDate) continue;
    const movement = entry.postings.filter(p => p.accountId === accountId)
      .reduce((n, p) => n + p.amount * ((p.side === 'debit') === normalDebit ? 1 : -1), 0);
    if (!movement) continue;
    balance += movement;
    rows.push({ id: entry.id, date: entry.date, memo: entry.memo ?? '', movement, balance });
  }
  return { account: { id: account.id, name: account.name, type: account.type },
    balance, rows: rows.reverse() };
}

export function accountOverview(book, userSub, throughDate) {
  return visibleAccounts(book, userSub).filter(a => ['asset', 'liability'].includes(a.type))
    .map(a => {
      const register = accountRegister(book, userSub, a.id, throughDate);
      return { ...register.account, balance: register.balance };
    });
}
