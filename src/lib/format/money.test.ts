import { describe, expect, it } from 'vitest';

import { formatMajor, formatMoney } from './money';

describe('formatMoney (minor units)', () => {
  it('uses the currency exponent: INR 2, JPY 0, KWD 3', () => {
    expect(formatMoney(123450, 'INR')).toBe('₹1,234.50');
    expect(formatMoney(1500, 'jpy')).toBe('¥1,500');
    expect(formatMoney(1234567, 'KWD')).toMatch(/^KWD\s1,234\.567$/); // Intl puts a no-break space here
  });

  it('uses lakh grouping for INR by default and honours an explicit locale', () => {
    expect(formatMoney(1234567800, 'INR')).toBe('₹1,23,45,678.00');
    expect(formatMoney(1234567800, 'INR', { locale: 'en' })).toBe('₹12,345,678.00');
    expect(formatMoney(123450, 'USD', { locale: 'es' })).toContain('1234,50');
  });

  it('accepts bigint exactly', () => {
    expect(formatMoney(BigInt(123450), 'USD')).toBe('$1,234.50');
    expect(formatMoney(-500, 'USD')).toBe('-$5.00');
  });

  it('never throws on a missing or malformed currency', () => {
    expect(formatMoney(123450, 'BAD!')).toBe('BAD! 1,234.50');
    expect(formatMoney(123450, null)).toBe('1,234.50');
    expect(formatMoney(123450, undefined)).toBe('1,234.50');
    expect(formatMoney(123450, 'INR', { locale: 'not a locale!!' })).toBe('₹1,234.50');
  });

  it('gives an empty string for no amount', () => {
    expect(formatMoney(null, 'INR')).toBe('');
    expect(formatMoney(undefined, 'INR')).toBe('');
    expect(formatMoney(Number.NaN, 'INR')).toBe('');
  });

  it('compact form', () => {
    expect(formatMoney(12000000, 'INR', { compact: true })).toBe('₹1.2L');
    expect(formatMoney(120000, 'USD', { compact: true })).toBe('$1.2K');
    expect(formatMoney(90000, 'INR', { compact: true })).toBe('₹900');
  });
});

describe('formatMajor (major units)', () => {
  it('whole amounts without decimals, fractions with the exponent', () => {
    expect(formatMajor(1234, 'USD')).toBe('$1,234');
    expect(formatMajor(1234.5, 'USD')).toBe('$1,234.50');
  });

  it('is total', () => {
    expect(formatMajor(1234, 'United States')).toBe('United States 1,234');
    expect(formatMajor(Number.NaN, 'USD')).toBe('');
    expect(formatMajor(null, 'USD')).toBe('');
  });

  it('compact form', () => {
    expect(formatMajor(1500000, 'INR', { compact: true })).toBe('₹15L');
  });
});
