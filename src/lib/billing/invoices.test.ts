import { describe, expect, it } from 'vitest';
import { escapeHtml, formatMinor, renderInvoiceHtml, splitInclusiveTotal, type InvoiceDetail } from './invoices';

describe('splitInclusiveTotal', () => {
  it('splits a GST-inclusive charge so the lines add up to what was paid', () => {
    for (const total of [118_000, 99_900, 1, 2, 117, 118, 999_999, 2_999_900]) {
      for (const buyer of [{ stateCode: '29', country: 'IN' }, { stateCode: '27', country: 'IN' }]) {
        const { subtotal, gst } = splitInclusiveTotal(total, '29', buyer);
        expect(subtotal + gst.cgst + gst.sgst + gst.igst).toBe(total);
        expect(subtotal).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('uses CGST+SGST in the seller state, IGST elsewhere and nothing for an export', () => {
    expect(splitInclusiveTotal(118_000, '29', { stateCode: '29', country: 'IN' })).toMatchObject({ subtotal: 100_000, gst: { kind: 'intra_state', cgst: 9_000, sgst: 9_000, igst: 0 } });
    expect(splitInclusiveTotal(118_000, '29', { stateCode: '27', country: 'IN' })).toMatchObject({ subtotal: 100_000, gst: { kind: 'inter_state', igst: 18_000, placeOfSupply: '27' } });
    expect(splitInclusiveTotal(118_000, '29', { stateCode: null, country: 'US' })).toMatchObject({ subtotal: 118_000, gst: { kind: 'export', tax: 0 } });
  });
});

describe('renderInvoiceHtml', () => {
  const invoice: InvoiceDetail = {
    id: 'i1', number: 'BX/2026-27/000001', issuedAt: '2026-11-02T10:00:00Z', periodStart: '2026-11-02T10:00:00Z', periodEnd: '2026-12-02T10:00:00Z',
    currency: 'INR', totalMinor: 118_000, status: 'paid', subtotalMinor: 100_000, cgstMinor: 9_000, sgstMinor: 9_000, igstMinor: 0,
    placeOfSupply: '29', gstin: '29ABCDE1234F1Z5', paidAt: '2026-11-02T10:00:00Z',
    billTo: { legal_name: '<script>alert(1)</script> & Co', address_line1: '1 "Main" St', city: 'Bengaluru', postal_code: '560001', country: 'IN' },
    lines: [{ description: 'Pro plan (monthly)', sac: '998314', quantity: 1, amount_minor: 100_000 }],
  };

  it('escapes every value and contains no script', () => {
    const html = renderInvoiceHtml(invoice, { name: 'Bodhinox <Pvt>', gstin: null, address: 'Line 1\nLine 2', stateCode: '29' });
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
    expect(html).toContain('Bodhinox &lt;Pvt&gt;');
    expect(html).toContain('Line 1<br>Line 2');
    expect(html).toContain('CGST @ 9%');
    expect(html).toContain('₹1,180.00');
    expect(html).not.toContain('IGST @');
  });

  it('formats paise and escapes quotes', () => {
    expect(formatMinor(1_23_456_78)).toBe('₹1,23,456.78');
    expect(formatMinor(5)).toBe('₹0.05');
    expect(escapeHtml(`"'`)).toBe('&quot;&#39;');
  });
});
