import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateAmount } from '../src/amount-expression.js';

test('amount expressions honor precedence, parentheses, negative amounts and rounding', () => {
  assert.equal(calculateAmount('10000+2500*2'), 15_000);
  assert.equal(calculateAmount('(1000 + 500) / 2'), 750);
  assert.equal(calculateAmount('-10 / 4'), -3);
  assert.equal(calculateAmount('0.1 + 0.2'), 0);
  assert.equal(calculateAmount('1 / 2'), 1);
  assert.equal(calculateAmount('1000000.125 * 4'), 4_000_001);
});

test('amount expressions reject code, division by zero and unsafe values', () => {
  assert.throws(() => calculateAmount('process.exit()'), /Expected a number/);
  assert.throws(() => calculateAmount('1 / 0'), /Division by zero/);
  assert.throws(() => calculateAmount('1 +'), /Expected a number/);
  assert.throws(() => calculateAmount('(1+2'), /Unclosed/);
  assert.throws(() => calculateAmount('9007199254740992'), /supported range/);
});
