import { describe, expect, it } from 'vitest';
import { computeGst, GstError, gstinCheckChar, isGstStateCode, sellerStateCode, validateGstin } from './gst';

const base = { sellerStateCode: '29', buyerCountry: 'IN' };

describe('computeGst', () => {
  it('splits intra-state GST into CGST 9% and SGST 9%', () => {
    expect(computeGst({ ...base, amountMinor: 99_900, buyerStateCode: '29' }))
      .toEqual({ kind: 'intra_state', cgst: 8_991, sgst: 8_991, igst: 0, tax: 17_982, placeOfSupply: '29' });
  });

  it('charges IGST 18% across states', () => {
    expect(computeGst({ ...base, amountMinor: 99_900, buyerStateCode: '27' }))
      .toEqual({ kind: 'inter_state', cgst: 0, sgst: 0, igst: 17_982, tax: 17_982, placeOfSupply: '27' });
  });

  it('zero-rates exports', () => {
    expect(computeGst({ ...base, amountMinor: 99_900, buyerCountry: 'us' }))
      .toEqual({ kind: 'export', cgst: 0, sgst: 0, igst: 0, tax: 0, placeOfSupply: null });
  });

  it('rounds each line to the nearest paisa, halves up', () => {
    // 9% of 5 paise = 0.45 -> 0; 18% = 0.9 -> 1.
    expect(computeGst({ ...base, amountMinor: 5, buyerStateCode: '29' })).toMatchObject({ cgst: 0, sgst: 0 });
    expect(computeGst({ ...base, amountMinor: 5, buyerStateCode: '07' })).toMatchObject({ igst: 1 });
    // 9% of 50 = 4.5 -> 5 (half up); 18% of 25 = 4.5 -> 5.
    expect(computeGst({ ...base, amountMinor: 50, buyerStateCode: '29' })).toMatchObject({ cgst: 5, sgst: 5, tax: 10 });
    expect(computeGst({ ...base, amountMinor: 25, buyerStateCode: '07' })).toMatchObject({ igst: 5 });
    // CGST+SGST may exceed IGST on the same amount by one paisa.
    expect(computeGst({ ...base, amountMinor: 50, buyerStateCode: '07' }).igst).toBe(9);
    expect(computeGst({ ...base, amountMinor: 0, buyerStateCode: '29' }).tax).toBe(0);
  });

  it('rejects bad input instead of guessing', () => {
    expect(() => computeGst({ ...base, amountMinor: -1, buyerStateCode: '29' })).toThrow(GstError);
    expect(() => computeGst({ ...base, amountMinor: 1.5, buyerStateCode: '29' })).toThrow(GstError);
    expect(() => computeGst({ ...base, amountMinor: 100 })).toThrow(/state code/);
    expect(() => computeGst({ ...base, amountMinor: 100, buyerStateCode: '40' })).toThrow(GstError);
    expect(() => computeGst({ ...base, sellerStateCode: 'KA', amountMinor: 100, buyerStateCode: '29' })).toThrow(/seller/);
    expect(() => computeGst({ ...base, buyerCountry: 'India', amountMinor: 100 })).toThrow(/country/);
  });
});

describe('state codes', () => {
  it('accepts 01-38, 97 and 99 only', () => {
    expect(['01', '29', '38', '97', '99'].every(isGstStateCode)).toBe(true);
    expect(['00', '39', '96', '1', 'AB', 29].some(isGstStateCode)).toBe(false);
  });
  it('reads the seller state from the environment', () => {
    expect(sellerStateCode({ BILLING_SELLER_STATE_CODE: ' 29 ' })).toBe('29');
    expect(sellerStateCode({ BILLING_SELLER_STATE_CODE: '45' })).toBeNull();
    expect(sellerStateCode({})).toBeNull();
  });
});

describe('validateGstin', () => {
  it('accepts a GSTIN with a correct check character', () => {
    expect(validateGstin('27AAPFU0939F1ZV')).toBe('27AAPFU0939F1ZV');
    expect(validateGstin(' 27aapfu0939f1zv ')).toBe('27AAPFU0939F1ZV');
    const first14 = '29ABCDE1234F1Z';
    expect(validateGstin(first14 + gstinCheckChar(first14))).toBe(first14 + gstinCheckChar(first14));
  });
  it('rejects a wrong check character, format or state', () => {
    expect(validateGstin('27AAPFU0939F1ZA')).toBeNull();
    expect(validateGstin('27AAPFU0939F1Z')).toBeNull();
    expect(validateGstin('27AAPFU0939F1YV')).toBeNull();
    const first14 = '45ABCDE1234F1Z';
    expect(validateGstin(first14 + gstinCheckChar(first14))).toBeNull();
    expect(validateGstin(null)).toBeNull();
  });
});
