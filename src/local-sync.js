import { visibleAccounts, canAccessAccount } from './members.js';
import { accountRegister, recordManual } from './manual.js';
import { editableManual, recordSplitManual, updateSplitManual } from './split-manual.js';
import { manualEditPreview, updateManualTransaction } from './manual-edit.js';

export function localSnapshot(book, sub) {
  const accounts = visibleAccounts(book, sub);
  const locks = new Map(book.db.prepare('SELECT account_id, through_date FROM account_period_locks').all()
    .map(row => [row.account_id, row.through_date]));
  const entries = new Map(book.entries().map(entry => [entry.id, entry]));
  const accountsForRegister = accounts.filter(a => ['asset', 'liability'].includes(a.type));
  return {
    subject: sub,
    accounts: accountsForRegister.map(a => {
      const register = accountRegister(book, sub, a.id, '9999-12-31');
      const lockedThroughDate = locks.get(a.id) ?? null;
      return { id: a.id, name: a.name, type: a.type,
        lockedThroughDate,
        onBudget: a.onBudget, canWrite: canAccessAccount(book, sub, a.id, 'write'),
        balance: register.balance, rows: register.rows.slice(0, 100).map(row => {
          const locked = entries.get(row.id).postings.some(p => locks.has(p.accountId) && row.date <= locks.get(p.accountId));
          const entry = !locked && row.kind === 'manual-split' && row.sourceAccountId === a.id ?
            editableManual(book, sub, row.id) : null;
          let manual = null;
          if (!locked && row.kind === 'manual' && row.sourceAccountId === a.id) {
            try {
              const preview = manualEditPreview(book, sub, row.id);
              if (['expense', 'income', 'transfer'].includes(preview.input.kind)) manual = {
                expectedHash: preview.expectedHash, manualKind: preview.input.kind,
                counterId: preview.input.counterId, amount: Number(preview.input.amountExpression),
                categoryId: preview.input.categoryId || null };
            } catch { /* No edit data without rights to the author and all original accounts. */ }
          }
          return { id: row.id, date: row.date, memo: row.memo, movement: row.movement, locked, reversalId: row.reversalId,
            balance: row.balance, ...(manual ? { manual } : {}), ...(entry ? { split: { revision: entry.revision,
              splitKind: entry.splitKind, lines: entry.postings.filter(p => p.accountId !== a.id)
                .map((p, i) => ({ counterId: p.accountId, amount: p.amount,
                  categoryId: entry.budgetAllocations?.[i]?.categoryId ?? null })) } } : {}) };
        }) };
    }),
    counterpartAccounts: [...book.accounts().values()].filter(a => ['expense', 'income'].includes(a.type) ||
      (['asset', 'liability'].includes(a.type) && canAccessAccount(book, sub, a.id, 'write')))
      .map(a => ({ id: a.id, name: a.name, type: a.type,
        lockedThroughDate: locks.get(a.id) ?? null })),
    categories: [...book.budgetCategories().values()].map(c => ({ id: c.id, name: c.name })),
  };
}

export function acceptLocalTransaction(book, sub, input) {
  if (!input || typeof input !== 'object') {
    throw new Error('Invalid local transaction');
  }
  if (input.kind === 'split') {
    return recordSplitManual(book, sub, {
      requestId: input.requestId, date: input.date, kind: input.splitKind,
      accountId: input.accountId, memo: input.memo ?? '', lines: input.lines,
    });
  }
  if (input.kind === 'split-update') {
    if (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
      throw new Error('Valid split update request ID required');
    }
    const sent = book.db.prepare('SELECT entry_id, actor_sub FROM entry_update_requests WHERE request_id = ?')
      .get(input.requestId);
    const entry = updateSplitManual(book, sub, input.entryId, input.expectedRevision, {
      updateRequestId: input.requestId, date: input.date, kind: input.splitKind,
      accountId: input.accountId, memo: input.memo ?? '', lines: input.lines,
    });
    return { entry, duplicate: Boolean(sent && sent.entry_id === input.entryId && sent.actor_sub === sub) };
  }
  if (input.kind === 'manual-update') {
    if (!['expense', 'income', 'transfer'].includes(input.manualKind)) throw new Error('Invalid local manual update type');
    return updateManualTransaction(book, sub, { entryId: input.entryId, expectedHash: input.expectedHash,
      updateRequestId: input.requestId, date: input.date, kind: input.manualKind,
      accountId: input.accountId, counterId: input.counterId, amountExpression: input.amountExpression,
      categoryId: input.categoryId || null, memo: input.memo ?? '' });
  }
  if (!['expense', 'income', 'transfer'].includes(input.kind)) throw new Error('Invalid local transaction');
  return recordManual(book, sub, {
    requestId: input.requestId, date: input.date, kind: input.kind,
    accountId: input.accountId, counterId: input.counterId,
    amountExpression: input.amountExpression, categoryId: input.categoryId || null,
    memo: input.memo ?? '',
  });
}
