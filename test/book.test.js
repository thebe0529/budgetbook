import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { installmentSchedule } from '../src/ledger.js';

function setup(filename) {
  const book = new Book(filename);
  for (const account of [
    { id: 'bank', name: '보통예금', type: 'asset', cash: true },
    { id: 'card', name: '신용카드', type: 'liability', card: true },
    { id: 'opening', name: '기초순자산', type: 'equity' },
    { id: 'salary', name: '급여', type: 'income' },
    { id: 'food', name: '식비', type: 'expense' },
    { id: 'suspense', name: '미분류조정', type: 'equity' },
  ]) book.createAccount(account);
  book.record({ id: 'opening:1', date: '2026-10-01', postings: [
    { accountId: 'bank', side: 'debit', amount: 500_000 },
    { accountId: 'opening', side: 'credit', amount: 500_000 },
  ] });
  return book;
}

test('card purchase records expense once; installments change cash and liability', () => {
  const book = setup();
  try {
    const plan = book.cardPurchase({ id: 'p1', date: '2026-10-10', cardId: 'card',
      expenseId: 'food', amount: 120_000, count: 3, firstDueDate: '2026-11-25' });
    assert.deepEqual(plan.installments.map(i => i.amount), [40_000, 40_000, 40_000]);
    assert.deepEqual(book.reports('2026-10-01', '2026-10-31').balanceSheet.accounts,
      { bank: 500_000, card: 120_000, food: 120_000, opening: 500_000, salary: 0, suspense: 0 });
    assert.equal(book.reports('2026-10-01', '2026-10-31').incomeStatement.result, -120_000);
    assert.equal(book.reports('2026-10-01', '2026-10-31').cashFlow.netChange, 500_000);
    book.payInstallment({ planId: 'p1', index: 1, date: '2026-11-25', cashId: 'bank' });
    const november = book.reports('2026-11-01', '2026-11-30');
    assert.equal(november.balanceSheet.accounts.card, 80_000);
    assert.equal(november.balanceSheet.accounts.bank, 460_000);
    assert.equal(november.incomeStatement.expenses, 0);
    assert.equal(november.cashFlow.netChange, -40_000);
    assert.deepEqual(book.pendingCardPayments('2027-02-01').map(p => p.index), [2, 3]);
    assert.throws(() => book.payInstallment({ planId: 'p1', index: 1,
      date: '2026-11-25', cashId: 'bank' }), /already paid/);
  } finally { book.close(); }
});

test('adjustment batches are atomic and traceable in the income statement', () => {
  const book = setup();
  try {
    assert.throws(() => book.adjustBatch({ id: 'bad', date: '2026-10-31', reason: '누락', entries: [
      { postings: [{ accountId: 'food', side: 'debit', amount: 20_000 },
        { accountId: 'bank', side: 'credit', amount: 20_000 }] },
      { postings: [{ accountId: 'food', side: 'debit', amount: 100 },
        { accountId: 'bank', side: 'credit', amount: 90 }] },
    ] }), /not balanced/);
    assert.equal(book.entries().length, 1);
    const batch = book.adjustBatch({ id: 'oct', date: '2026-10-31', reason: '누락된 현금 식비', entries: [
      { postings: [{ accountId: 'food', side: 'debit', amount: 20_000 },
        { accountId: 'bank', side: 'credit', amount: 20_000 }] },
    ] });
    assert.deepEqual(batch.entryIds, ['adjust:oct:1']);
    const report = book.reports('2026-10-01', '2026-10-31');
    assert.equal(report.incomeStatement.expenses, 20_000);
    assert.equal(report.balanceSheet.netWorth, 480_000);
    assert.equal(report.cashFlow.netChange, 480_000);
  } finally { book.close(); }
});

test('rejects unbalanced entries, invalid dates, and unsafe amounts', () => {
  const book = setup();
  try {
    assert.throws(() => book.record({ id: 'bad', date: '2026-02-30', postings: [] }), /real/);
    assert.throws(() => book.record({ id: 'bad', date: '2026-10-10', postings: [
      { accountId: 'bank', side: 'debit', amount: 100 },
      { accountId: 'salary', side: 'credit', amount: 99 },
    ] }), /not balanced/);
    assert.throws(() => book.record({ id: 'bad', date: '2026-10-10', postings: [
      { accountId: 'bank', side: 'debit', amount: 1.5 },
      { accountId: 'salary', side: 'credit', amount: 1.5 },
    ] }), /integer/);
    assert.equal(book.entries().length, 1);
  } finally { book.close(); }
});

test('installment rounding and month end dates remain exact', () => {
  assert.deepEqual(installmentSchedule(100, 3, '2026-01-31').map(p => [p.dueDate, p.amount]),
    [['2026-01-31', 34], ['2026-02-28', 33], ['2026-03-31', 33]]);
});

test('SQLite storage survives reopening', () => {
  const directory = mkdtempSync(join(tmpdir(), 'budgetbook-'));
  const filename = join(directory, 'book.sqlite');
  try {
    const book = setup(filename);
    book.close();
    const reopened = new Book(filename);
    assert.equal(reopened.reports('2026-10-01', '2026-10-31').balanceSheet.assets, 500_000);
    reopened.close();
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
