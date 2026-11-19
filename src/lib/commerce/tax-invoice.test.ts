import { describe, expect, it } from 'vitest';
import { gstinCheckChar } from '@/lib/billing/gst';
import { gstSplit } from './documents';
import { lineTaxableMinor, parseBuyerTaxIdentity, placeOfSupply, taxInvoiceSplit, toGstStateCode } from './tax-invoice';

/** A real-format GSTIN: state + PAN + entity + Z, with its check character computed. */
const make = (first14: string) => first14 + gstinCheckChar(first14);
const KARNATAKA = make('29AABCU9603R1Z'); // 29 = Karnataka
const MAHARASHTRA = '27AAPFU0939F1ZV'; // 27 = Maharashtra

describe('parseBuyerTaxIdentity', () => {
  it('accepts a valid GSTIN, upper-cases it and trims the legal name', () => {
    expect(parseBuyerTaxIdentity(` ${MAHARASHTRA.toLowerCase()} `, '  Rao   Traders ')).toEqual({ gstin: MAHARASHTRA, legal_name: 'Rao Traders' });
    expect(parseBuyerTaxIdentity(KARNATAKA, undefined)).toEqual({ gstin: KARNATAKA, legal_name: null });
  });

  it('treats an empty GSTIN as no business buyer, and refuses a name without one', () => {
    expect(parseBuyerTaxIdentity('', '')).toEqual({ gstin: null, legal_name: null });
    expect(parseBuyerTaxIdentity(undefined, null)).toEqual({ gstin: null, legal_name: null });
    expect(parseBuyerTaxIdentity('  ', 'Rao Traders')).toBeNull();
  });

  it('refuses a bad check digit, a bad state code, a bad format and wrong types', () => {
    expect(parseBuyerTaxIdentity(MAHARASHTRA.slice(0, 14) + (MAHARASHTRA[14] === 'A' ? 'B' : 'A'), null)).toBeNull();
    expect(parseBuyerTaxIdentity(make('00AABCU9603R1Z'), null)).toBeNull();
    expect(parseBuyerTaxIdentity(make('39AABCU9603R1Z'), null)).toBeNull();
    expect(parseBuyerTaxIdentity(make('29AABCU9603R1Y'), null)).toBeNull(); // 14th character must be Z
    expect(parseBuyerTaxIdentity('29AABCU9603R1Z', null)).toBeNull(); // 14 characters
    expect(parseBuyerTaxIdentity(MAHARASHTRA, 'x'.repeat(201))).toBeNull();
    expect(parseBuyerTaxIdentity(123, null)).toBeNull();
    expect(parseBuyerTaxIdentity(MAHARASHTRA, { a: 1 })).toBeNull();
  });

  it('allows the other territory (97) and centre (99) state codes', () => {
    expect(parseBuyerTaxIdentity(make('97AABCU9603R1Z'), null)?.gstin).toBe(make('97AABCU9603R1Z'));
    expect(parseBuyerTaxIdentity(make('99AABCU9603R1Z'), null)?.gstin).toBe(make('99AABCU9603R1Z'));
  });
});

describe('state codes and place of supply', () => {
  it('maps two-letter state codes and GST codes to the GST code', () => {
    expect(toGstStateCode('KA')).toBe('29');
    expect(toGstStateCode(' ka ')).toBe('29');
    expect(toGstStateCode('29')).toBe('29');
    expect(toGstStateCode('MH')).toBe('27');
    expect(toGstStateCode('ZZ')).toBeNull();
    expect(toGstStateCode('00')).toBeNull();
    expect(toGstStateCode(null)).toBeNull();
  });

  it('takes the buyer GSTIN state first, else the shipping state', () => {
    expect(placeOfSupply(MAHARASHTRA, { state_code: 'KA' })).toBe('27');
    expect(placeOfSupply(null, { state_code: 'KA' })).toBe('29');
    expect(placeOfSupply(null, null)).toBeNull();
  });
});

describe('taxInvoiceSplit', () => {
  it('splits intra-state tax into CGST + SGST that sum exactly (odd paise go to CGST)', () => {
    expect(taxInvoiceSplit(15986, 'KA', '29')).toEqual({ cgst_minor: 7993, sgst_minor: 7993, igst_minor: 0 });
    expect(taxInvoiceSplit(15985, '29', '29')).toEqual({ cgst_minor: 7993, sgst_minor: 7992, igst_minor: 0 });
    const s = taxInvoiceSplit(1, '29', '29');
    expect(s.cgst_minor + s.sgst_minor).toBe(1);
  });

  it('charges IGST across states, whatever the seller state is written as', () => {
    expect(taxInvoiceSplit(15986, 'KA', '27')).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 15986 });
    expect(taxInvoiceSplit(15986, '29', '27')).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 15986 });
  });

  it('prints no split without tax or without both states', () => {
    const none = { cgst_minor: 0, sgst_minor: 0, igst_minor: 0 };
    expect(taxInvoiceSplit(0, '29', '29')).toEqual(none);
    expect(taxInvoiceSplit(100, null, '29')).toEqual(none);
    expect(taxInvoiceSplit(100, '29', null)).toEqual(none);
  });

  it('agrees with the receipt split for the same states', () => {
    expect(taxInvoiceSplit(15986, '29', '27')).toEqual(gstSplit(15986, '29', { country: 'IN', state_code: '27' }));
    expect(taxInvoiceSplit(15985, '29', '29')).toEqual(gstSplit(15985, '29', { country: 'IN', state_code: '29' }));
  });
});

describe('lineTaxableMinor', () => {
  it('is the line total less its tax, never negative', () => {
    expect(lineTaxableMinor(99800, 15223)).toBe(84577);
    expect(lineTaxableMinor(100, 0)).toBe(100);
    expect(lineTaxableMinor(100, 500)).toBe(0);
  });
});
