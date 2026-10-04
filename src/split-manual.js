import { createHash } from 'node:crypto';
import { calculateAmount } from './amount-expression.js';
import { assertDate, validateEntry } from './ledger.js';
import { canAccessAccount, member } from './members.js';

function hash(value) { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }

function build(book, userSub, input, id, createdBy, revision) {
  const { date, kind, accountId, memo = '', lines } = input;
  assertDate(date);
  if (!canAccessAccount(book, userSub, accountId, 'write')) throw new Error('Account write access required');
  if (typeof memo !== 'string' || memo.length > 500) throw new Error('Invalid memo');
  if (!['expense', 'income', 'transfer'].includes(kind) || !Array.isArray(lines) ||
    lines.length < 2 || lines.length > 50) throw new Error('Two to fifty split rows are required');
  const accounts = book.accounts();
  const source = accounts.get(accountId);
  if (kind === 'income' && source.type !== 'asset') throw new Error('Income needs an asset account');
  if (kind === 'transfer' && source.type !== 'asset') throw new Error('Transfer needs an asset source');
  if (kind === 'expense' && !['asset', 'liability'].includes(source.type)) {
    throw new Error('Expense needs an asset or card account');
  }
  let total = 0;
  let categorized = 0;
  const postings = [];
  const budgetAllocations = [];
  const normalized = [];
  for (const line of lines) {
    const counter = accounts.get(line.counterId);
    const amount = calculateAmount(line.amountExpression);
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Split amount must be positive');
    if (!counter || (kind === 'expense' && counter.type !== 'expense') ||
      (kind === 'income' && counter.type !== 'income') ||
      (kind === 'transfer' && (!['asset', 'liability'].includes(counter.type) ||
        counter.id === source.id))) throw new Error('Invalid split counter account');
    if (kind === 'transfer' && !canAccessAccount(book, userSub, counter.id, 'write')) {
      throw new Error('Transfer destination access required');
    }
    const categoryId = line.categoryId || null;
    if (categoryId) {
      if (kind !== 'expense' || !source.onBudget || !book.budgetCategories().has(categoryId)) {
        throw new Error('Invalid split budget category');
      }
      categorized++;
      budgetAllocations.push({ categoryId, amount });
    }
    postings.push({ accountId: counter.id, side: kind === 'income' ? 'credit' : 'debit', amount });
    normalized.push({ counterId: counter.id, amount, categoryId });
    total += amount;
  }
  if (categorized !== 0 && categorized !== lines.length) {
    throw new Error('All expense splits need a budget category when any has one');
  }
  if (!Number.isSafeInteger(total)) throw new Error('Split total exceeds supported range');
  postings.push({ accountId, side: kind === 'income' ? 'debit' : 'credit', amount: total });
  const payload = { date, kind, accountId, memo: memo.trim(), lines: normalized };
  const entry = { id, date, kind: 'manual-split', splitKind: kind, sourceAccountId: accountId,
    createdBy, memo: memo.trim(), revision, payloadHash: hash(payload), postings,
    ...(budgetAllocations.length ? { budgetAllocations } : {}) };
  validateEntry(entry, accounts);
  book.validateBudgetAllocations(entry);
  return entry;
}

export function recordSplitManual(book, userSub, input) {
  if (typeof input.requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(input.requestId)) {
    throw new Error('Valid request ID required');
  }
  const entry = build(book, userSub, input, `manual:${input.requestId}`, userSub, 1);
  const old = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entry.id);
  if (old) {
    const previous = JSON.parse(old.data);
    if (previous.payloadHash !== entry.payloadHash || previous.createdBy !== userSub) {
      throw new Error('Request ID reused with different transaction');
    }
    return { entry: previous, duplicate: true };
  }
  book.record(entry);
  return { entry, duplicate: false };
}

export function editableManual(book, userSub, entryId) {
  if (book.db.prepare('SELECT 1 FROM transaction_reversals WHERE original_id = ?').get(entryId)) return null;
  const row = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(entryId);
  const entry = row && JSON.parse(row.data);
  if (!entry || entry.kind !== 'manual-split' || !entry.sourceAccountId ||
    !canAccessAccount(book, userSub, entry.sourceAccountId, 'write') ||
    (entry.createdBy !== userSub && member(book, userSub)?.role !== 'owner')) return null;
  return entry;
}

export function updateSplitManual(book, userSub, entryId, expectedRevision, input) {
  return book.atomic(() => {
    const previous = editableManual(book, userSub, entryId);
    if (!previous) throw new Error('Split transaction cannot be edited');
    const requestId = input.updateRequestId;
    if (requestId && (typeof requestId !== 'string' || !/^[0-9a-f-]{36}$/i.test(requestId))) {
      throw new Error('Valid request ID required');
    }
    const requestHash = requestId ? hash({ entryId, expectedRevision, date: input.date,
      kind: input.kind, accountId: input.accountId, memo: input.memo ?? '', lines: input.lines }) : null;
    if (requestId) {
      const sent = book.db.prepare('SELECT * FROM entry_update_requests WHERE request_id = ?').get(requestId);
      if (sent) {
        if (sent.entry_id !== entryId || sent.actor_sub !== userSub || sent.payload_hash !== requestHash) {
          throw new Error('Request ID reused with different split update');
        }
        return previous;
      }
    }
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision !== previous.revision) {
      throw new Error('Transaction changed; reload before editing');
    }
    if (previous.sourceAccountId !== input.accountId) throw new Error('Source account cannot be changed');
    // Existing transfer destinations must remain within the editor's current access.
    if (previous.splitKind === 'transfer' && previous.postings.some(p =>
      p.accountId !== previous.sourceAccountId &&
      !canAccessAccount(book, userSub, p.accountId, 'write'))) {
      throw new Error('Original transfer destination access required');
    }
    const next = build(book, userSub, input, entryId, previous.createdBy, previous.revision + 1);
    book.db.prepare(`INSERT INTO entry_revisions (entry_id, revision, data, actor_sub, changed_at)
      VALUES (?, ?, ?, ?, ?)`).run(entryId, previous.revision,
      JSON.stringify(previous), userSub, new Date().toISOString());
    book.db.prepare('UPDATE entries SET date = ?, data = ? WHERE id = ?')
      .run(next.date, JSON.stringify(next), entryId);
    if (requestId) book.db.prepare(`INSERT INTO entry_update_requests
      (request_id, entry_id, actor_sub, payload_hash, applied_revision) VALUES (?, ?, ?, ?, ?)`)
      .run(requestId, entryId, userSub, requestHash, next.revision);
    return next;
  });
}
