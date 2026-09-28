import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePush, validatePatterns } from '../src/push-parser.js';

const patterns = { amount: '금액\\s*([\\d,]+)', date: '(\\d{4}[-.]\\d{2}[-.]\\d{2})',
  payee: '가맹점\\s*([^\\n]+)' };

test('field-specific expressions extract structured values from app push text', async () => {
  const result = await parsePush(patterns, '2026.10.10 금액 12,000\n가맹점 카페');
  assert.deepEqual(result, { amount: 12_000, date: '2026-10-10', payee: '카페' });
  await assert.rejects(() => parsePush(patterns, '예상하지 않은 알림'), /no capture group match/);
});

test('invalid and runaway expressions fail without blocking the main thread', async () => {
  assert.throws(() => validatePatterns({ amount: '[', date: '(.*)' }), /invalid regular expression/);
  await assert.rejects(() => parsePush({ amount: '(a+)+([0-9]+)', date: '(\\d{4}-\\d{2}-\\d{2})' },
    `${'a'.repeat(5_000)}! 2026-10-10`), /timed out/);
});
