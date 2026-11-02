import { describe, expect, it } from 'vitest';
import { currencyExponent, formatMoney, isCurrencyCode, minorFromDb, minorToDecimalString, MoneyError, parseMoney } from './money';

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
