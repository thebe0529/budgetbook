import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { assertDate, validateAccount, validateEntry, balanceSheet, incomeStatement,
  cashFlow, installmentSchedule } from './ledger.js';

export class Book {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adjustment_batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
  }

  close() { this.db.close(); }

  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  accounts() {
    return new Map(this.db.prepare('SELECT data FROM accounts ORDER BY id').all()
      .map(row => { const value = JSON.parse(row.data); return [value.id, value]; }));
  }

  entries() {
    return this.db.prepare('SELECT data FROM entries ORDER BY date, id').all()
      .map(row => JSON.parse(row.data));
  }

  createAccount(account) {
    validateAccount(account);
    this.db.prepare('INSERT INTO accounts (id, data) VALUES (?, ?)').run(account.id, JSON.stringify(account));
    return account;
  }

  record(entry) {
    validateEntry(entry, this.accounts());
    this.db.prepare('INSERT INTO entries (id, date, data) VALUES (?, ?, ?)')
      .run(entry.id, entry.date, JSON.stringify(entry));
    return entry;
  }

  reports(fromDate, throughDate) {
    const accounts = this.accounts();
    const entries = this.entries();
    return { balanceSheet: balanceSheet(accounts, entries, throughDate),
      incomeStatement: incomeStatement(accounts, entries, fromDate, throughDate),
      cashFlow: cashFlow(accounts, entries, fromDate, throughDate) };
  }

  cardPurchase({ id = randomUUID(), date, cardId, expenseId, amount, count, firstDueDate, memo = '' }) {
    assertDate(date);
    const accounts = this.accounts();
    if (!accounts.get(cardId)?.card || accounts.get(expenseId)?.type !== 'expense') {
      throw new Error('Card purchase requires a card liability and expense account');
    }
    const installments = installmentSchedule(amount, count, firstDueDate);
    const entry = { id: `purchase:${id}`, date, memo,
      postings: [{ accountId: expenseId, side: 'debit', amount },
        { accountId: cardId, side: 'credit', amount }] };
    const plan = { id, purchaseEntryId: entry.id, cardId, installments };
    return this.atomic(() => {
      this.record(entry);
      this.db.prepare('INSERT INTO card_plans (id, data) VALUES (?, ?)').run(id, JSON.stringify(plan));
      return plan;
    });
  }

  cardPlan(id) {
    const row = this.db.prepare('SELECT data FROM card_plans WHERE id = ?').get(id);
    return row ? JSON.parse(row.data) : null;
  }

  payInstallment({ planId, index, date, cashId }) {
    assertDate(date);
    const accounts = this.accounts();
    if (!accounts.get(cashId)?.cash) throw new Error('Payment requires a cash account');
    return this.atomic(() => {
      const plan = this.cardPlan(planId);
      const installment = plan?.installments.find(item => item.index === index);
      if (!installment || installment.paidEntryId) throw new Error('Unknown or already paid installment');
      const entry = { id: `payment:${planId}:${index}`, date, kind: 'card-payment',
        postings: [{ accountId: plan.cardId, side: 'debit', amount: installment.amount },
          { accountId: cashId, side: 'credit', amount: installment.amount }] };
      this.record(entry);
      installment.paidEntryId = entry.id;
      this.db.prepare('UPDATE card_plans SET data = ? WHERE id = ?').run(JSON.stringify(plan), planId);
      return entry;
    });
  }

  pendingCardPayments(throughDate) {
    assertDate(throughDate);
    return this.db.prepare('SELECT data FROM card_plans').all().flatMap(row => {
      const plan = JSON.parse(row.data);
      return plan.installments.filter(item => !item.paidEntryId && item.dueDate <= throughDate)
        .map(item => ({ planId: plan.id, cardId: plan.cardId, ...item }));
    }).sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  }

  adjustBatch({ id = randomUUID(), date, reason, entries }) {
    assertDate(date);
    if (!reason?.trim() || !Array.isArray(entries) || entries.length === 0) {
      throw new Error('Adjustment needs a reason and at least one entry');
    }
    const batch = { id, date, reason, entryIds: entries.map((_, i) => `adjust:${id}:${i + 1}`) };
    const accounts = this.accounts();
    const journal = entries.map((entry, i) => ({ ...entry, id: batch.entryIds[i], date,
      kind: 'adjustment', memo: `${reason}${entry.memo ? `: ${entry.memo}` : ''}` }));
    journal.forEach(entry => validateEntry(entry, accounts));
    return this.atomic(() => {
      journal.forEach(entry => this.record(entry));
      this.db.prepare('INSERT INTO adjustment_batches (id, data) VALUES (?, ?)').run(id, JSON.stringify(batch));
      return batch;
    });
  }
}
