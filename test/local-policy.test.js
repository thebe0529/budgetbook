import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { periodLockMessage, correctRejectedDate, canCorrectRejectedDate, localTransactionInput } from '../public/local-policy.js';

const snapshot = { accounts: [{ id: 'bank', name: '은행', lockedThroughDate: '2026-10-01', rows: [
  { id: 'old', date: '2026-10-01', locked: true }, { id: 'future', date: '2026-10-02', locked: false }] }],
  counterpartAccounts: [{ id: 'card', name: '카드', lockedThroughDate: '2026-10-03' }, { id: 'food', name: '식비' }] };

test('offline policy checks source, transfer and split destinations, and original locked entries', () => {
  assert.match(periodLockMessage(snapshot, { accountId: 'bank', date: '2026-10-01', kind: 'expense' }), /2026-10-01/);
  assert.equal(periodLockMessage(snapshot, { accountId: 'bank', date: '2026-10-02', kind: 'expense' }), '');
  assert.match(periodLockMessage(snapshot, { accountId: 'bank', counterId: 'card', date: '2026-10-02', kind: 'transfer' }), /카드/);
  assert.match(periodLockMessage(snapshot, { accountId: 'bank', lines: [{ counterId: 'card' }], date: '2026-10-02', kind: 'split' }), /카드/);
  assert.match(periodLockMessage(snapshot, { accountId: 'bank', entryId: 'old', date: '2026-11-01', kind: 'split-update' }), /원거래/);
  assert.match(periodLockMessage(snapshot, { accountId: 'bank', entryId: 'future', date: '2026-10-01', kind: 'split-update' }), /잠겨/);
  assert.equal(periodLockMessage({ accounts: [{ id: 'bank', name: '구버전' }], counterpartAccounts: [] },
    { accountId: 'bank', date: '2026-10-01', kind: 'expense' }), '');
});

test('date correction keeps rejected payload intact and requires definitive rejection and a new request ID', () => {
  const item = { requestId: randomUUID(), kind: 'split', accountId: 'bank', date: '2026-10-01', memo: '원래 입력',
    lines: [{ counterId: 'food', amountExpression: '100' }, { counterId: 'food', amountExpression: '200' }],
    syncError: { code: 'PERIOD_LOCKED', message: '잠금 오류' } };
  const nextId = randomUUID();
  const corrected = correctRejectedDate(snapshot, item, '2026-10-02', nextId);
  assert.equal(corrected.date, '2026-10-02');
  assert.equal(corrected.requestId, nextId);
  assert.equal(corrected.memo, item.memo);
  assert.deepEqual(corrected.lines, item.lines);
  assert.equal(corrected.syncError, undefined);
  assert.equal(item.date, '2026-10-01');
  assert.equal(item.syncError.code, 'PERIOD_LOCKED');
  for (const date of ['2026-10-01', '2026-02-30', 'bad', '']) assert.throws(() => correctRejectedDate(snapshot, item, date, randomUUID()));
  assert.throws(() => correctRejectedDate(snapshot, item, '2026-10-02', item.requestId), /새 요청/);
  assert.throws(() => correctRejectedDate(snapshot, { ...item, syncError: null }, '2026-10-02', randomUUID()), /거절된 신규/);
  assert.throws(() => correctRejectedDate(snapshot, { ...item, kind: 'split-update' }, '2026-10-02', randomUUID()), /거절된 신규/);
  assert.throws(() => correctRejectedDate(snapshot, { ...item, kind: 'manual-update' }, '2026-10-02', randomUUID()), /거절된 신규/);
  assert.equal(canCorrectRejectedDate({ ...item, kind: 'manual-update' }), false);
  assert.equal(canCorrectRejectedDate({ ...item, kind: 'split-update' }), false);
});

test('simple edit policy checks original and replacement destinations at their respective dates', () => {
  const state = { accounts: [{ id: 'bank', name: '은행', rows: [
    { id: 'transfer', date: '2026-10-01', manual: { counterId: 'old' } },
    { id: 'expense', date: '2026-10-01', manual: { counterId: 'food' } },
    { id: 'locked', date: '2026-10-01', locked: true }] }], counterpartAccounts: [
    { id: 'old', name: '이전 상대', lockedThroughDate: '2026-10-02' },
    { id: 'new', name: '새 상대', lockedThroughDate: '2026-10-02' }, { id: 'food', name: '식비' }] };
  assert.match(periodLockMessage(state, { kind: 'manual-update', accountId: 'bank', entryId: 'locked', date: '2026-11-01' }), /원거래/);
  assert.match(periodLockMessage(state, { kind: 'manual-update', accountId: 'bank', entryId: 'transfer',
    counterId: 'new', date: '2026-11-01' }), /이전 상대/);
  assert.match(periodLockMessage(state, { kind: 'manual-update', accountId: 'bank', entryId: 'expense',
    counterId: 'new', date: '2026-10-02' }), /새 상대/);
  assert.equal(periodLockMessage(state, { kind: 'manual-update', accountId: 'bank', entryId: 'expense',
    counterId: 'new', date: '2026-11-01' }), '');
});

test('simple update payload retains editor identity and fingerprint when disabled fields are absent or altered', () => {
  const values = new FormData();
  for (const [name, value] of Object.entries({ date: '2026-10-02', counterId: 'food', amountExpression: '1000+250',
    categoryId: 'category', memo: '오프라인 수정' })) values.append(name, value);
  const editor = { type: 'manual', entryId: 'original', accountId: 'bank', manualKind: 'expense', expectedHash: 'a'.repeat(64) };
  const requestId = randomUUID();
  const result = localTransactionInput(values, editor, requestId);
  assert.deepEqual(result, { requestId, date: '2026-10-02', accountId: 'bank', memo: '오프라인 수정',
    kind: 'manual-update', manualKind: 'expense', entryId: 'original', expectedHash: 'a'.repeat(64),
    counterId: 'food', amountExpression: '1000+250', categoryId: 'category' });
  values.set('mode', 'split'); values.set('kind', 'income'); values.set('accountId', 'other');
  assert.deepEqual(localTransactionInput(values, editor, requestId), result);
  assert.throws(() => localTransactionInput(values, { ...editor, expectedHash: null }, requestId), /수정 정보/);
  assert.throws(() => localTransactionInput(values, { ...editor, manualKind: 'opening' }, requestId), /수정 정보/);
  assert.throws(() => localTransactionInput(values, { ...editor, type: 'unknown' }, requestId), /다시 선택/);
});

test('split update and new transaction payloads preserve separate field shapes and category validation', () => {
  const values = new FormData();
  values.set('date', '2026-10-02'); values.set('kind', 'expense');
  for (const amount of ['1000', '2000']) {
    values.append('splitCounterId', 'food'); values.append('splitAmount', amount); values.append('splitCategory', 'category');
  }
  const requestId = randomUUID();
  const edited = localTransactionInput(values, { type: 'split', entryId: 'original', accountId: 'bank', expectedRevision: 2 }, requestId);
  assert.equal(edited.kind, 'split-update'); assert.equal(edited.expectedRevision, 2);
  assert.equal(edited.accountId, 'bank'); assert.equal(edited.lines.length, 2); assert.equal(edited.expectedHash, undefined);
  values.set('mode', 'split'); values.set('accountId', 'bank');
  const added = localTransactionInput(values, {}, requestId);
  assert.equal(added.kind, 'split'); assert.equal(added.entryId, undefined);
  assert.deepEqual(added.lines, edited.lines);
  values.delete('splitCategory'); values.append('splitCategory', 'category'); values.append('splitCategory', '');
  assert.throws(() => localTransactionInput(values, {}, requestId), /분할 거래 행/);
  values.set('mode', 'single'); values.set('counterId', 'food'); values.set('amountExpression', '3000');
  const simple = localTransactionInput(values, {}, requestId);
  assert.equal(simple.kind, 'expense'); assert.equal(simple.amountExpression, '3000'); assert.equal(simple.lines, undefined);
});
