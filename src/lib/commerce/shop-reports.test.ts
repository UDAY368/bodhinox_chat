import { describe, expect, it } from 'vitest';
import { ratePercent, TAX_CSV_HEADER, taxReportCsv, type TaxReport } from './shop-reports';

const report: TaxReport = {
  rates: [
    { month: '2026-11', currency: 'INR', rateBps: 500, taxableMinor: 100000, taxMinor: 5000, cgstMinor: 2500, sgstMinor: 2500, igstMinor: 0 },
    { month: '2026-11', currency: 'INR', rateBps: 1800, taxableMinor: 20000, taxMinor: 3600, cgstMinor: 0, sgstMinor: 0, igstMinor: 3600 },
    { month: '2026-11', currency: 'INR', rateBps: null, taxableMinor: 5000, taxMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 },
  ],
  months: [{ month: '2026-11', currency: 'INR', receipts: 3, taxMinor: 8700, cgstMinor: 2550, sgstMinor: 2550, igstMinor: 3600,
    creditNotes: 1, creditTaxableMinor: 10000, creditTaxMinor: 500, creditCgstMinor: 250, creditSgstMinor: 250, creditIgstMinor: 0 }],
};

describe('GST report CSV', () => {
  const lines = taxReportCsv(report).replace(/^\uFEFF/, '').trim().split('\r\n');

  it('starts with the header and a byte order mark, one row per rate, credit notes and month totals', () => {
    expect(taxReportCsv(report).startsWith('\uFEFF')).toBe(true);
    expect(lines[0]).toBe(TAX_CSV_HEADER.map((h) => `"${h}"`).join(','));
    expect(lines).toHaveLength(1 + 3 + 1 + 1);
    expect(lines[1]).toBe('"sales_by_rate","2026-11","INR","5","1000","50","25","25","0",""');
    expect(lines[2]).toBe('"sales_by_rate","2026-11","INR","18","200","36","0","0","36",""');
    expect(lines[3]).toContain('"sales_by_rate","2026-11","INR","","50","0"');
  });

  it('writes credit notes as negative amounts and the stored month totals as they are', () => {
    expect(lines[4]).toBe('"credit_notes","2026-11","INR","","-100","-5","-2.5","-2.5","0","1"');
    expect(lines[5]).toBe('"receipt_totals","2026-11","INR","","","87","25.5","25.5","36","3"');
  });

  it('defuses cells a spreadsheet would run as a formula', () => {
    const evil: TaxReport = { rates: [], months: [{ ...report.months[0], month: '=HYPERLINK("http://x")', currency: 'INR' }] };
    const text = taxReportCsv(evil);
    expect(text).toContain(`"'=HYPERLINK(""http://x"")"`);
    expect(text).not.toMatch(/,"=HYPERLINK/);
  });

  it('prints a rate as a percentage', () => {
    expect(ratePercent(1800)).toBe('18');
    expect(ratePercent(250)).toBe('2.5');
    expect(ratePercent(null)).toBe('');
  });

  it('uses the currency exponent (no decimals for a zero-decimal currency)', () => {
    const jpy: TaxReport = { rates: [{ month: '2026-11', currency: 'JPY', rateBps: 1000, taxableMinor: 1000, taxMinor: 100, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 }], months: [] };
    expect(taxReportCsv(jpy)).toContain('"1000","100"');
  });
});
