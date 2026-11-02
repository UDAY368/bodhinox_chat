import { describe, expect, it } from 'vitest';
import { financialYear, formatInvoiceNumber } from './invoice-number';
import { usagePeriod } from './usage';

describe('financialYear', () => {
  it('runs April to March in India time', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00+05:30'))).toBe('2026-27');
    expect(financialYear(new Date('2027-03-31T23:59:59+05:30'))).toBe('2026-27');
    expect(financialYear(new Date('2026-03-31T23:59:59+05:30'))).toBe('2025-26');
    // 31 March 19:00 UTC is already 1 April in India.
    expect(financialYear(new Date('2026-03-31T19:00:00Z'))).toBe('2026-27');
    expect(financialYear(new Date('2099-06-01T00:00:00Z'))).toBe('2099-00');
  });
  it('refuses an invalid date', () => {
    expect(() => financialYear(new Date('nope'))).toThrow();
  });
});

describe('formatInvoiceNumber', () => {
  it('pads to six digits and grows past them', () => {
    expect(formatInvoiceNumber('2026-27', 123)).toBe('BX/2026-27/000123');
    expect(formatInvoiceNumber('2026-27', 1_234_567)).toBe('BX/2026-27/1234567');
  });
});

describe('usagePeriod', () => {
  it('is the calendar month in India time', () => {
    expect(usagePeriod(new Date('2026-10-31T18:29:59Z'))).toBe('2026-10');
    expect(usagePeriod(new Date('2026-10-31T18:30:00Z'))).toBe('2026-11');
  });
});
