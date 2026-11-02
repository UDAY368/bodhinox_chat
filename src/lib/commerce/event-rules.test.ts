import { describe, expect, it } from 'vitest';
import { consentRefusal, isMarketingSend, isVariableMap, minimiseCommercePayload, resolveTemplateVariables } from './event-rules';

describe('commerce event payloads', () => {
  it('keeps flat scalar fields only and formats minor amounts', () => {
    const payload = minimiseCommercePayload({
      order_number: '#1001', total_minor: 123450, currency: 'INR', paid: true, note: null,
      customer: { email: 'a@b.c', address: '1 Road' }, line_items: [{ sku: 'X' }], 'Bad-Key': 'x', big: 'y'.repeat(2000),
    }, 'Asha');
    expect(payload).toEqual({
      order_number: '#1001', total_minor: 123450, currency: 'INR', paid: true, note: null,
      big: 'y'.repeat(1000), customer_name: 'Asha', total: '₹1,234.50',
    });
  });

  it('caps the number of fields and never overwrites a given formatted value', () => {
    const many = Object.fromEntries(Array.from({ length: 80 }, (_, i) => [`f${i}`, i]));
    expect(Object.keys(minimiseCommercePayload(many))).toHaveLength(50);
    expect(minimiseCommercePayload({ total_minor: 100, total: 'custom', currency: 'USD' }).total).toBe('custom');
    expect(minimiseCommercePayload({ total_minor: 100, currency: 'rupees' }).total).toBeUndefined();
  });
});

describe('template variables', () => {
  it('validates maps', () => {
    expect(isVariableMap({ 1: 'order_number', 2: 'total' })).toBe(true);
    expect(isVariableMap({ 0: 'x' })).toBe(false);
    expect(isVariableMap({ 21: 'x' })).toBe(false);
    expect(isVariableMap({ 1: 'customer.email' })).toBe(false);
    expect(isVariableMap([])).toBe(false);
  });

  it('fills variables by index and uses "-" for gaps and blanks', () => {
    const payload = { order_number: '#1001', total: '₹10.00', empty: '  ', count: 3 };
    expect(resolveTemplateVariables({ 1: 'order_number', 3: 'count', 4: 'empty', 5: 'missing' }, payload))
      .toEqual(['#1001', '-', '3', '-', '-']);
    expect(resolveTemplateVariables({}, payload)).toEqual([]);
    expect(resolveTemplateVariables('not a map', payload)).toEqual([]);
  });
});

describe('consent rule', () => {
  const existing = { blocked_at: null, opted_out_at: null, createdNow: false };
  const fresh = { ...existing, createdNow: true };
  const at = new Date();

  it('treats abandoned checkouts and marketing templates as marketing', () => {
    expect(isMarketingSend('checkout_abandoned', 'UTILITY')).toBe(true);
    expect(isMarketingSend('order_paid', 'Marketing')).toBe(true);
    expect(isMarketingSend('order_paid', 'UTILITY')).toBe(false);
  });

  it('needs a contact and never messages a blocked one', () => {
    expect(consentRefusal({ event: 'order_paid', templateCategory: 'UTILITY', contact: null })).toBe('no_phone');
    expect(consentRefusal({ event: 'order_paid', templateCategory: 'UTILITY', contact: { ...existing, blocked_at: at } })).toBe('contact_blocked');
  });

  it('sends utility templates to any unblocked contact, even an opted-out one', () => {
    expect(consentRefusal({ event: 'order_paid', templateCategory: 'UTILITY', contact: fresh })).toBeNull();
    expect(consentRefusal({ event: 'order_paid', templateCategory: 'UTILITY', contact: { ...existing, opted_out_at: at } })).toBeNull();
  });

  it('requires consent for marketing', () => {
    const marketing = { event: 'checkout_abandoned' as const, templateCategory: 'MARKETING' };
    expect(consentRefusal({ ...marketing, contact: { ...existing, opted_out_at: at }, marketingConsent: true })).toBe('contact_opted_out');
    expect(consentRefusal({ ...marketing, contact: fresh })).toBe('no_marketing_consent');
    expect(consentRefusal({ ...marketing, contact: fresh, marketingConsent: true })).toBeNull();
    expect(consentRefusal({ ...marketing, contact: existing })).toBeNull();
    expect(consentRefusal({ ...marketing, contact: existing, marketingConsent: false })).toBe('no_marketing_consent');
  });
});
