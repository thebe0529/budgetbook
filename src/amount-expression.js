// Amount input helper. Evaluates only numbers, + - * / and parentheses.
// Rational arithmetic prevents floating-point errors before rounding to whole KRW.
function gcd(a, b) {
  a = a < 0n ? -a : a;
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
}

function fraction(n, d = 1n) {
  if (d === 0n) throw new Error('Division by zero');
  if (d < 0n) { n = -n; d = -d; }
  const divisor = gcd(n, d);
  return [n / divisor, d / divisor];
}

export function calculateAmount(input) {
  if (typeof input !== 'string' || input.length === 0 || input.length > 256) {
    throw new Error('Invalid amount expression');
  }
  const source = input.replace(/\s/g, '');
  let pos = 0;
  function expression() {
    let value = term();
    while (source[pos] === '+' || source[pos] === '-') {
      const op = source[pos++];
      const rhs = term();
      value = fraction(value[0] * rhs[1] + (op === '+' ? 1n : -1n) * rhs[0] * value[1],
        value[1] * rhs[1]);
    }
    return value;
  }
  function term() {
    let value = factor();
    while (source[pos] === '*' || source[pos] === '/') {
      const op = source[pos++];
      const rhs = factor();
      value = op === '*' ? fraction(value[0] * rhs[0], value[1] * rhs[1]) :
        fraction(value[0] * rhs[1], value[1] * rhs[0]);
    }
    return value;
  }
  function factor() {
    if (source[pos] === '+' || source[pos] === '-') {
      const sign = source[pos++];
      const value = factor();
      return [sign === '-' ? -value[0] : value[0], value[1]];
    }
    if (source[pos] === '(') {
      pos++;
      const value = expression();
      if (source[pos++] !== ')') throw new Error('Unclosed parentheses');
      return value;
    }
    const match = /^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})/.exec(source.slice(pos));
    if (!match) throw new Error('Expected a number');
    pos += match[0].length;
    const [whole, decimal = ''] = match[0].split('.');
    const denominator = 10n ** BigInt(decimal.length);
    return fraction(BigInt(whole || '0') * denominator + BigInt(decimal || '0'), denominator);
  }
  const [numerator, denominator] = expression();
  if (pos !== source.length) throw new Error('Unexpected character in amount expression');
  const rounded = (numerator < 0n ? -1n : 1n) *
    ((numerator < 0n ? -numerator : numerator) * 2n + denominator) / (2n * denominator);
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER) || rounded < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('Amount exceeds supported range');
  }
  return Number(rounded);
}
