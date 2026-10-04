import { createHash, randomUUID } from 'node:crypto';
import { assertDate, validateEntry } from './ledger.js';
import { calculateAmount } from './amount-expression.js';
import { canAccessAccount, member, visibleAccounts } from './members.js';
import { entryFingerprint } from './transaction-checks.js';

export function createGroup(book, userSub, name, type) {
  if (member(book, userSub)?.role !== 'owner') throw new Error('Owner access required');
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid group name');
  return book.createAccountGroup({ id: randomUUID(), name: name.trim(), type });
}

export function renameGroup(book, userSub, groupId, name) {
  if (member(book, userSub)?.role !== 'owner') throw new Error('Owner access required');
  if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('Invalid group name');
  const group = book.accountGroups().find(g => g.id === groupId);
  if (!group) throw new Error('Unknown account group');
  const next = { ...group, name: name.trim() };
  book.db.prepare('UPDATE account_groups SET data = ? WHERE id = ?').run(JSON.stringify(next), groupId);
  return next;
}

export function moveAccountGroup(book, userSub, accountId, groupId) {
  if (member(book, userSub)?.role !== 'owner') throw new Error('Owner access required');
  const account = book.accounts().get(accountId);
  if (!account || !['asset', 'liability'].includes(account.type)) throw new Error('Invalid group account');
  if (groupId) {
    const group = book.accountGroups().find(g => g.id === groupId);
    if (!group || group.type !== account.type) throw new Error('Account group type mismatch');
  }
  const next = { ...account };
  if (groupId) next.groupId = groupId;
  else delete next.groupId;
  book.db.prepare('UPDATE accounts SET data = ? WHERE id = ?').run(JSON.stringify(next), accountId);
  return next;
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

export function buildManualEntry(book, userSub, input, id, createdBy = userSub, revision = 1) {
  const { date, kind, accountId, counterId, categoryId, amountExpression, memo = '' } = input;
  if (!canAccessAccount(book, userSub, accountId, 'write')) throw new Error('Account write access required');
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
    amount, memo: memo.trim(), userSub: createdBy };
  const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  const entry = { id, date, kind: 'manual', manualKind: kind, memo: payload.memo,
    createdBy, sourceAccountId: accountId, revision, payloadHash, postings,
    ...(categoryId ? { budgetAllocations: [{ categoryId, amount }] } : {}) };
  validateEntry(entry, accounts);
  book.validateBudgetAllocations(entry);
  return entry;
}

export function recordManual(book, userSub, input) {
  const { requestId } = input;
  if (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId)) {
    throw new Error('Valid request ID required');
  }
  const entry = buildManualEntry(book, userSub, input, `manual:${requestId}`);
  const payloadHash = entry.payloadHash;
  const existing = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entry.id);
  if (existing) {
    const previous = JSON.parse(existing.data);
    if (previous.payloadHash !== payloadHash) throw new Error('Request ID reused with different transaction');
    return { entry: previous, duplicate: true };
  }
  try { book.record(entry); }
  catch (error) {
    if (!String(error.code).startsWith('SQLITE_CONSTRAINT')) throw error;
    const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entry.id);
    if (!row) throw error;
    const previous = JSON.parse(row.data);
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
  let checkedBalance = 0;
  const checks = new Map(book.db.prepare('SELECT entry_id, entry_hash FROM account_entry_checks WHERE account_id = ?')
    .all(accountId).map(row => [row.entry_id, row.entry_hash]));
  const rows = [];
  const tagRows = new Map(book.db.prepare('SELECT entry_id, data FROM transaction_tags').all()
    .map(row => [row.entry_id, JSON.parse(row.data).tags]));
  const reversals = new Map(book.db.prepare('SELECT original_id, reversal_id FROM transaction_reversals').all()
    .map(row => [row.original_id, row.reversal_id]));
  for (const entry of book.entries()) {
    if (entry.date > throughDate) continue;
    const movement = entry.postings.filter(p => p.accountId === accountId)
      .reduce((n, p) => n + p.amount * ((p.side === 'debit') === normalDebit ? 1 : -1), 0);
    if (!movement) continue;
    balance += movement;
    const checked = checks.get(entry.id) === entryFingerprint(entry);
    if (checked) checkedBalance += movement;
    const tags = tagRows.get(entry.id) ?? [];
    rows.push({ id: entry.id, date: entry.date, memo: entry.memo ?? '', movement, balance, tags,
      kind: entry.kind, sourceAccountId: entry.sourceAccountId, createdBy: entry.createdBy, checked,
      confirmationHash: entryFingerprint(entry), reversalId: reversals.get(entry.id) ?? null,
      reversesEntryId: entry.reversesEntryId ?? null });
  }
  return { account: { id: account.id, name: account.name, type: account.type },
    balance, checkedBalance, uncheckedCount: rows.filter(row => !row.checked).length, rows: rows.reverse() };
}

export function accountOverview(book, userSub, throughDate) {
  return visibleAccounts(book, userSub).filter(a => ['asset', 'liability'].includes(a.type))
    .map(a => {
      const register = accountRegister(book, userSub, a.id, throughDate);
      return { ...register.account, balance: register.balance };
    });
}
