import { describe, expect, it } from 'vitest';

import { csvCell, EXPORT_HEADER, orderCsvRow } from './order-export';
import { assessOrderRisk, pincodeProblem, type RiskFacts } from './order-risk';
import { parseTags, TAG_LIMITS } from './order-tags';
import type { OrderListItem } from './orders';
import { parseQuoteInput, quoteState } from './quotes';

const ID = '2f1c3a52-6d1b-4a3e-9d7a-5b1c9a0e4f10';
const VARIANT = '7a1c3a52-6d1b-4a3e-9d7a-5b1c9a0e4f11';

const calm: RiskFacts = { badCodCount: 0, codDeclined: false, burstCount: 1, address: { country: 'IN', postalCode: '560001' },
  firstOrder: false, totalMinor: 50_000, typicalMinor: 50_000 };

describe('order risk', () => {
  it('is low with no reasons for an ordinary order', () => {
    expect(assessOrderRisk(calm)).toEqual({ level: 'low', reasons: [] });
  });

  it('flags earlier bad COD orders, and two of them count double', () => {
    expect(assessOrderRisk({ ...calm, badCodCount: 1 })).toEqual({ level: 'medium', reasons: ['cod_history'] });
    expect(assessOrderRisk({ ...calm, badCodCount: 2 }).level).toBe('medium');
    expect(assessOrderRisk({ ...calm, badCodCount: 2, address: { country: 'IN', postalCode: '' } }).level).toBe('high');
  });

  it('a declined COD confirmation is medium alone and high with another reason', () => {
    expect(assessOrderRisk({ ...calm, codDeclined: true })).toEqual({ level: 'medium', reasons: ['cod_declined'] });
    expect(assessOrderRisk({ ...calm, codDeclined: true, badCodCount: 1 }).level).toBe('high');
  });

  it('flags a burst of three orders from one contact, not two', () => {
    expect(assessOrderRisk({ ...calm, burstCount: 2 }).reasons).toEqual([]);
    expect(assessOrderRisk({ ...calm, burstCount: 3 }).reasons).toEqual(['order_burst']);
  });

  it('checks Indian pincodes and leaves other countries and a not-yet-collected address alone', () => {
    expect(pincodeProblem({ country: 'IN', postalCode: '560001' })).toBeNull();
    expect(pincodeProblem({ country: 'IN', postalCode: '012345' })).toBe('pincode_invalid');
    expect(pincodeProblem({ country: 'IN', postalCode: '5600' })).toBe('pincode_invalid');
    expect(pincodeProblem({ country: 'IN', postalCode: '  ' })).toBe('pincode_missing');
    expect(pincodeProblem({ country: 'GB', postalCode: 'SW1A 1AA' })).toBeNull();
    expect(assessOrderRisk({ ...calm, address: undefined }).reasons).toEqual([]);
    expect(assessOrderRisk({ ...calm, address: { country: 'IN', postalCode: 'ABCDEF' } }).reasons).toEqual(['pincode_invalid']);
  });

  it('flags a first order far above the usual one, only with enough history and only for a first order', () => {
    const big = { ...calm, firstOrder: true, totalMinor: 150_000 };
    expect(assessOrderRisk(big).reasons).toEqual(['high_first_order']);
    expect(assessOrderRisk({ ...big, totalMinor: 149_999 }).reasons).toEqual([]);
    expect(assessOrderRisk({ ...big, typicalMinor: null }).reasons).toEqual([]);
    expect(assessOrderRisk({ ...big, firstOrder: false }).reasons).toEqual([]);
  });
});

describe('order tags', () => {
  it('trims, lower-cases and removes duplicates', () => {
    expect(parseTags(['  VIP ', 'vip', 'Gift  wrap', 'rush_1'])).toEqual(['vip', 'gift wrap', 'rush_1']);
    expect(parseTags([])).toEqual([]);
  });

  it('refuses long, empty, odd or non-string tags and more than the cap', () => {
    expect(parseTags(['x'.repeat(TAG_LIMITS.maxLength + 1)])).toBeNull();
    expect(parseTags([''])).toBeNull();
    expect(parseTags(['  '])).toBeNull();
    expect(parseTags(['=cmd|calc'])).toBeNull();
    expect(parseTags(['<b>'])).toBeNull();
    expect(parseTags([5])).toBeNull();
    expect(parseTags('vip')).toBeNull();
    expect(parseTags(Array.from({ length: TAG_LIMITS.maxTags + 1 }, (_, i) => `tag${i}`))).toBeNull();
    expect(parseTags(Array.from({ length: TAG_LIMITS.maxTags }, (_, i) => `tag${i}`))).toHaveLength(TAG_LIMITS.maxTags);
  });

  it('keeps letters from other scripts', () => {
    expect(parseTags(['도매', 'Café'])).toEqual(['도매', 'café']);
  });
});

describe('orders csv', () => {
  it.each(['=1+1', '+91 98', '-5', '@SUM(A1)', '\tx', '\rx'])('defuses %j with a single quote', (value) => {
    expect(csvCell(value)).toBe(`"'${value}"`);
  });

  it('quotes and doubles quotes, and writes empty cells', () => {
    expect(csvCell('Say "hi", ok')).toBe('"Say ""hi"", ok"');
    expect(csvCell(null)).toBe('""');
    expect(csvCell(7)).toBe('"7"');
  });

  const order = {
    id: ID, external_id: null, created_at: '2026-12-01T10:00:00.000Z', status: 'new', source: 'storefront', payment_method: 'cod',
    contact: { id: ID, name: '=HYPERLINK("x")', phone: '+919876543210' }, item_count: 2, currency: 'INR', total_minor: 123_450,
    subtotal_minor: 120_000, paid_at: null, refund_state: 'none', tags: ['vip', 'rush'], risk: { level: 'medium', reasons: ['cod_history'] },
  } as unknown as OrderListItem;

  it('writes one row per order with the columns of the header, tags joined, and never an internal note', () => {
    const row = orderCsvRow(order, false);
    expect(row.split('","').length).toBe(EXPORT_HEADER.length);
    expect(row).toContain('"\'=HYPERLINK(""x"")"');
    expect(row).toContain('"\'+919876543210"');
    expect(row).toContain('"vip rush"');
    expect(row).toContain('"1234.50"');
  });

  it('writes what the buyer asked for at checkout in its own columns, guarded against formulas', () => {
    const extras = { note: '=1+1', gift_message: 'Happy birthday', delivery_date: '2026-12-05', delivery_slot: '9am - 12pm', custom: [{ label: 'Wrap', value: 'yes' }] };
    const row = orderCsvRow({ ...order, extras } as OrderListItem, false);
    expect(row.split('","').length).toBe(EXPORT_HEADER.length);
    expect(row).toContain(`"'=1+1"`);
    expect(row).toContain('"Happy birthday","2026-12-05","9am - 12pm","Wrap: yes"');
  });

  it('masks the number for a member who cannot see it', () => {
    const row = orderCsvRow(order, true);
    expect(row).not.toContain('9876543210');
    expect(row).toContain('•');
  });
});

describe('quotes', () => {
  const body = { contact_id: ID, client_request_id: ID, lines: [{ variant_id: VARIANT, qty: 2 }], note: ' Hello ', expires_in_hours: 48 };

  it('reads ids and quantities only, and ignores a price sent by the browser', () => {
    const input = parseQuoteInput({ ...body, lines: [{ variant_id: VARIANT, qty: 2, price_minor: 1, unit_price_minor: 1 }], total_minor: 1 });
    expect(input).toEqual({ contactId: ID, clientRequestId: ID, lines: [{ variantId: VARIANT, qty: 2 }], note: 'Hello', expiresInHours: 48 });
  });

  it('defaults the expiry to a day and refuses one outside 1 hour to 7 days', () => {
    expect(parseQuoteInput({ ...body, expires_in_hours: undefined }).expiresInHours).toBe(24);
    for (const hours of [0, 169, 1.5, '24']) expect(() => parseQuoteInput({ ...body, expires_in_hours: hours })).toThrow();
  });

  it('refuses a bad contact, an empty cart, a bad quantity and a long note', () => {
    expect(() => parseQuoteInput({ ...body, contact_id: 'x' })).toThrow();
    expect(() => parseQuoteInput({ ...body, lines: [] })).toThrow();
    expect(() => parseQuoteInput({ ...body, lines: [{ variant_id: VARIANT, qty: 0 }] })).toThrow();
    expect(() => parseQuoteInput({ ...body, note: 'x'.repeat(901) })).toThrow();
    expect(() => parseQuoteInput(null)).toThrow();
  });

  it('expires exactly at its expiry time, and an order or a revoke outranks the clock', () => {
    const now = new Date('2026-12-01T12:00:00Z');
    const base = { order_id: null, revoked_at: null };
    expect(quoteState({ ...base, expires_at: new Date('2026-12-01T12:00:01Z') }, now)).toBe('open');
    expect(quoteState({ ...base, expires_at: new Date('2026-12-01T12:00:00Z') }, now)).toBe('expired');
    expect(quoteState({ order_id: ID, revoked_at: now, expires_at: new Date('2026-11-30T00:00:00Z') }, now)).toBe('ordered');
    expect(quoteState({ ...base, revoked_at: now, expires_at: new Date('2026-12-05T00:00:00Z') }, now)).toBe('revoked');
  });
});
