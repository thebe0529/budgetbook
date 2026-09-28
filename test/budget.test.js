import test from 'node:test';
import assert from 'node:assert/strict';
import { Book } from '../src/book.js';

function bookWithBudget() {
  const book = new Book();
  book.createAccountGroup({ id: 'deposits', name: '보통예금', type: 'asset' });
  book.createAccountGroup({ id: 'cards', name: '신용카드', type: 'liability' });
  book.createAccount({ id: 'bank', name: '생활비 통장', type: 'asset', cash: true,
    groupId: 'deposits', onBudget: true });
  book.createAccount({ id: 'card', name: '생활 카드', type: 'liability', card: true,
    groupId: 'cards', onBudget: true });
  book.createAccount({ id: 'savings', name: '저축', type: 'asset', cash: true, onBudget: false });
  book.createAccount({ id: 'equity', name: '기초순자산', type: 'equity' });
  book.createAccount({ id: 'food', name: '식비 비용', type: 'expense' });
  book.createBudgetCategory({ id: 'groceries', name: '식비' });
  book.record({ id: 'opening', date: '2026-10-01', postings: [
    { accountId: 'bank', side: 'debit', amount: 500_000 },
    { accountId: 'equity', side: 'credit', amount: 500_000 },
  ] });
  return book;
}

test('account groups are independent of budget categories and account type checked', () => {
  const book = bookWithBudget();
  try {
    assert.deepEqual(book.accountGroups().map(g => g.name), ['신용카드', '보통예금']);
    assert.throws(() => book.createAccount({ id: 'wrong', name: '잘못된 계좌',
      type: 'liability', groupId: 'deposits' }), /group type mismatch/);
    assert.equal(book.accounts().get('bank').groupId, 'deposits');
  } finally { book.close(); }
});

test('card purchase uses October budget once and November payment does not', () => {
  const book = bookWithBudget();
  try {
    book.assignBudget('2026-10', 'groceries', 150_000);
    book.cardPurchase({ id: 'p', date: '2026-10-10', cardId: 'card', expenseId: 'food',
      categoryId: 'groceries', amount: 120_000, count: 3, firstDueDate: '2026-11-25' });
    const october = book.budget('2026-10');
    assert.equal(october.availableFunds, 380_000);
    assert.equal(october.categories.groceries.balance, 30_000);
    assert.equal(october.readyToAssign, 350_000);
    book.payInstallment({ planId: 'p', index: 1, date: '2026-11-25', cashId: 'bank' });
    const november = book.budget('2026-11');
    assert.equal(november.availableFunds, 380_000);
    assert.equal(november.categories.groceries.spent, 0);
    assert.equal(november.categories.groceries.balance, 30_000);
  } finally { book.close(); }
});

test('off-budget transfers reduce available funds but do not count as spending', () => {
  const book = bookWithBudget();
  try {
    book.record({ id: 'transfer', date: '2026-10-02', postings: [
      { accountId: 'savings', side: 'debit', amount: 200_000 },
      { accountId: 'bank', side: 'credit', amount: 200_000 },
    ] });
    const budget = book.budget('2026-10');
    assert.equal(budget.availableFunds, 300_000);
    assert.equal(budget.categories.groceries.spent, 0);
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.expenses, 0);
  } finally { book.close(); }
});

test('budget splits must equal expenses and use an on-budget account', () => {
  const book = bookWithBudget();
  try {
    assert.throws(() => book.record({ id: 'bad', date: '2026-10-02', postings: [
      { accountId: 'food', side: 'debit', amount: 10_000 },
      { accountId: 'bank', side: 'credit', amount: 10_000 },
    ], budgetAllocations: [{ categoryId: 'groceries', amount: 9_000 }] }), /must equal/);
    assert.throws(() => book.record({ id: 'off', date: '2026-10-02', postings: [
      { accountId: 'food', side: 'debit', amount: 10_000 },
      { accountId: 'savings', side: 'credit', amount: 10_000 },
    ], budgetAllocations: [{ categoryId: 'groceries', amount: 10_000 }] }), /on-budget/);
    assert.equal(book.entries().length, 1);
  } finally { book.close(); }
});
