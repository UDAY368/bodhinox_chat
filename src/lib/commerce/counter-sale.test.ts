import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ManualOrderError } from './manual-orders';
import { parseCounterSale, walkInContactId } from './counter-sale';

const line = { variant_id: randomUUID(), qty: 2 };
const base = () => ({ lines: [line], method: 'cash', client_request_id: randomUUID() });

describe('parseCounterSale', () => {
  it('accepts a walk-in sale (no contact) and a named one', () => {
    const walkIn = parseCounterSale(base());
    expect(walkIn.contactId).toBeNull();
    expect(walkIn.method).toBe('cash');
    expect(walkIn.order.lines).toEqual([{ variantId: line.variant_id, qty: 2 }]);
    const contact = randomUUID();
    expect(parseCounterSale({ ...base(), contact_id: contact, method: 'upi', reference: ' 4021 ' })).toMatchObject({ contactId: contact, method: 'upi', reference: '4021' });
    expect(parseCounterSale({ ...base(), contact_id: null }).contactId).toBeNull();
  });

  it('refuses prices, other methods, a bad reference and unknown fields', () => {
    for (const extra of [{ total_minor: 1 }, { price_minor: 1 }, { method: 'card' }, { method: 'bank_transfer' }, { reference: 'x'.repeat(101) }, { reference: 'a\nb' }, { contact_id: 'nope' }, { amount: '1' }])
      expect(() => parseCounterSale({ ...base(), ...extra })).toThrow(ManualOrderError);
    expect(() => parseCounterSale({ ...base(), lines: [{ ...line, unit_price_minor: 1 }] })).toThrow(ManualOrderError);
    expect(() => parseCounterSale({ ...base(), lines: [] })).toThrow(ManualOrderError);
    expect(() => parseCounterSale(null)).toThrow(ManualOrderError);
  });
});

describe('walkInContactId', () => {
  it('is stable per workspace and differs between workspaces', () => {
    const a = randomUUID(), b = randomUUID();
    expect(walkInContactId(a)).toBe(walkInContactId(a));
    expect(walkInContactId(a)).not.toBe(walkInContactId(b));
  });
});
