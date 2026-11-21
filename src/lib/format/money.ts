/**
 * The standard money formatter for every screen (Batch 2 design foundation). Code formats money
 * with these two functions. src/lib/currency.ts formatCurrency (deal values in the runtime locale)
 * is the one older helper still in use.
 *
 * - formatMoney: amounts stored in minor units (paise, cents, yen, fils), as orders, payments and
 *   products store them. Uses the currency's own exponent (INR 2, JPY 0, KWD 3) and exact decimal
 *   strings, so no float rounding.
 * - formatMajor: the few amounts stored in major units (deal values).
 *
 * Both are total: they never throw. A missing amount gives '', a missing or malformed currency gives
 * a grouped number (with the code in front when there is one). `compact` gives "₹1.2L" / "$1.2K".
 * Without a locale, INR uses en-IN (lakh grouping) and everything else en, never the runtime default,
 * so server and browser render the same text.
 */

import { currencyExponent, minorToDecimalString } from '@/lib/commerce/money';

export interface MoneyFormatOptions {
  /** BCP 47 locale, e.g. the next-intl locale. Defaults to en-IN for INR and en otherwise. */
  locale?: string;
  /** Short form for tight spaces: "₹1.2L", "$1.2K". */
  compact?: boolean;
}

function exponentOf(code: string): number | null {
  try {
    return currencyExponent(code);
  } catch {
    return null;
  }
}

function numberFormat(locale: string | undefined, code: string, options: Intl.NumberFormatOptions): Intl.NumberFormat {
  const fallback = code === 'INR' ? 'en-IN' : 'en';
  try {
    return new Intl.NumberFormat(locale ?? fallback, options);
  } catch {
    return new Intl.NumberFormat(fallback, options);
  }
}

/** value is an exact decimal string or a finite number in major units. */
function render(value: string | number, code: string, fractionDigits: number, options: MoneyFormatOptions | undefined): string {
  const amount = value as unknown as number; // Intl formats exact decimal strings (ES2023).
  const valid = exponentOf(code) !== null;
  if (!valid) {
    const grouped = numberFormat(options?.locale, code, options?.compact
      ? { notation: 'compact', maximumFractionDigits: 1 }
      : { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits }).format(amount);
    return code ? `${code} ${grouped}` : grouped;
  }
  if (options?.compact) {
    return numberFormat(options.locale, code, { style: 'currency', currency: code, notation: 'compact', maximumFractionDigits: 1 }).format(Number(value));
  }
  return numberFormat(options?.locale, code, {
    style: 'currency', currency: code, minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits,
  }).format(amount);
}

/** Upper-cased ISO code when it is one; a malformed value is kept as typed (shown, never thrown on). */
function normaliseCode(currency: string | null | undefined): string {
  const text = typeof currency === 'string' ? currency.trim() : '';
  return exponentOf(text) === null ? text : text.toUpperCase();
}

/**
 * Format an amount held in minor units: formatMoney(123450, 'INR') → "₹1,234.50",
 * formatMoney(1500, 'JPY') → "¥1,500", formatMoney(12000000, 'INR', { compact: true }) → "₹1.2L".
 */
export function formatMoney(
  minor: number | bigint | null | undefined,
  currency: string | null | undefined,
  options?: MoneyFormatOptions,
): string {
  if (minor === null || minor === undefined) return '';
  if (typeof minor === 'number' && !Number.isFinite(minor)) return '';
  const code = normaliseCode(currency);
  const exponent = exponentOf(code) ?? 2;
  const whole = typeof minor === 'number' ? Math.round(minor) : minor;
  let value: string | number;
  try {
    // Any valid code with the same exponent gives the same digits; USD stands in for unknown codes.
    value = minorToDecimalString(whole, exponentOf(code) === null ? 'USD' : code);
  } catch {
    value = Number(whole) / 10 ** exponent; // beyond the safe-integer range: approximate, never throw
  }
  return render(value, code, exponent, options);
}

/**
 * Format an amount held in major units (deal values): formatMajor(1234, 'USD') → "$1,234",
 * formatMajor(1234.5, 'USD') → "$1,234.50". Whole amounts show no decimals.
 */
export function formatMajor(
  amount: number | null | undefined,
  currency: string | null | undefined,
  options?: MoneyFormatOptions,
): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '';
  const code = normaliseCode(currency);
  const exponent = exponentOf(code) ?? 2;
  return render(amount, code, Number.isInteger(amount) ? 0 : exponent, options);
}
