import { describe, expect, it } from 'vitest';
import {
  documentAddress, documentNumber, escapeHtml, financialYear, gstSplit, refundTaxShare, renderCommerceDocumentHtml,
  type CommerceDocument, type DocumentLabels,
} from './documents';

describe('financialYear', () => {
  it('runs April to March in the workspace timezone', () => {
    expect(financialYear(new Date('2026-04-01T00:00:00Z'), 'UTC')).toBe('2026-27');
    expect(financialYear(new Date('2026-03-31T23:59:59Z'), 'UTC')).toBe('2025-26');
    // 31 March 19:00 UTC is already 1 April in India.
    expect(financialYear(new Date('2026-03-31T19:00:00Z'), 'Asia/Kolkata')).toBe('2026-27');
    expect(financialYear(new Date('2099-12-01T00:00:00Z'), 'UTC')).toBe('2099-00');
    expect(financialYear(new Date('2026-05-01T00:00:00Z'), 'Not/AZone')).toBe('2026-27');
  });

  it('formats numbers the documents CHECK accepts', () => {
    expect(documentNumber('RCPT', '2026-27', 12)).toMatch(/^[A-Z0-9]{1,8}\/[0-9]{4}-[0-9]{2}\/[0-9]{1,9}$/);
  });
});

describe('gstSplit', () => {
  const india = (state: string) => ({ country: 'IN', state_code: state });
  it('splits intra-state tax into CGST and SGST that sum exactly', () => {
    expect(gstSplit(15987, '29', india('29'))).toEqual({ cgst_minor: 7994, sgst_minor: 7993, igst_minor: 0 });
    expect(gstSplit(1, '29', india('29'))).toEqual({ cgst_minor: 1, sgst_minor: 0, igst_minor: 0 });
  });
  it('charges IGST between states and prints no split without both states or outside India', () => {
    expect(gstSplit(500, '29', india('27'))).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 500 });
    expect(gstSplit(500, null, india('29'))).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 0 });
    expect(gstSplit(500, '29', null)).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 0 });
    expect(gstSplit(500, '29', { country: 'US', state_code: '29' })).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 0 });
    expect(gstSplit(0, '29', india('29'))).toEqual({ cgst_minor: 0, sgst_minor: 0, igst_minor: 0 });
  });
});

describe('refundTaxShare', () => {
  it('is proportional, half-up, and exact for a full refund', () => {
    expect(refundTaxShare(104800, 104800, 15986)).toBe(15986);
    expect(refundTaxShare(20000, 104800, 15986)).toBe(3051);
    expect(refundTaxShare(100, 0, 10)).toBe(0);
    expect(refundTaxShare(100, 100, 0)).toBe(0);
    expect(refundTaxShare(0, 100, 10)).toBe(0);
  });

  it('allocates partial refunds cumulatively so the notes reverse exactly the order tax', () => {
    const notes = (parts: number[], total: number, tax: number) => {
      let prior = 0;
      return parts.map((amount) => {
        const share = refundTaxShare(amount, total, tax, prior);
        prior += amount;
        return share;
      });
    };
    // Rounding each half on its own would reverse 8 + 8 = 16 of 15.
    expect(notes([150, 150], 300, 15)).toEqual([8, 7]);
    // Rounding each third on its own would reverse 0 + 0 + 0 of 1.
    expect(notes([100, 100, 100], 300, 1)).toEqual([0, 1, 0]);
    expect(notes([20000, 30000, 54800], 104800, 15986).reduce((a, b) => a + b, 0)).toBe(15986);
    for (const parts of [[1, 1, 1, 1, 1, 1, 1], [3, 2, 2], [6, 1]]) {
      expect(notes(parts, 7, 3).reduce((a, b) => a + b, 0)).toBe(3);
    }
    // Nothing is reversed beyond the order total, and never more tax than the refund itself.
    expect(refundTaxShare(500, 300, 15, 300)).toBe(0);
    expect(refundTaxShare(1, 2, 2)).toBe(1);
  });
});

describe('documentAddress', () => {
  it('keeps the shipping fields and leaves the phone out', () => {
    expect(documentAddress({ name: ' Asha ', phone: '+91 98', line1: '1 Road', city: 'Pune', state_code: '27', extra: 'x' }))
      .toEqual({ name: 'Asha', line1: '1 Road', city: 'Pune', state_code: '27' });
    expect(documentAddress(null)).toBeNull();
    expect(documentAddress(['x'])).toBeNull();
    expect(documentAddress({ phone: '1' })).toBeNull();
  });
});

describe('renderCommerceDocumentHtml', () => {
  const labels = new Proxy({}, { get: (_t, key) => String(key) }) as DocumentLabels;
  const doc: CommerceDocument = {
    id: 'd', kind: 'receipt', number: 'VH/2026-27/1', fy: '2026-27', currency: 'INR', order_id: 'o', appointment_id: null,
    payment_id: 'p', refund_id: null,
    seller: { legal_name: 'Veda & Co', gstin: '29ABCDE1234F1Z5', address: null, state_code: '29' },
    buyer: { name: '<script>alert(1)</script>' },
    address: { line1: '"><img src=x onerror=alert(1)>' },
    line_items: [{ name: '<b>Tea</b>', sku: 'T-1', hsn_code: '0902', quantity: 2, unit_price_minor: 10000, discount_minor: 0,
      tax_rate_bps: 500, tax_minor: 952, line_total_minor: 20000 }],
    subtotal_minor: 20000, discount_minor: 0, shipping_minor: 0, cod_fee_minor: 0, tax_minor: 952, cgst_minor: 476, sgst_minor: 476,
    igst_minor: 0, total_minor: 20000, tax_inclusive: true, issued_at: '2026-11-03T10:00:00.000Z',
  };

  it('prints the cash-on-delivery fee as its own line only when there is one', () => {
    expect(renderCommerceDocumentHtml(doc, labels)).not.toContain('codFee');
    const html = renderCommerceDocumentHtml({ ...doc, cod_fee_minor: 4000, total_minor: 24000 }, labels);
    expect(html).toMatch(/<td>codFee<\/td><td class="num">[^<]*40[^<]*<\/td>/);
  });

  it('escapes every value and has no script or external resource', () => {
    const html = renderCommerceDocumentHtml(doc, labels);
    expect(html).not.toMatch(/<script|<img|onerror=alert\(1\)>/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('&lt;b&gt;Tea&lt;/b&gt;');
    expect(html).toContain('Veda &amp; Co');
    // The injected text stays text: no element carries a src or href attribute.
    expect(html).not.toMatch(/<[^>]+\s(src|href)=/);
  });

  it('titles a receipt with a GSTIN as a tax invoice and prints the split', () => {
    const html = renderCommerceDocumentHtml(doc, labels);
    expect(html).toContain('<h1>taxInvoice</h1>');
    expect(html).toContain('cgst');
    expect(html).toContain('taxIncluded');
    expect(renderCommerceDocumentHtml({ ...doc, seller: { ...doc.seller, gstin: null } }, labels)).toContain('<h1>receipt</h1>');
    expect(renderCommerceDocumentHtml({ ...doc, kind: 'credit_note' }, labels)).toContain('<h1>creditNote</h1>');
  });

  it('escapes quotes', () => {
    expect(escapeHtml(`a"b'c<&>`)).toBe('a&quot;b&#39;c&lt;&amp;&gt;');
  });
});
