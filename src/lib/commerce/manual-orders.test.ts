import { describe, expect, it } from 'vitest';
import { ManualOrderError, manualOrderId, parseManualOrder } from './manual-orders';
import { copyName, copySku } from './catalogue/products';

const CONTACT = '33333333-3333-4333-8333-333333333333';
const VARIANT = '44444444-4444-4444-8444-444444444444';
const OTHER = '55555555-5555-4555-8555-555555555555';
const REQ = '66666666-6666-4666-8666-666666666666';
const ok = (extra: Record<string, unknown> = {}) => ({ contact_id: CONTACT, client_request_id: REQ, lines: [{ variant_id: VARIANT, qty: 2 }], ...extra });
const refuses = (body: unknown) => {
  try {
    parseManualOrder(body);
  } catch (e) {
    return e instanceof ManualOrderError && e.code === 'invalid' && e.status === 400;
  }
  return false;
};

describe('parseManualOrder', () => {
  it('accepts ids and quantities only, merging repeated variants', () => {
    expect(parseManualOrder(ok({ lines: [{ variant_id: VARIANT, qty: 2 }, { variant_id: OTHER, qty: 1 }, { variant_id: VARIANT, qty: 3 }], note: '  Gift wrap  ' })))
      .toEqual({ contactId: CONTACT, clientRequestId: REQ, note: 'Gift wrap', lines: [{ variantId: VARIANT, qty: 5 }, { variantId: OTHER, qty: 1 }] });
    expect(parseManualOrder(ok({ note: '   ' })).note).toBeNull();
  });

  it('never takes a price, total or name from the browser', () => {
    expect(refuses(ok({ total_minor: 1 }))).toBe(true);
    expect(refuses(ok({ subtotal_minor: 1 }))).toBe(true);
    expect(refuses(ok({ lines: [{ variant_id: VARIANT, qty: 1, unit_price_minor: 1 }] }))).toBe(true);
    expect(refuses(ok({ lines: [{ variant_id: VARIANT, qty: 1, name: 'Free' }] }))).toBe(true);
  });

  it.each([
    ['no body', null],
    ['an array', []],
    ['a bad contact id', ok({ contact_id: 'nope' })],
    ['no request id', ok({ client_request_id: undefined })],
    ['no lines', ok({ lines: [] })],
    ['a zero quantity', ok({ lines: [{ variant_id: VARIANT, qty: 0 }] })],
    ['a fractional quantity', ok({ lines: [{ variant_id: VARIANT, qty: 1.5 }] })],
    ['a quantity over the cart limit', ok({ lines: [{ variant_id: VARIANT, qty: 100 }] })],
    ['a bad variant id', ok({ lines: [{ variant_id: 'x', qty: 1 }] })],
    ['a note that is too long', ok({ note: 'x'.repeat(2001) })],
  ])('refuses %s', (_label, body) => {
    expect(refuses(body)).toBe(true);
  });

  it('refuses a merged quantity over the cart limit', () => {
    expect(refuses(ok({ lines: [{ variant_id: VARIANT, qty: 60 }, { variant_id: VARIANT, qty: 60 }] }))).toBe(true);
  });
});

describe('manualOrderId', () => {
  it('is the same for a replayed click and differs per workspace, member and click', () => {
    const a = manualOrderId(CONTACT, VARIANT, REQ);
    expect(manualOrderId(CONTACT, VARIANT, REQ)).toBe(a);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(manualOrderId(OTHER, VARIANT, REQ)).not.toBe(a);
    expect(manualOrderId(CONTACT, OTHER, REQ)).not.toBe(a);
    expect(manualOrderId(CONTACT, VARIANT, OTHER)).not.toBe(a);
  });
});

describe('product duplicate names', () => {
  it('suffixes the SKU within 64 characters', () => {
    expect(copySku('OIL-15', 1)).toBe('OIL-15-copy');
    expect(copySku('OIL-15', 3)).toBe('OIL-15-copy3');
    const long = copySku('A'.repeat(64), 2);
    expect(long).toHaveLength(64);
    expect(long.endsWith('-copy2')).toBe(true);
  });
  it('keeps the copy name within 200 characters', () => {
    expect(copyName('Face oil')).toBe('Face oil copy');
    expect(copyName('x'.repeat(200))).toHaveLength(200);
  });
});
