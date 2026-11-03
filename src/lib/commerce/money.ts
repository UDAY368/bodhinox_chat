/**
 * Phase 6 commerce helper.
 * Money is always an integer count of the currency's minor unit (paise, cents,
 * yen, fils). Floats never hold an amount: they are only produced for display
 * by Intl, and parsing works on the decimal string, not on a float.
 */

/** ISO 4217 minor-unit exponents that differ from 2. Every other code uses 2. */
const EXPONENT_OVERRIDES: Record<string, number> = {
  // 0 decimals
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0, PYG: 0,
  RWF: 0, UGX: 0, UYI: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  // 3 decimals
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
  // 4 decimals
  CLF: 4, UYW: 4,
};

/** Largest amount accepted anywhere (fits a PostgreSQL bigint and a JS safe integer). */
export const MAX_MINOR = Number.MAX_SAFE_INTEGER;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

/** True for a three-letter upper-case ISO 4217 style code. */
export function isCurrencyCode(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

/** Number of minor-unit digits for `currency` (INR 2, JPY 0, KWD 3). */
export function currencyExponent(currency: string): number {
  const code = currency.toUpperCase();
  if (!isCurrencyCode(code)) throw new MoneyError('Invalid currency code');
  return EXPONENT_OVERRIDES[code] ?? 2;
}

function assertMinor(minor: number | bigint): bigint {
  const value = typeof minor === 'bigint' ? minor : Number.isSafeInteger(minor) ? BigInt(minor) : null;
  if (value === null) throw new MoneyError('Amount must be an integer number of minor units');
  if (value > BigInt(MAX_MINOR) || value < -BigInt(MAX_MINOR)) throw new MoneyError('Amount is out of range');
  return value;
}

/** "1234.5" style decimal string for a minor amount, exact (no float rounding). */
export function minorToDecimalString(minor: number | bigint, currency: string): string {
  const value = assertMinor(minor);
  const exponent = currencyExponent(currency);
  const negative = value < BigInt(0);
  const digits = (negative ? -value : value).toString().padStart(exponent + 1, '0');
  const whole = exponent === 0 ? digits : digits.slice(0, -exponent);
  const fraction = exponent === 0 ? '' : digits.slice(-exponent);
  return `${negative ? '-' : ''}${whole}${fraction ? `.${fraction}` : ''}`;
}

/**
 * Localised display, e.g. formatMoney(123450, 'INR', 'en-IN') → "₹1,234.50".
 * Uses the currency's own exponent so JPY shows no decimals and KWD three.
 */
export function formatMoney(minor: number | bigint, currency: string, locale = 'en'): string {
  const code = currency.toUpperCase();
  const exponent = currencyExponent(code);
  const decimal = minorToDecimalString(minor, code);
  let formatter: Intl.NumberFormat;
  try {
    formatter = new Intl.NumberFormat(locale, {
      style: 'currency', currency: code, minimumFractionDigits: exponent, maximumFractionDigits: exponent,
    });
  } catch {
    formatter = new Intl.NumberFormat('en', {
      style: 'currency', currency: code, minimumFractionDigits: exponent, maximumFractionDigits: exponent,
    });
  }
  // Intl accepts an exact decimal string (ES2023), so no float rounding is involved.
  return formatter.format(decimal as unknown as number);
}

/**
 * Parse a user-typed amount into minor units. Accepts "1234", "1234.5",
 * "1,234.50" and "₹ 1,234.50" (grouping commas and spaces and a leading currency
 * symbol are ignored; the decimal separator is "."). Rejects more decimals than
 * the currency allows, negatives and anything else ambiguous.
 */
export function parseMoney(input: string | number, currency: string): number {
  const exponent = currencyExponent(currency);
  let text = typeof input === 'number' ? String(input) : input;
  if (typeof input === 'number' && !Number.isFinite(input)) throw new MoneyError('Invalid amount');
  text = text.trim().replace(/^[^\d.-]+/, '').replace(/[,\s ]/g, '');
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) throw new MoneyError('Invalid amount');
  const [, whole, fraction = ''] = match;
  if (fraction.length > exponent) throw new MoneyError('Too many decimal places for this currency');
  const minor = BigInt(whole + fraction.padEnd(exponent, '0'));
  if (minor > BigInt(MAX_MINOR)) throw new MoneyError('Amount is out of range');
  return Number(minor);
}

/** A database bigint (Prisma returns bigint) as a safe JS number. */
export function minorFromDb(value: bigint | number | string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const big = typeof value === 'bigint' ? value : BigInt(value);
  if (big > BigInt(MAX_MINOR) || big < -BigInt(MAX_MINOR)) throw new MoneyError('Amount is out of range');
  return Number(big);
}

// ---------------------------------------------------------------------------
// Phase 8 pricing arithmetic (design E4). Exact integers only: products run in
// bigint so taxable × rate never loses precision, results are safe numbers.

function nonNegative(value: number | bigint, field: string): bigint {
  const big = typeof value === 'bigint' ? value : Number.isSafeInteger(value) ? BigInt(value) : null;
  if (big === null || big < BigInt(0)) throw new MoneyError(`${field} must be a non-negative integer`);
  return big;
}

function toSafe(value: bigint): number {
  if (value > BigInt(MAX_MINOR)) throw new MoneyError('Amount is out of range');
  return Number(value);
}

/** round(n / d) with halves rounded up, for non-negative n and positive d: (2n + d) div 2d. */
export function roundHalfUp(numerator: number | bigint, denominator: number | bigint): number {
  const n = nonNegative(numerator, 'numerator');
  const d = nonNegative(denominator, 'denominator');
  if (d === BigInt(0)) throw new MoneyError('denominator must be positive');
  return toSafe((BigInt(2) * n + d) / (BigInt(2) * d));
}

/** round(a × b / d) half up, computed exactly (e.g. tax = mulDivHalfUp(taxable, bps, 10000)). */
export function mulDivHalfUp(a: number | bigint, b: number | bigint, d: number | bigint): number {
  return roundHalfUp(nonNegative(a, 'a') * nonNegative(b, 'b'), d);
}

/**
 * Split `total` across lines in proportion to `weights` (largest remainder):
 * each share is floor(total × w / Σw), then the leftover units go one each to
 * the largest remainders, ties to the lower index. The shares always sum to
 * exactly `total`. All inputs are non-negative integers; a zero total gives
 * zeros, and a positive total needs a positive weight sum.
 */
export function allocateLargestRemainder(total: number, weights: readonly number[]): number[] {
  const t = nonNegative(total, 'total');
  const w = weights.map((x) => nonNegative(x, 'weight'));
  const sum = w.reduce((a, b) => a + b, BigInt(0));
  if (t === BigInt(0)) return w.map(() => 0);
  if (sum === BigInt(0)) throw new MoneyError('Cannot allocate across zero weights');
  const shares = w.map((x) => (t * x) / sum);
  const remainders = w.map((x, index) => ({ index, rem: (t * x) % sum }));
  let left = t - shares.reduce((a, b) => a + b, BigInt(0));
  remainders.sort((a, b) => (a.rem === b.rem ? a.index - b.index : a.rem > b.rem ? -1 : 1));
  for (const { index } of remainders) {
    if (left === BigInt(0)) break;
    shares[index] += BigInt(1);
    left -= BigInt(1);
  }
  return shares.map(toSafe);
}
