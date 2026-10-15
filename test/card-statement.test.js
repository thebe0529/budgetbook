import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { recordCardPurchase, recordCardPayment } from '../src/card-manual.js';
import { cardCancellationPreview, cancelCardPurchase, partiallyCancelCardPurchase } from '../src/card-cancellation.js';
import { refundPaidCardPurchase } from '../src/card-refund.js';
import { cardMonthlySchedule, compareCardStatement, saveCardStatementComparison, cardStatementHistory, cardStatementRowKey, cardStatementComparisonCsv } from '../src/card-statement.js';
import { createImportApi } from '../src/import-api.js';

function fixture(filename) {
  const book = new Book(filename); ensureOwner(book, 'owner');
  for (const [id, name] of [['card', '<공유 & 카드>'], ['private', '비공개 카드']]) book.createAccount({ id, name, type: 'liability', card: true, onBudget: true });
  book.createAccount({ id: 'cash', name: '비공개 출금 은행', type: 'asset', cash: true });
  book.createAccount({ id: 'expense', name: '비용', type: 'expense' });
  setMember(book, 'owner', 'editor', 'editor', ['card', 'cash']);
  setMember(book, 'owner', 'viewer', 'viewer', ['card']);
  setMember(book, 'owner', 'other', 'editor', ['card']);
  const purchase = { requestId: randomUUID(), date: '2026-10-10', cardId: 'card', expenseId: 'expense',
    amountExpression: '12000', count: '3', firstDueDate: '2026-11-25', memo: '<구매 & 메모>' };
  const plan = recordCardPurchase(book, 'editor', purchase).plan;
  recordCardPurchase(book, 'owner', { ...purchase, cardId: 'private', requestId: randomUUID(), memo: '비공개 구매' });
  return { book, plan, purchase };
}
const preview = (book, input = {}) => compareCardStatement(book, 'editor', { cardId: 'card', month: '2026-11', statementExpression: '4000', ...input });
const request = (book, input = {}) => ({ cardId: 'card', month: '2026-11', statementExpression: '4000', requestId: randomUUID(), expectedHash: preview(book).stateHash, ...input });
const pay = (book, plan, date = '2026-11-25') => recordCardPayment(book, 'editor', { planId: plan.id, index: 1, date, cashId: 'cash' });
const reduction = (book, plan, amountExpression, date) => ({ planId: plan.id, amountExpression, date, reason: '반품', requestId: randomUUID(), expectedHash: cardCancellationPreview(book, 'editor', plan.id).expectedHash });

test('monthly card comparison uses due month, includes early-paid installments and excludes other cards and cancelled purchases', () => {
  const { book, plan, purchase } = fixture();
  try {
    pay(book, plan, '2026-10-20');
    const cancelled = recordCardPurchase(book, 'editor', { ...purchase, requestId: randomUUID() }).plan;
    cancelCardPurchase(book, 'editor', reduction(book, cancelled, '12000', '2026-10-21'));
    const result = cardMonthlySchedule(book, 'viewer', 'card', '2026-11');
    assert.equal(result.scheduledTotal, 4000); assert.equal(result.paidTotal, 4000); assert.equal(result.pendingTotal, 0);
    assert.equal(result.rows.length, 1); assert.equal(result.rows[0].paymentDate, '2026-10-20');
    assert.equal(cardMonthlySchedule(book, 'viewer', 'card', '2026-10').scheduledTotal, 0);
    assert.equal(cardMonthlySchedule(book, 'viewer', 'card', '2026-12').pendingTotal, 4000);
    assert.throws(() => cardMonthlySchedule(book, 'viewer', 'private', '2026-11'), /read access/);
    assert.ok(!JSON.stringify(result).includes('비공개 출금 은행'));
  } finally { book.close(); }
});

test('fee and credit adjustments are signed comparison metadata and validate explanations and arithmetic range', () => {
  const { book } = fixture();
  try {
    const before = book.entries(); const reports = book.reports('2026-10-01', '2026-12-31');
    const matched = preview(book, { statementExpression: '4000+500-1000', adjustmentExpression: '500-1000', adjustmentReason: '수수료와 청구 차감' });
    assert.equal(matched.expectedAmount, 3500); assert.equal(matched.difference, 0);
    const saved = saveCardStatementComparison(book, 'editor', request(book, { statementExpression: '3500', adjustmentExpression: '-500', adjustmentReason: '수수료와 청구 차감' }));
    assert.equal(saved.saved.adjustmentAmount, -500);
    assert.deepEqual(book.entries(), before); assert.deepEqual(book.reports('2026-10-01', '2026-12-31'), reports);
    assert.equal(preview(book, { statementExpression: '4500' }).difference, 500);
    assert.equal(preview(book, { statementExpression: '3000' }).difference, -1000);
    for (const bad of [{ adjustmentExpression: '1' }, { adjustmentReason: 'x'.repeat(201) }, { month: '2026-13' },
      { adjustmentExpression: '9007199254740991', adjustmentReason: '범위' }, { statementExpression: '1/0' }]) assert.throws(() => preview(book, bad));
  } finally { book.close(); }
});

test('comparison snapshots retain original rows, detect payments and refunds, reject stale saves and preserve replay', () => {
  const { book, plan } = fixture();
  try {
    const input = request(book); const saved = saveCardStatementComparison(book, 'editor', input).saved;
    pay(book, plan);
    const history = cardStatementHistory(book, 'viewer', 'card', '2026-11');
    assert.equal(history[0].changed, true); assert.equal(history[0].rows[0].paidEntryId, null);
    assert.deepEqual(history[0].rows, saved.rows);
    assert.throws(() => saveCardStatementComparison(book, 'editor', { ...input, requestId: randomUUID() }), /changed/);
    assert.equal(saveCardStatementComparison(book, 'editor', input).duplicate, true);
    const next = request(book); saveCardStatementComparison(book, 'editor', next);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11')[0].changed, false);
    refundPaidCardPurchase(book, 'editor', { ...reduction(book, plan, '1000', '2026-12-01'), confirmUnpaidFirst: true });
    assert.equal(cardMonthlySchedule(book, 'viewer', 'card', '2026-11').scheduledTotal, 4000);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11')[0].changed, true);
    assert.equal(saveCardStatementComparison(book, 'editor', next).duplicate, true);
    assert.throws(() => saveCardStatementComparison(book, 'editor', { ...next, statementExpression: '4001' }), /reused/);
    assert.throws(() => saveCardStatementComparison(book, 'other', next), /reused/);
    assert.throws(() => saveCardStatementComparison(book, 'viewer', request(book)), /write access/);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-12').length, 0);
  } finally { book.close(); }
});

test('partial allocation updates monthly comparisons and zero installments disappear without fabricated ledger adjustments', () => {
  const { book, plan } = fixture();
  try {
    const input = request(book); saveCardStatementComparison(book, 'editor', input);
    partiallyCancelCardPurchase(book, 'editor', { ...reduction(book, plan, '8000', '2026-10-20'), distributionMode: 'earliest-first' });
    assert.equal(cardMonthlySchedule(book, 'viewer', 'card', '2026-11').rows.length, 0);
    assert.equal(cardMonthlySchedule(book, 'viewer', 'card', '2026-12').scheduledTotal, 0);
    assert.equal(cardMonthlySchedule(book, 'viewer', 'card', '2027-01').scheduledTotal, 4000);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11')[0].changed, true);
    assert.equal(book.entries().length, 3);
  } finally { book.close(); }
});

test('comparison audit failure rolls back and snapshots, permissions and request receipts survive reopen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'card-statement-')); let book;
  try {
    const setup = fixture(join(dir, 'book.sqlite')); book = setup.book;
    const input = request(book, { reviewedRows: [cardStatementRowKey(preview(book).rows[0])] });
    book.db.exec("CREATE TRIGGER fail_card_comparison BEFORE INSERT ON card_statement_comparisons BEGIN SELECT RAISE(ABORT, 'comparison failure'); END");
    assert.throws(() => saveCardStatementComparison(book, 'editor', input), /comparison failure/);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11').length, 0); assert.equal(book.entries().length, 2);
    book.db.exec('DROP TRIGGER fail_card_comparison'); saveCardStatementComparison(book, 'editor', input);
    book.close(); book = new Book(join(dir, 'book.sqlite'));
    assert.equal(saveCardStatementComparison(book, 'editor', input).duplicate, true);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11')[0].changed, false);
    assert.deepEqual(cardStatementHistory(book, 'viewer', 'card', '2026-11')[0].reviewedRows, input.reviewedRows);
    setMember(book, 'owner', 'editor', 'editor', []);
    assert.throws(() => saveCardStatementComparison(book, 'editor', input), /write access/);
    setMember(book, 'owner', 'viewer', 'viewer', []);
    assert.throws(() => cardStatementHistory(book, 'viewer', 'card', '2026-11'), /read access/);
  } finally { book?.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('HTTP monthly comparison protects private cards, escapes live and saved details and enforces CSRF and stale-state checks', async () => {
  const { book, plan } = fixture(); let sub = 'editor';
  const server = createImportApi(book, { auth: { session: () => ({ sub, role: sub, csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/cards`;
  try {
    const rowKey = cardStatementRowKey(preview(book).rows[0]);
    const data = { ...request(book), csrf: 'token', adjustmentExpression: '0', adjustmentReason: '<조정 & 확인>', reviewedRow: rowKey };
    const get = query => fetch(`${base}/statement?${new URLSearchParams(query)}`);
    const post = values => fetch(`${base}/statement`, { method: 'POST', body: new URLSearchParams(values) });
    const count = book.db.prepare('SELECT total_changes() AS n').get().n;
    const html = await (await get({ cardId: 'card', month: '2026-11', statementExpression: '4000' })).text();
    assert.match(html, /금액 일치/); assert.match(html, /&lt;공유 &amp; 카드&gt;/); assert.match(html, /&lt;구매 &amp; 메모&gt;/);
    assert.match(html, /type="checkbox" name="reviewedRow"/); assert.doesNotMatch(html, / checked/);
    assert.doesNotMatch(html, /비공개 출금 은행|비공개 카드|비공개 구매/);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, count);
    assert.equal((await get({ cardId: 'private', month: '2026-11' })).status, 400);
    assert.equal((await post({ ...data, csrf: 'bad' })).status, 403);
    assert.equal((await post({ ...data, reviewedRow: JSON.stringify(['private', 1]) })).status, 400);
    const duplicateRows = new URLSearchParams(data); duplicateRows.append('reviewedRow', rowKey);
    assert.equal((await post(duplicateRows)).status, 400);
    sub = 'viewer'; assert.equal((await post(data)).status, 400);
    const readonly = await (await get({ cardId: 'card', month: '2026-11' })).text(); assert.doesNotMatch(readonly, /method="post" action="\/admin\/cards\/statement"/);
    assert.doesNotMatch(readonly, /type="checkbox" name="reviewedRow"/);
    sub = 'editor'; const result = await post(data); assert.equal(result.status, 200);
    const savedHtml = await result.text(); assert.match(savedHtml, /&lt;조정 &amp; 확인&gt;/); assert.match(savedHtml, /회차 확인 1\/1건/);
    assert.match(savedHtml, /당시 확인한 회차 금액 4,000원 · 미확인 0건/); assert.doesNotMatch(savedHtml, / checked/);
    const downloadPath = savedHtml.match(/href="([^\"]*\/statement.csv\?[^\"]*)"/)[1];
    sub = 'viewer';
    const csvResponse = await fetch(new URL(downloadPath, base)); assert.equal(csvResponse.status, 200);
    assert.equal(csvResponse.headers.get('content-type'), 'text/csv; charset=utf-8');
    assert.equal(csvResponse.headers.get('content-disposition'), `attachment; filename="budgetbook-card-statement-${data.requestId}.csv"`);
    assert.equal(csvResponse.headers.get('cache-control'), 'no-store'); assert.equal(csvResponse.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await csvResponse.text()).replace(/^\uFEFF/, ''), cardStatementComparisonCsv(book, 'viewer', data.requestId).replace(/^\uFEFF/, ''));
    for (const comparisonId of ['', 'bad\r\nheader', randomUUID()]) assert.equal((await fetch(`${base}/statement.csv?${new URLSearchParams({ comparisonId })}`)).status, 400);
    setMember(book, 'owner', 'viewer', 'viewer', []);
    assert.equal((await fetch(new URL(downloadPath, base))).status, 400);
    sub = 'editor';
    assert.equal((await post({ ...data, reviewedRow: '' })).status, 400);
    assert.equal((await post(data)).status, 200); assert.equal(book.entries().length, 2);
    pay(book, plan); assert.equal((await post({ ...data, requestId: randomUUID() })).status, 400);
    const changed = await (await get({ cardId: 'card', month: '2026-11' })).text(); assert.match(changed, /저장 후 내역 변경됨/);
    assert.match(await (await fetch(`${base}?throughDate=2026-11-30`)).text(), /월별 청구 대사/);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('statement row reviews allow partial checks, normalize order and reject forged or duplicate selections without ledger effects', () => {
  const { book, purchase } = fixture();
  try {
    recordCardPurchase(book, 'editor', { ...purchase, requestId: randomUUID(), amountExpression: '6000' });
    const rows = preview(book).rows; const keys = rows.map(cardStatementRowKey);
    const before = book.entries(); const reports = book.reports('2026-10-01', '2026-12-31');
    const partial = saveCardStatementComparison(book, 'editor', request(book, { reviewedRows: [keys[0]] })).saved;
    assert.equal(partial.reviewedTotal, rows[0].amount); assert.equal(partial.unreviewedCount, 1);
    const input = request(book, { reviewedRows: keys });
    const full = saveCardStatementComparison(book, 'editor', input).saved;
    assert.deepEqual(full.reviewedRows, [...keys].sort()); assert.equal(full.reviewedTotal, 6000); assert.equal(full.unreviewedCount, 0);
    assert.equal(full.difference, -2000); // Row checks do not conceal a mismatched statement total.
    assert.equal(saveCardStatementComparison(book, 'editor', { ...input, reviewedRows: [...keys].reverse() }).duplicate, true);
    assert.throws(() => saveCardStatementComparison(book, 'editor', { ...input, reviewedRows: [keys[0]] }), /reused/);
    for (const reviewedRows of [null, keys[0], [keys[0], keys[0]], [JSON.stringify(['private', 1])], [JSON.stringify([rows[0].planId, 2])], [1], ['not-json']]) {
      assert.throws(() => saveCardStatementComparison(book, 'editor', request(book, { reviewedRows })), /Invalid reviewed/);
    }
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11').length, 2);
    assert.deepEqual(book.entries(), before); assert.deepEqual(book.reports('2026-10-01', '2026-12-31'), reports);
  } finally { book.close(); }
});

test('reviewed snapshot replay survives cancelled rows while new comparisons never inherit prior checks', () => {
  const { book, plan } = fixture();
  try {
    const input = request(book, { reviewedRows: [cardStatementRowKey(preview(book).rows[0])] });
    saveCardStatementComparison(book, 'editor', input);
    cancelCardPurchase(book, 'editor', reduction(book, plan, '12000', '2026-10-21'));
    assert.equal(saveCardStatementComparison(book, 'editor', input).duplicate, true);
    assert.throws(() => saveCardStatementComparison(book, 'editor', { ...input, requestId: randomUUID() }), /changed/);
    const history = cardStatementHistory(book, 'viewer', 'card', '2026-11');
    assert.equal(history[0].changed, true); assert.equal(history[0].reviewedTotal, 4000); assert.equal(history[0].unreviewedCount, 0);
    const fresh = saveCardStatementComparison(book, 'editor', request(book)).saved;
    assert.deepEqual(fresh.reviewedRows, []); assert.equal(fresh.reviewedTotal, 0); assert.equal(fresh.unreviewedCount, 0);
    assert.throws(() => saveCardStatementComparison(book, 'editor', request(book, { reviewedRows: input.reviewedRows })), /Invalid reviewed/);
  } finally { book.close(); }
});

test('legacy comparisons without row reviews retain unchecked replay and cannot acquire checks under the same request ID', () => {
  const { book } = fixture();
  try {
    const input = request(book); const { saved } = saveCardStatementComparison(book, 'editor', input);
    delete saved.reviewedRows; delete saved.reviewedTotal; delete saved.unreviewedCount;
    book.db.prepare('UPDATE card_statement_comparisons SET data = ? WHERE id = ?').run(JSON.stringify(saved), saved.id);
    assert.equal(saveCardStatementComparison(book, 'editor', input).duplicate, true);
    assert.throws(() => saveCardStatementComparison(book, 'editor', { ...input, reviewedRows: [cardStatementRowKey(saved.rows[0])] }), /reused/);
    const fresh = saveCardStatementComparison(book, 'editor', request(book)).saved;
    assert.deepEqual(fresh.reviewedRows, []); assert.equal(fresh.unreviewedCount, 1);
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11')[1].reviewedRows, undefined);
  } finally { book.close(); }
});

test('card comparison CSV preserves saved rows after payment and protects spreadsheet text without ledger writes', () => {
  const { book, plan, purchase } = fixture();
  try {
    const extra = recordCardPurchase(book, 'editor', { ...purchase, requestId: randomUUID(), memo: '=SUM(1,2)\n"구매"' }).plan;
    const input = request(book, { statementExpression: '7500', adjustmentExpression: '-500', adjustmentReason: '@SUM(1,2)\r\n"사유"',
      reviewedRows: [cardStatementRowKey({ planId: extra.id, index: 1 })] });
    saveCardStatementComparison(book, 'editor', input);
    pay(book, plan, '2026-10-20');
    const changes = book.db.prepare('SELECT total_changes() AS n').get().n; const before = book.entries();
    const csv = cardStatementComparisonCsv(book, 'viewer', input.requestId);
    assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.endsWith('\r\n'));
    assert.ok(csv.includes('"다운로드 시 내역 상태","저장 후 내역 변경됨"'));
    assert.ok(csv.includes('"비교 조정액(원)",-500')); assert.ok(csv.includes('"청구서 − 비교 기준 차이(원)",0'));
    assert.ok(csv.includes('"확인한 회차 금액(원)",4000')); assert.ok(csv.includes('"미확인 회차 수",1'));
    assert.ok(csv.includes('"\'=SUM(1,2)\n""구매"""')); assert.ok(csv.includes('"\'@SUM(1,2)\r\n""사유"""'));
    assert.ok(csv.includes(`"${extra.id}","${extra.purchaseEntryId}",1,"2026-11-25",4000`));
    assert.ok(csv.includes('"확인"')); assert.ok(csv.includes('"미확인"')); assert.ok(!csv.includes('2026-10-20'));
    assert.doesNotMatch(csv, /비공개 출금 은행|비공개 카드|비공개 구매|stateHash|purchaseHash/);
    assert.equal(book.db.prepare('SELECT total_changes() AS n').get().n, changes); assert.deepEqual(book.entries(), before);
  } finally { book.close(); }
});

test('card comparison CSV requires current access to the saved card, not just a valid comparison ID', () => {
  const { book } = fixture();
  try {
    const input = { cardId: 'private', month: '2026-11', statementExpression: '4000', requestId: randomUUID(),
      expectedHash: compareCardStatement(book, 'owner', { cardId: 'private', month: '2026-11' }).stateHash };
    saveCardStatementComparison(book, 'owner', input);
    assert.match(cardStatementComparisonCsv(book, 'owner', input.requestId), /비공개 카드/);
    assert.throws(() => cardStatementComparisonCsv(book, 'editor', input.requestId), /read access/);
    assert.throws(() => cardStatementComparisonCsv(book, 'unknown', input.requestId), /read access/);
    assert.throws(() => cardStatementComparisonCsv(book, 'owner', randomUUID()), /not found/);
    assert.throws(() => cardStatementComparisonCsv(book, 'owner', null), /Invalid/);
    setMember(book, 'owner', 'viewer', 'viewer', ['private']);
    assert.match(cardStatementComparisonCsv(book, 'viewer', input.requestId), /비공개 카드/);
    setMember(book, 'owner', 'viewer', 'viewer', []);
    assert.throws(() => cardStatementComparisonCsv(book, 'viewer', input.requestId), /read access/);
  } finally { book.close(); }
});

test('CSV exports older snapshots beyond the visible history limit, legacy unchecked rows and empty months', () => {
  const { book } = fixture();
  try {
    const first = saveCardStatementComparison(book, 'editor', request(book)).saved;
    delete first.reviewedRows; delete first.reviewedTotal; delete first.unreviewedCount;
    book.db.prepare('UPDATE card_statement_comparisons SET data = ? WHERE id = ?').run(JSON.stringify(first), first.id);
    for (let index = 0; index < 21; index++) saveCardStatementComparison(book, 'editor', request(book));
    assert.equal(cardStatementHistory(book, 'viewer', 'card', '2026-11').length, 20);
    assert.ok(!cardStatementHistory(book, 'viewer', 'card', '2026-11').some(item => item.id === first.id));
    const old = cardStatementComparisonCsv(book, 'viewer', first.id);
    assert.ok(old.includes(first.id)); assert.ok(old.includes('"확인 회차 수",0')); assert.ok(old.includes('"미확인 회차 수",1'));
    assert.ok(old.includes('"미확인"'));
    const empty = saveCardStatementComparison(book, 'editor', request(book, { month: '2027-02', statementExpression: '0',
      expectedHash: preview(book, { month: '2027-02' }).stateHash })).saved;
    const csv = cardStatementComparisonCsv(book, 'viewer', empty.id);
    assert.ok(csv.includes('"전체 회차 수",0')); assert.ok(csv.includes('"미확인 회차 수",0'));
    assert.doesNotMatch(csv, /\r\n"회차",/);
  } finally { book.close(); }
});
