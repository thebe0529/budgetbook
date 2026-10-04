import { visibleAccounts } from './members.js';
import { accountRegister } from './manual.js';
import { compareStatement } from './statement-comparison.js';
import { accountPeriodLock } from './account-locks.js';
import { assertDate } from './ledger.js';

export function reviewOverview(book, sub, throughDate) {
  assertDate(throughDate);
  const latest = book.db.prepare(`SELECT comparisons.data, reviews.completed_at
    FROM statement_comparisons AS comparisons LEFT JOIN statement_reviews AS reviews ON reviews.comparison_id = comparisons.id
    WHERE comparisons.account_id = ? AND json_extract(comparisons.data, '$.throughDate') <= ?
    ORDER BY comparisons.saved_at DESC, comparisons.rowid DESC LIMIT 1`);
  const rows = visibleAccounts(book, sub).filter(a => ['asset', 'liability'].includes(a.type)).map(account => {
    const register = accountRegister(book, sub, account.id, throughDate);
    const record = latest.get(account.id, throughDate);
    let comparison = null;
    let status = 'none';
    if (record) {
      const saved = JSON.parse(record.data);
      const changed = compareStatement(book, sub, account.id, saved.throughDate, String(saved.statementBalance)).stateHash !== saved.stateHash;
      status = changed ? 'changed' : saved.difference !== 0 ? 'difference' : saved.uncheckedCount > 0 ? 'unchecked' :
        record.completed_at ? 'reviewed' : 'ready';
      comparison = { id: saved.id, throughDate: saved.throughDate, savedAt: saved.savedAt,
        statementBalance: saved.statementBalance, difference: saved.difference, changed,
        completedAt: record.completed_at ?? null };
    }
    const olderCutoff = comparison !== null && comparison.throughDate < throughDate;
    return { account: register.account, balance: register.balance, uncheckedCount: register.uncheckedCount,
      comparison, status, olderCutoff, needsAttention: status !== 'reviewed' || olderCutoff || register.uncheckedCount > 0,
      lockedThroughDate: accountPeriodLock(book, sub, account.id)?.throughDate ?? null };
  });
  return { throughDate, rows, attentionCount: rows.filter(row => row.needsAttention).length,
    uncheckedAccountCount: rows.filter(row => row.uncheckedCount > 0).length };
}
