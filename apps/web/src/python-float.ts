/**
 * @fileoverview Float arithmetic and formatting that reproduce python's results bit for bit where V8's own differ.
 *
 * Python's `math.log` and `**` call the C library, which returns the correctly rounded result in all but vanishingly
 * rare cases; V8's `Math.log` and `Math.pow` are sometimes one unit in the last place away. `crLog` and `crPow` compute
 * in 256-bit fixed point and round once. `pyFloatRepr` formats a float the way python's `repr` (and so `json.dumps`) does.
 */

const P = 256n;
const ONE = 1n << P;

/** `ln(num / den)` in fixed point, for 1 <= num/den <= 2: `2 atanh((num - den) / (num + den))`. */
function lnRatio(num: bigint, den: bigint): bigint {
  const y = ((num - den) << P) / (num + den);
  const y2 = (y * y) >> P;
  let term = y;
  let sum = 0n;
  for (let k = 1n; term !== 0n; k += 2n) {
    sum += term / k;
    term = (term * y2) >> P;
  }
  return 2n * sum;
}

const LN2 = lnRatio(2n, 1n);

/** A positive finite double as `m * 2**e` with an integer `m`. */
function rational(x: number): { m: bigint; e: number } {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  const bits = view.getBigUint64(0);
  const exponent = Number((bits >> 52n) & 0x7ffn);
  const fraction = bits & ((1n << 52n) - 1n);
  return exponent === 0 ? { m: fraction, e: -1074 } : { m: fraction | (1n << 52n), e: exponent - 1075 };
}

/** `ln(m * 2**e)` in fixed point. */
function lnFixed(m: bigint, e: number): bigint {
  const bits = m.toString(2).length;
  return BigInt(bits - 1 + e) * LN2 + lnRatio(m, 1n << BigInt(bits - 1));
}

/** A signed fixed-point value times `2**shift`, rounded once to the nearest double. */
function toDouble(fixed: bigint, shift = 0): number {
  const negative = fixed < 0n;
  let value = Number(negative ? -fixed : fixed);
  let scale = shift - Number(P);
  while (scale < -1000) {
    value *= 2 ** -1000;
    scale += 1000;
  }
  value *= 2 ** scale;
  return negative ? -value : value;
}

/** The correctly rounded natural logarithm of a positive finite double. */
export function crLog(x: number): number {
  if (!(x > 0) || !Number.isFinite(x)) return Math.log(x);
  if (x === 1) return 0;
  const { m, e } = rational(x);
  return toDouble(lnFixed(m, e));
}

/** The correctly rounded `base ** exponent` for a positive finite base and a finite exponent. */
export function crPow(base: number, exponent: number): number {
  if (exponent === 0 || base === 1) return 1;
  if (!(base > 0) || !Number.isFinite(base) || !Number.isFinite(exponent)) return Math.pow(base, exponent);
  const { m, e } = rational(base);
  const ln = lnFixed(m, e);
  const sign = exponent < 0 ? -1n : 1n;
  const { m: em, e: ee } = rational(Math.abs(exponent));
  let product = ln * em * sign;
  product = ee >= 0 ? product << BigInt(ee) : product >> BigInt(-ee);
  // exp(product) = 2**k * exp(r), |r| <= ln(2)/2
  const k = (product + LN2 / 2n) / LN2 - (product + LN2 / 2n < 0n && (product + LN2 / 2n) % LN2 !== 0n ? 1n : 0n);
  if (k > 1100n) return Infinity;
  if (k < -1200n) return 0;
  const r = product - k * LN2;
  let term = ONE;
  let sum = ONE;
  for (let i = 1n; term !== 0n; i++) {
    term = (term * r) / (i << P);
    sum += term;
  }
  return toDouble(sum, Number(k));
}

/**
 * Python's built-in `sum()` over floats (CPython 3.12 and later): Neumaier compensated summation, starting from the
 * integer 0 so the first float is taken exactly, with the compensation added at the end when it is finite.
 */
export function pySum(values: Iterable<number>): number {
  let total = 0;
  let compensation = 0;
  let first = true;
  for (const x of values) {
    if (first) {
      total = 0 + x;
      first = false;
      continue;
    }
    const t = total + x;
    compensation += Math.abs(total) >= Math.abs(x) ? total - t + x : x - t + total;
    total = t;
  }
  return compensation && Number.isFinite(compensation) ? total + compensation : total;
}

/** Python's `repr(float)`: shortest round-trip digits, fixed notation for exponents -4..15, always a fraction or exponent. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'NaN';
  if (x === Infinity) return 'Infinity';
  if (x === -Infinity) return '-Infinity';
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0';
  const [mantissa, exp] = x.toExponential().split('e');
  const exponent = Number(exp);
  const negative = mantissa.startsWith('-');
  const digits = mantissa.replace('-', '').replace('.', '');
  let body: string;
  if (exponent >= -4 && exponent < 16) {
    if (exponent < 0) body = '0.' + '0'.repeat(-exponent - 1) + digits;
    else if (digits.length <= exponent + 1) body = digits + '0'.repeat(exponent + 1 - digits.length) + '.0';
    else body = digits.slice(0, exponent + 1) + '.' + digits.slice(exponent + 1);
  } else {
    const lead = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
    body = `${lead}e${exponent < 0 ? '-' : '+'}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  return (negative ? '-' : '') + body;
}
