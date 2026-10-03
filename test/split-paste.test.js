import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSplitPaste } from '../src/split-paste.js';

const options = { counters: [{ id: 'food', name: '식비' }, { id: 'travel', name: '교통비' }],
  categories: [{ id: 'daily', name: '생활비' }], allowCategories: true };

test('split paste resolves names and IDs and validates arithmetic before replacing rows', () => {
  assert.deepEqual(parseSplitPaste('식비\t1000+200\t생활비\r\ntravel\t300\tdaily', options), [
    { counterId: 'food', amountExpression: '1000+200', categoryId: 'daily' },
    { counterId: 'travel', amountExpression: '300', categoryId: 'daily' },
  ]);
  assert.throws(() => parseSplitPaste('식비\t100\n교통비\t1/0', options), /2행/);
  assert.throws(() => parseSplitPaste('식비\t100\t생활비\n교통비\t300', options), /모든 행/);
  assert.throws(() => parseSplitPaste('식비\t100\t생활비\n교통비\t300\t생활비',
    { ...options, allowCategories: false }), /지정할 수 없습니다/);
});

test('split paste rejects ambiguity, unknown accounts, invalid row counts and code', () => {
  assert.throws(() => parseSplitPaste('식비\t100\n식비\t200', { ...options,
    counters: [...options.counters, { id: 'food2', name: '식비' }] }), /이름을 확인/);
  assert.throws(() => parseSplitPaste('알수없음\t100\n식비\t200', options), /1행/);
  assert.throws(() => parseSplitPaste('식비\t100', options), /2~50행/);
  assert.throws(() => parseSplitPaste(Array(51).fill('식비\t100').join('\n'), options), /2~50행/);
  assert.throws(() => parseSplitPaste('식비\talert(1)\n교통비\t200', options));
});
