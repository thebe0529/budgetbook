import { visibleAccounts, canAccessAccount } from './members.js';
import { accountRegister, recordManual } from './manual.js';

export function localSnapshot(book, sub) {
  const accounts = visibleAccounts(book, sub);
  const accountsForRegister = accounts.filter(a => ['asset', 'liability'].includes(a.type));
  return {
    subject: sub,
    accounts: accountsForRegister.map(a => ({ id: a.id, name: a.name, type: a.type,
      onBudget: a.onBudget, canWrite: canAccessAccount(book, sub, a.id, 'write'),
      balance: accountRegister(book, sub, a.id, '9999-12-31').balance })),
    counterpartAccounts: [...book.accounts().values()].filter(a => ['expense', 'income'].includes(a.type) ||
      (['asset', 'liability'].includes(a.type) && canAccessAccount(book, sub, a.id, 'write')))
      .map(a => ({ id: a.id, name: a.name, type: a.type })),
    categories: [...book.budgetCategories().values()].map(c => ({ id: c.id, name: c.name })),
  };
}

export function acceptLocalTransaction(book, sub, input) {
  if (!input || typeof input !== 'object' || !['expense', 'income', 'transfer'].includes(input.kind)) {
    throw new Error('Invalid local transaction');
  }
  return recordManual(book, sub, {
    requestId: input.requestId, date: input.date, kind: input.kind,
    accountId: input.accountId, counterId: input.counterId,
    amountExpression: input.amountExpression, categoryId: input.categoryId || null,
    memo: input.memo ?? '',
  });
}
