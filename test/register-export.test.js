import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Book } from '../src/book.js';
import { ensureOwner, setMember } from '../src/members.js';
import { accountRegister, recordManual } from '../src/manual.js';
import { setTransactionChecked } from '../src/transaction-checks.js';
import { registerTransactionsCsv } from '../src/register-export.js';
import { manualReversalPreview, reverseManualTransaction } from '../src/manual-reversal.js';
import { compareStatement, completeStatementReview, saveStatementComparison } from '../src/statement-comparison.js';
import { lockAccountPeriod } from '../src/account-locks.js';
import { createImportApi } from '../src/import-api.js';

function setup() {
  const book = new Book(); ensureOwner(book, 'owner');
  for (const [id, name, type] of [['bank', '=은행', 'asset'], ['private', '비공개 은행', 'asset'],
    ['equity', '기초', 'equity'], ['expense', '식비', 'expense']]) book.createAccount({ id, name, type });
  setMember(book, 'owner', 'viewer', 'viewer', ['bank']);
  recordManual(book, 'owner', { requestId: randomUUID(), date: '2026-09-30', kind: 'opening',
    accountId: 'bank', counterId: 'equity', amountExpression: '10000' });
  return book;
}
const query = values => new URLSearchParams(values);
const spend = (book, date, memo, amount = '100') => recordManual(book, 'owner', { requestId: randomUUID(), date, memo,
  kind: 'expense', accountId: 'bank', counterId: 'expense', amountExpression: amount }).entry;

test('register CSV preserves full running balances, dates, memo filters and spreadsheet-safe text', () => {
  const book = setup();
  try {
    spend(book, '2026-10-01', ' =SUM(1,2) "점심"\nCafe');
    spend(book, '2026-10-02', '다른 메모', '200');
    spend(book, '2026-11-01', 'Cafe 미래');
    const csv = registerTransactionsCsv(book, 'viewer', 'bank', query({ fromDate: '2026-10-01',
      throughDate: '2026-10-31', memo: 'cafe' }));
    assert.equal(csv.charCodeAt(0), 0xFEFF);
    assert.ok(csv.endsWith('\r\n'));
    assert.ok(csv.includes('"\'=은행"'));
    assert.ok(csv.includes('"\'=SUM(1,2) ""점심""\nCafe"'));
    assert.ok(csv.includes(',-100,9900,'));
    assert.ok(!csv.includes('다른 메모'));
    assert.ok(!csv.includes('Cafe 미래'));
    assert.throws(() => registerTransactionsCsv(book, 'viewer', 'private'), /read access/);
    assert.throws(() => registerTransactionsCsv(book, 'owner', 'expense'), /Asset or liability/);
    assert.throws(() => registerTransactionsCsv(book, 'viewer', 'bank', query({ fromDate: '2026-10-02', throughDate: '2026-10-01' })), /date range/);
  } finally { book.close(); }
});

test('export contains current confirmation and cancellation links even for a prior date range', () => {
  const book = setup();
  try {
    const original = spend(book, '2026-10-01', '취소 대상');
    const row = accountRegister(book, 'owner', 'bank', '2026-10-01').rows.find(row => row.id === original.id);
    setTransactionChecked(book, 'owner', 'bank', row.id, true, row.confirmationHash);
    const reversed = reverseManualTransaction(book, 'owner', { entryId: original.id, date: '2026-11-01', reason: '오입력',
      expectedHash: manualReversalPreview(book, 'owner', original.id).expectedHash, requestId: randomUUID() }).entry;
    const checked = registerTransactionsCsv(book, 'viewer', 'bank', query({ fromDate: '2026-10-01', throughDate: '2026-10-31', status: 'checked' }));
    assert.match(checked, /확인 상태\(현재\)/);
    assert.match(checked, /취소 상태\(현재\)/);
    assert.match(checked, /취소됨 \(원거래 보존\)/);
    assert.ok(checked.includes(reversed.id));
    assert.ok(checked.includes(',-100,9900,'));
    const later = registerTransactionsCsv(book, 'viewer', 'bank', query({ fromDate: '2026-11-01', status: 'unchecked' }));
    assert.match(later, /취소 분개/);
    assert.ok(later.includes(original.id));
    assert.ok(later.includes(',100,10000,'));
  } finally { book.close(); }
});

test('register export includes current lock state for confirmed cutoff rows', () => {
  const book = setup();
  try {
    spend(book, '2026-10-01', '거래');
    for (const row of accountRegister(book, 'owner', 'bank', '2026-10-01').rows) {
      setTransactionChecked(book, 'owner', 'bank', row.id, true, row.confirmationHash);
    }
    const preview = compareStatement(book, 'owner', 'bank', '2026-10-01', '9900');
    const saved = saveStatementComparison(book, 'owner', { accountId: 'bank', throughDate: '2026-10-01',
      statementExpression: '9900', expectedHash: preview.stateHash, requestId: randomUUID() }).saved;
    completeStatementReview(book, 'owner', saved.id); lockAccountPeriod(book, 'owner', saved.id, randomUUID());
    const csv = registerTransactionsCsv(book, 'viewer', 'bank', query({ fromDate: '2026-10-01' }));
    assert.ok(csv.includes('"확인 완료"'));
    assert.ok(csv.includes('"잠금",""\r\n'));
  } finally { book.close(); }
});

test('register export HTTP returns all matched pages with scoped permissions and download headers', async () => {
  const book = setup();
  for (let i = 0; i < 205; i++) spend(book, '2026-10-01', `검색 ${i}`, '1');
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'viewer', role: 'viewer', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/register`;
  try {
    const params = query({ accountId: 'bank', fromDate: '2026-10-01', memo: '검색', status: 'unchecked', page: '2' });
    const response = await fetch(`${base}/export.csv?${params}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/csv; charset=utf-8/);
    assert.match(response.headers.get('content-disposition'), /attachment; filename="budgetbook-register.csv"/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    const csv = await response.text();
    assert.equal(csv.split('\r\n').length, 207);
    assert.ok(csv.includes('검색 0'));
    assert.ok(csv.includes('검색 204'));
    assert.ok(!csv.includes('비공개 은행'));
    const html = await (await fetch(`${base}?${params}`)).text();
    assert.match(html, /조건에 맞는 전체 거래 CSV 다운로드/);
    const exportLink = html.match(/href="(\/admin\/register\/export\.csv\?[^"]+)"/)[1];
    assert.ok(!exportLink.includes('page='));
    assert.equal((await fetch(`${base}/export.csv?accountId=private`)).status, 400);
    assert.equal((await fetch(`${base}/export.csv?accountId=bank&status=bad`)).status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});

test('HTTP register and CSV use the same filtered sort while preserving each original running balance', async () => {
  const book = setup();
  const second = spend(book, '2026-10-01', '거래 2', '40');
  const first = spend(book, '2026-10-02', '거래 1', '40');
  const tenth = spend(book, '2026-10-03', '거래 10', '80');
  const server = createImportApi(book, { auth: { session: () => ({ sub: 'viewer', role: 'viewer', csrf: 'token' }) } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}/admin/register`;
  const orders = { 'date-asc': [second, first, tenth], 'date-desc': [tenth, first, second],
    'movement-asc': [tenth, first, second], 'movement-desc': [first, second, tenth],
    'memo-asc': [first, second, tenth], 'memo-desc': [tenth, second, first] };
  try {
    for (const [sort, entries] of Object.entries(orders)) {
      const params = query({ accountId: 'bank', fromDate: '2026-10-01', memo: '거래', sort });
      const html = await (await fetch(`${base}?${params}`)).text();
      const exportLink = html.match(/href="(\/admin\/register\/export\.csv\?[^"]+)"/)[1];
      assert.ok(exportLink.includes(`sort=${sort}`));
      const csv = await (await fetch(`${base}/export.csv?${params}`)).text();
      const csvPositions = entries.map(entry => csv.indexOf(`"${entry.id}"`));
      const htmlPositions = entries.map(entry => html.indexOf(`<td>${entry.memo}\n`));
      assert.ok([...csvPositions, ...htmlPositions].every(position => position >= 0));
      assert.ok(csvPositions[0] < csvPositions[1] && csvPositions[1] < csvPositions[2]);
      assert.ok(htmlPositions[0] < htmlPositions[1] && htmlPositions[1] < htmlPositions[2]);
      assert.ok(csv.includes('"거래 2",-40,9960,'));
      assert.ok(csv.includes('"거래 1",-40,9920,'));
      assert.ok(csv.includes('"거래 10",-80,9840,'));
      assert.ok(!csv.includes('"2026-09-30"'));
      assert.match(html, /누적 잔액은 검색·정렬과 무관/);
    }
    assert.equal((await fetch(`${base}/export.csv?accountId=bank&sort=unknown`)).status, 400);
    assert.equal(book.entries().length, 4);
  } finally { await new Promise(resolve => server.close(resolve)); book.close(); }
});
