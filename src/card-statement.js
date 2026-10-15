import { assertMonth } from './ledger.js';
import { canAccessAccount } from './members.js';
import { calculateAmount } from './amount-expression.js';
import { entryFingerprint } from './transaction-checks.js';
import { serializeCsv } from './csv.js';

export const cardStatementRowKey = row => JSON.stringify([row.planId, row.index]);

function normalizeReviewedRows(values = [], rows) {
  const allowed = new Set(rows.map(cardStatementRowKey));
  if (!Array.isArray(values) || values.length > rows.length || values.some(value => typeof value !== 'string' || !allowed.has(value)) ||
    new Set(values).size !== values.length) throw new Error('Invalid reviewed card statement rows');
  return [...values].sort();
}

export function cardMonthlySchedule(book, sub, cardId, month) {
  assertMonth(month);
  const card = book.accounts().get(cardId);
  if (!card?.card || card.type !== 'liability' || !canAccessAccount(book, sub, cardId)) throw new Error('Card read access required');
  const rows = []; const sources = [];
  for (const record of book.db.prepare('SELECT data FROM card_plans').all()) {
    const plan = JSON.parse(record.data);
    if (plan.cardId !== cardId || plan.cancellationId) continue;
    const installments = plan.installments.filter(item => item.amount > 0 && item.dueDate.slice(0, 7) === month);
    if (!installments.length) continue;
    const original = book.db.prepare('SELECT data FROM entries WHERE id = ?').get(plan.purchaseEntryId);
    if (!original) throw new Error('Card purchase entry missing');
    const entry = JSON.parse(original.data);
    for (const item of installments) {
      const payment = item.paidEntryId && book.db.prepare('SELECT data FROM entries WHERE id = ?').get(item.paidEntryId);
      if (item.paidEntryId && !payment) throw new Error('Card payment entry missing');
      const paid = payment ? JSON.parse(payment.data) : null;
      rows.push({ planId: plan.id, purchaseEntryId: plan.purchaseEntryId, index: item.index, dueDate: item.dueDate,
        amount: item.amount, memo: entry.memo ?? '', paidEntryId: item.paidEntryId ?? null, paymentDate: paid?.date ?? null });
      sources.push({ planId: plan.id, index: item.index, purchaseHash: entryFingerprint(entry), paymentHash: paid ? entryFingerprint(paid) : null,
        refundedAmount: plan.refundedAmount ?? 0, lastRefundDate: plan.lastRefundDate ?? null, lastPartialDate: plan.lastPartialDate ?? null });
    }
  }
  rows.sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.planId.localeCompare(b.planId) || a.index - b.index);
  sources.sort((a, b) => a.planId.localeCompare(b.planId) || a.index - b.index);
  const sum = values => {
    const total = values.reduce((value, item) => value + item.amount, 0);
    if (!Number.isSafeInteger(total)) throw new Error('Card statement total exceeds supported range');
    return total;
  };
  return { card, month, rows, scheduledTotal: sum(rows), paidTotal: sum(rows.filter(row => row.paidEntryId)),
    pendingTotal: sum(rows.filter(row => !row.paidEntryId)),
    stateHash: entryFingerprint({ card, month, rows, sources }) };
}

export function compareCardStatement(book, sub, { cardId, month, statementExpression = '0', adjustmentExpression = '0', adjustmentReason = '' }) {
  const schedule = cardMonthlySchedule(book, sub, cardId, month);
  const statementAmount = calculateAmount(statementExpression);
  const adjustmentAmount = calculateAmount(adjustmentExpression);
  if (typeof adjustmentReason !== 'string' || adjustmentReason.trim().length > 200 || (adjustmentAmount !== 0 && !adjustmentReason.trim())) throw new Error('Adjustment reason required (up to 200 characters)');
  const expectedAmount = schedule.scheduledTotal + adjustmentAmount;
  const difference = statementAmount - expectedAmount;
  if (![expectedAmount, difference].every(Number.isSafeInteger)) throw new Error('Card comparison exceeds supported range');
  return { ...schedule, statementAmount, adjustmentAmount, adjustmentReason: adjustmentReason.trim(), expectedAmount, difference };
}

export function saveCardStatementComparison(book, sub, input) {
  const { cardId, month, requestId, expectedHash } = input;
  if (!canAccessAccount(book, sub, cardId, 'write')) throw new Error('Card write access required');
  if (typeof requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestId)) throw new Error('Invalid card comparison request ID');
  return book.atomic(() => {
    const comparison = compareCardStatement(book, sub, input);
    const old = book.db.prepare('SELECT data FROM card_statement_comparisons WHERE id = ?').get(requestId);
    if (old) {
      const saved = JSON.parse(old.data);
      if (saved.actor !== sub || saved.card.id !== cardId || saved.month !== month || saved.stateHash !== expectedHash ||
        saved.statementAmount !== comparison.statementAmount || saved.adjustmentAmount !== comparison.adjustmentAmount ||
        saved.adjustmentReason !== comparison.adjustmentReason) throw new Error('Card comparison request ID reused');
      // A retry refers to the saved snapshot, even if its rows have since disappeared.
      const reviewedRows = normalizeReviewedRows(input.reviewedRows, saved.rows);
      if (JSON.stringify(saved.reviewedRows ?? []) !== JSON.stringify(reviewedRows)) throw new Error('Card comparison request ID reused');
      return { saved, duplicate: true };
    }
    if (comparison.stateHash !== expectedHash) throw new Error('Card schedule changed; reload before saving comparison');
    const reviewedRows = normalizeReviewedRows(input.reviewedRows, comparison.rows);
    const reviewed = new Set(reviewedRows);
    const reviewedTotal = comparison.rows.filter(row => reviewed.has(cardStatementRowKey(row))).reduce((sum, row) => sum + row.amount, 0);
    const saved = { ...comparison, reviewedRows, reviewedTotal, unreviewedCount: comparison.rows.length - reviewedRows.length,
      id: requestId, actor: sub, savedAt: new Date().toISOString() };
    book.db.prepare('INSERT INTO card_statement_comparisons (id, card_id, month, data) VALUES (?, ?, ?, ?)')
      .run(requestId, cardId, month, JSON.stringify(saved));
    return { saved, duplicate: false };
  });
}

export function cardStatementHistory(book, sub, cardId, month) {
  const current = cardMonthlySchedule(book, sub, cardId, month);
  return book.db.prepare('SELECT data FROM card_statement_comparisons WHERE card_id = ? AND month = ? ORDER BY rowid DESC LIMIT 20')
    .all(cardId, month).map(row => { const saved = JSON.parse(row.data); return { ...saved, changed: saved.stateHash !== current.stateHash }; });
}

export const cardStatementHistoryOptions = {
  difference: [['all', '금액 차이 전체'], ['mismatch', '금액 차이 있음'], ['match', '금액 일치']],
  review: [['all', '회차 확인 전체'], ['unreviewed', '미확인 회차 있음'], ['reviewed', '미확인 회차 없음']],
  state: [['all', '내역 상태 전체'], ['changed', '저장 후 변경됨'], ['unchanged', '저장 당시 유지']]
};

export function cardStatementHistoryPage(book, sub, cardId, month, options = {}) {
  const current = cardMonthlySchedule(book, sub, cardId, month);
  const filters = Object.fromEntries(Object.entries(cardStatementHistoryOptions).map(([key, values]) => {
    const value = options[key] ?? 'all';
    if (!values.some(([allowed]) => allowed === value)) throw new Error('Invalid card comparison history filter');
    return [key, value];
  }));
  const requestedPage = String(options.page ?? '1');
  if (!/^[1-9][0-9]{0,6}$/.test(requestedPage)) throw new Error('Invalid card comparison history page');
  const clauses = ['card_id = ?', 'month = ?']; const params = [cardId, month];
  if (filters.difference !== 'all') clauses.push(`json_extract(data, '$.difference') ${filters.difference === 'match' ? '=' : '<>'} 0`);
  if (filters.review !== 'all') clauses.push(`COALESCE(json_extract(data, '$.unreviewedCount'), json_array_length(data, '$.rows')) ${filters.review === 'reviewed' ? '=' : '>'} 0`);
  if (filters.state !== 'all') {
    clauses.push(`json_extract(data, '$.stateHash') ${filters.state === 'unchanged' ? '=' : '<>'} ?`); params.push(current.stateHash);
  }
  const where = clauses.join(' AND ');
  const total = book.db.prepare(`SELECT COUNT(*) AS total FROM card_statement_comparisons WHERE ${where}`).get(...params).total;
  const pages = Math.max(1, Math.ceil(total / 20)); const page = Math.min(Number(requestedPage), pages);
  const rows = book.db.prepare(`SELECT data FROM card_statement_comparisons WHERE ${where} ORDER BY rowid DESC LIMIT 20 OFFSET ?`)
    .all(...params, (page - 1) * 20).map(row => { const saved = JSON.parse(row.data); return { ...saved, changed: saved.stateHash !== current.stateHash }; });
  return { card: current.card, month, filters, total, page, pages, rows };
}

export function cardStatementComparisonCsv(book, sub, comparisonId) {
  if (typeof comparisonId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(comparisonId)) throw new Error('Invalid card comparison ID');
  const record = book.db.prepare('SELECT data FROM card_statement_comparisons WHERE id = ?').get(comparisonId);
  if (!record) throw new Error('Card comparison not found');
  const saved = JSON.parse(record.data);
  const current = cardMonthlySchedule(book, sub, saved.card.id, saved.month);
  const reviewed = new Set(saved.reviewedRows ?? []);
  const summary = [
    ['비교 ID', saved.id], ['결제 예정 월', saved.month], ['카드 ID', saved.card.id], ['저장 당시 카드명', saved.card.name],
    ['작업자', saved.actor], ['저장 시각(UTC)', saved.savedAt],
    ['다운로드 시 내역 상태', saved.stateHash === current.stateHash ? '저장 당시 내역 유지' : '저장 후 내역 변경됨'],
    ['당시 회차 예정액(원)', saved.scheduledTotal], ['당시 납부 기록 금액(원)', saved.paidTotal], ['당시 미납 금액(원)', saved.pendingTotal],
    ['비교 조정액(원)', saved.adjustmentAmount], ['조정 사유', saved.adjustmentReason], ['비교 기준액(원)', saved.expectedAmount],
    ['실제 청구액(원)', saved.statementAmount], ['청구서 − 비교 기준 차이(원)', saved.difference],
    ['전체 회차 수', saved.rows.length], ['확인 회차 수', reviewed.size], ['미확인 회차 수', saved.unreviewedCount ?? saved.rows.length],
    ['확인한 회차 금액(원)', saved.reviewedTotal ?? 0],
    ['안내', '회차 확인은 저장 당시 수동 대조 기록입니다. 비교 조정액은 회차 확인 금액에 포함하지 않으며 원장·예산·납부를 변경하지 않습니다.']
  ];
  return serializeCsv([
    ['구분', '항목', '값', '구매 계획 ID', '원구매 분개 ID', '회차', '당시 예정일', '당시 금액(원)', '당시 메모', '당시 납부일', '당시 납부 분개 ID', '당시 청구서 대조'],
    ...summary.map(([key, value]) => ['비교 요약', key, value, ...Array(9).fill('')]),
    ...saved.rows.map(row => ['회차', '', '', row.planId, row.purchaseEntryId, row.index, row.dueDate, row.amount, row.memo,
      row.paymentDate, row.paidEntryId, reviewed.has(cardStatementRowKey(row)) ? '확인' : '미확인'])
  ]);
}
