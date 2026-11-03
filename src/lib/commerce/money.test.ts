import { describe, expect, it } from 'vitest';
import {
  allocateLargestRemainder, currencyExponent, formatMoney, isCurrencyCode, minorFromDb, minorToDecimalString, MoneyError, mulDivHalfUp,
  parseMoney, roundHalfUp,
} from './money';

describe('money', () => {
  it('knows each currency exponent', () => {
    expect(currencyExponent('INR')).toBe(2);
    expect(currencyExponent('usd')).toBe(2);
    expect(currencyExponent('JPY')).toBe(0);
    expect(currencyExponent('KWD')).toBe(3);
    expect(() => currencyExponent('RUPEES')).toThrow(MoneyError);
    expect(isCurrencyCode('INR')).toBe(true);
    expect(isCurrencyCode('inr')).toBe(false);
  });

  it('turns minor units into an exact decimal string', () => {
    expect(minorToDecimalString(123450, 'INR')).toBe('1234.50');
    expect(minorToDecimalString(5, 'INR')).toBe('0.05');
    expect(minorToDecimalString(1500, 'JPY')).toBe('1500');
    expect(minorToDecimalString(1, 'KWD')).toBe('0.001');
    expect(minorToDecimalString(-250, 'USD')).toBe('-2.50');
    expect(() => minorToDecimalString(1.5, 'USD')).toThrow(MoneyError);
  });

  it('formats for display with the right number of decimals', () => {
    expect(formatMoney(123450, 'INR', 'en-IN')).toBe('₹1,234.50');
    expect(formatMoney(199, 'USD', 'en-US')).toBe('$1.99');
    expect(formatMoney(1500, 'JPY', 'en-US')).toMatch(/1,500$/);
    expect(formatMoney(1500, 'KWD', 'en-US')).toContain('1.500');
    // Exact beyond float precision.
    expect(formatMoney(9007199254740991, 'USD', 'en-US')).toBe('$90,071,992,547,409.91');
    // An unknown locale falls back instead of throwing.
    expect(formatMoney(100, 'USD', 'not a locale')).toBe('$1.00');
  });

  it('parses typed amounts into minor units without float error', () => {
    expect(parseMoney('1234.5', 'INR')).toBe(123450);
    expect(parseMoney('₹ 1,234.50', 'INR')).toBe(123450);
    expect(parseMoney('0.1', 'USD') + parseMoney('0.2', 'USD')).toBe(30);
    expect(parseMoney('19.99', 'USD')).toBe(1999);
    expect(parseMoney('1500', 'JPY')).toBe(1500);
    expect(parseMoney('1.234', 'KWD')).toBe(1234);
    expect(parseMoney(12, 'INR')).toBe(1200);
    expect(() => parseMoney('1.5', 'JPY')).toThrow(MoneyError);
    expect(() => parseMoney('1.999', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('-5', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('abc', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('1e5', 'USD')).toThrow(MoneyError);
    expect(() => parseMoney('99999999999999999', 'USD')).toThrow(MoneyError);
  });

  it('reads database bigints safely', () => {
    expect(minorFromDb(BigInt(123))).toBe(123);
    expect(minorFromDb(null)).toBeNull();
    expect(minorFromDb('42')).toBe(42);
    expect(() => minorFromDb(BigInt(2) ** BigInt(60))).toThrow(MoneyError);
  });
});

describe('pricing arithmetic', () => {
  it('rounds halves up, exactly', () => {
    expect(roundHalfUp(5, 10)).toBe(1);
    expect(roundHalfUp(4, 10)).toBe(0);
    expect(roundHalfUp(15, 10)).toBe(2);
    expect(roundHalfUp(0, 7)).toBe(0);
    // 18% of 999 paise = 179.82 -> 180; 5% of 10 = 0.5 -> 1.
    expect(mulDivHalfUp(999, 1800, 10000)).toBe(180);
    expect(mulDivHalfUp(10, 500, 10000)).toBe(1);
    // Inclusive: tax inside 1180 at 18% = 1180 - round(1180*10000/11800) = 180.
    expect(1180 - roundHalfUp(BigInt(1180) * BigInt(10000), 11800)).toBe(180);
    // No float loss near the safe-integer limit.
    expect(mulDivHalfUp(Number.MAX_SAFE_INTEGER, 10000, 10000)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('refuses negatives, fractions and a zero denominator', () => {
    expect(() => roundHalfUp(-1, 2)).toThrow(MoneyError);
    expect(() => roundHalfUp(1.5, 2)).toThrow(MoneyError);
    expect(() => roundHalfUp(1, 0)).toThrow(MoneyError);
    expect(() => mulDivHalfUp(Number.MAX_SAFE_INTEGER, 2, 1)).toThrow(MoneyError);
  });

  it('allocates by largest remainder so shares sum exactly, ties to the lower index', () => {
    expect(allocateLargestRemainder(100, [1, 1, 1])).toEqual([34, 33, 33]);
    expect(allocateLargestRemainder(10, [300, 700])).toEqual([3, 7]);
    expect(allocateLargestRemainder(1, [500, 500])).toEqual([1, 0]);
    expect(allocateLargestRemainder(0, [1, 2])).toEqual([0, 0]);
    expect(allocateLargestRemainder(7, [0, 5, 0])).toEqual([0, 7, 0]);
    const shares = allocateLargestRemainder(9999, [333, 1, 98765, 42]);
    expect(shares.reduce((a, b) => a + b, 0)).toBe(9999);
    expect(() => allocateLargestRemainder(5, [0, 0])).toThrow(MoneyError);
    expect(() => allocateLargestRemainder(5, [-1, 2])).toThrow(MoneyError);
  });
});
