import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { assertDate, assertMonth, validateAccount, validateEntry, balanceSheet, incomeStatement,
  cashFlow, installmentSchedule, budgetSummary } from './ledger.js';

export class Book {
  constructor(filename = ':memory:') {
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS accounts (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS account_groups (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_categories (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_assignments (month TEXT NOT NULL, category_id TEXT NOT NULL,
        amount INTEGER NOT NULL, PRIMARY KEY (month, category_id));
      CREATE TABLE IF NOT EXISTS entries (id TEXT PRIMARY KEY, date TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS card_plans (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cash_schedules (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS cash_schedule_links (
        schedule_id TEXT NOT NULL, occurrence_date TEXT NOT NULL, entry_id TEXT NOT NULL UNIQUE,
        linked_at TEXT NOT NULL, PRIMARY KEY (schedule_id, occurrence_date));
      CREATE TABLE IF NOT EXISTS backup_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1), interval_days INTEGER NOT NULL DEFAULT 1,
        keep_count INTEGER NOT NULL DEFAULT 30);
      CREATE TABLE IF NOT EXISTS backup_runs (
        id TEXT PRIMARY KEY, created_at TEXT NOT NULL, filename TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS adjustment_batches (id TEXT PRIMARY KEY, data TEXT NOT NULL);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS adjustment_reversals (
      original_id TEXT PRIMARY KEY, reversal_id TEXT NOT NULL UNIQUE);`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS import_channels (
        id TEXT PRIMARY KEY, account_id TEXT NOT NULL, token_hash TEXT NOT NULL,
        name TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS import_events (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, idempotency_key TEXT NOT NULL,
        external_id TEXT, payload_hash TEXT NOT NULL, data TEXT NOT NULL,
        UNIQUE(channel_id, idempotency_key), UNIQUE(channel_id, external_id));`);
    this.db.exec(`CREATE TABLE IF NOT EXISTS user_api_keys (
        id TEXT PRIMARY KEY, user_sub TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS account_keys (
        id TEXT PRIMARY KEY, user_sub TEXT NOT NULL, account_id TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE, revoked INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS parser_rules (
        user_sub TEXT NOT NULL, account_id TEXT NOT NULL, patterns TEXT NOT NULL,
        PRIMARY KEY(user_sub, account_id));
      CREATE TABLE IF NOT EXISTS oidc_pending (
        state TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, verifier TEXT NOT NULL,
        nonce TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS user_sessions (
        token_hash TEXT PRIMARY KEY, user_sub TEXT NOT NULL, csrf TEXT NOT NULL,
        expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS family_members (
        user_sub TEXT PRIMARY KEY, role TEXT NOT NULL CHECK(role IN ('owner','editor','viewer')));
      CREATE TABLE IF NOT EXISTS member_accounts (
        user_sub TEXT NOT NULL, account_id TEXT NOT NULL,
        PRIMARY KEY(user_sub, account_id));
      CREATE TABLE IF NOT EXISTS entry_revisions (
        entry_id TEXT NOT NULL, revision INTEGER NOT NULL, data TEXT NOT NULL,
        actor_sub TEXT NOT NULL, changed_at TEXT NOT NULL,
        PRIMARY KEY(entry_id, revision));`);
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

  accountGroups() {
    return this.db.prepare('SELECT data FROM account_groups ORDER BY id').all()
      .map(row => JSON.parse(row.data));
  }

  createAccountGroup(group) {
    if (!group?.id || !group?.name || !['asset', 'liability'].includes(group.type)) {
      throw new Error('Group requires id, name and asset or liability type');
    }
    this.db.prepare('INSERT INTO account_groups (id, data) VALUES (?, ?)')
      .run(group.id, JSON.stringify(group));
    return group;
  }

  budgetCategories() {
    return new Map(this.db.prepare('SELECT data FROM budget_categories ORDER BY id').all()
      .map(row => { const c = JSON.parse(row.data); return [c.id, c]; }));
  }

  createBudgetCategory(category) {
    if (!category?.id || !category?.name) throw new Error('Budget category requires id and name');
    this.db.prepare('INSERT INTO budget_categories (id, data) VALUES (?, ?)')
      .run(category.id, JSON.stringify(category));
    return category;
  }

  entries() {
    return this.db.prepare('SELECT data FROM entries ORDER BY date, id').all()
      .map(row => JSON.parse(row.data));
  }

  createAccount(account) {
    validateAccount(account);
    if (account.groupId) {
      const group = this.accountGroups().find(g => g.id === account.groupId);
      if (!group || group.type !== account.type) throw new Error('Account group type mismatch');
    }
    this.db.prepare('INSERT INTO accounts (id, data) VALUES (?, ?)').run(account.id, JSON.stringify(account));
    return account;
  }

  record(entry) {
    validateEntry(entry, this.accounts());
    this.validateBudgetAllocations(entry);
    this.db.prepare('INSERT INTO entries (id, date, data) VALUES (?, ?, ?)')
      .run(entry.id, entry.date, JSON.stringify(entry));
    return entry;
  }

  validateBudgetAllocations(entry) {
    const accounts = this.accounts();
    const items = entry.budgetAllocations ?? [];
    if (!Array.isArray(items)) throw new Error('Budget allocations must be a list');
    if (items.length === 0) return;
    if (!entry.postings.some(p => accounts.get(p.accountId).onBudget &&
      ['asset', 'liability'].includes(accounts.get(p.accountId).type))) {
      throw new Error('Budget spending requires an on-budget account');
    }
    const expenseTotal = entry.postings.filter(p => accounts.get(p.accountId).type === 'expense')
      .reduce((n, p) => n + (p.side === 'debit' ? p.amount : -p.amount), 0);
    let allocationTotal = 0;
    const categories = this.budgetCategories();
    for (const item of items) {
      if (!categories.has(item.categoryId) || !Number.isSafeInteger(item.amount) || item.amount === 0) {
        throw new Error('Invalid budget allocation');
      }
      allocationTotal += item.amount;
    }
    if (!Number.isSafeInteger(allocationTotal) || allocationTotal !== expenseTotal) {
      throw new Error('Budget splits must equal expense postings');
    }
  }

  assignBudget(month, categoryId, amount) {
    assertMonth(month);
    if (!this.budgetCategories().has(categoryId) || !Number.isSafeInteger(amount) || amount < 0) {
      throw new Error('Invalid budget assignment');
    }
    this.db.prepare(`INSERT INTO budget_assignments (month, category_id, amount) VALUES (?, ?, ?)
      ON CONFLICT(month, category_id) DO UPDATE SET amount=excluded.amount`)
      .run(month, categoryId, amount);
  }

  budget(throughMonth) {
    const assignments = this.db.prepare('SELECT month, category_id, amount FROM budget_assignments').all()
      .map(a => ({ month: a.month, categoryId: a.category_id, amount: a.amount }));
    return budgetSummary(this.accounts(), this.entries(), this.budgetCategories(), assignments, throughMonth);
  }

  reports(fromDate, throughDate) {
    const accounts = this.accounts();
    const entries = this.entries();
    return { balanceSheet: balanceSheet(accounts, entries, throughDate),
      incomeStatement: incomeStatement(accounts, entries, fromDate, throughDate),
      cashFlow: cashFlow(accounts, entries, fromDate, throughDate) };
  }

  cardPurchase({ id = randomUUID(), date, cardId, expenseId, amount, count, firstDueDate,
    categoryId, memo = '', createdBy, payloadHash }) {
    assertDate(date);
    const accounts = this.accounts();
    if (!accounts.get(cardId)?.card || accounts.get(expenseId)?.type !== 'expense') {
      throw new Error('Card purchase requires a card liability and expense account');
    }
    const installments = installmentSchedule(amount, count, firstDueDate);
    const entry = { id: `purchase:${id}`, date, memo,
      postings: [{ accountId: expenseId, side: 'debit', amount },
        { accountId: cardId, side: 'credit', amount }],
      ...(categoryId ? { budgetAllocations: [{ categoryId, amount }] } : {}) };
    const plan = { id, purchaseEntryId: entry.id, cardId, installments,
      ...(createdBy ? { createdBy } : {}), ...(payloadHash ? { payloadHash } : {}) };
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

  adjustBatch({ id = randomUUID(), date, reason, entries, createdBy, payloadHash }) {
    assertDate(date);
    if (!reason?.trim() || !Array.isArray(entries) || entries.length === 0) {
      throw new Error('Adjustment needs a reason and at least one entry');
    }
    const batch = { id, date, reason, entryIds: entries.map((_, i) => `adjust:${id}:${i + 1}`),
      ...(createdBy ? { createdBy } : {}), ...(payloadHash ? { payloadHash } : {}) };
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
