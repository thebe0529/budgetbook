import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { periodLockMessage, correctRejectedDate } from '../public/local-policy.js';

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
});
