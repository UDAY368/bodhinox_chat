import { describe, expect, it } from 'vitest';
import {
  abandonedCartSkip, codConfirmButtonId, codTransition, initialCodConfirmation, isCodConfirmation, parseCodConfirmReply,
  type AbandonedCartFacts,
} from './cart-followups';
import { NOTICE_TEMPLATE_CATEGORY, NOTICE_TEMPLATE_KINDS } from './order-followup';
import { parseStoreSettings } from './store-settings';

const ORDER = '3f2b8c1e-5d4a-4e6b-9c7d-0a1b2c3d4e5f';

describe('parseCodConfirmReply', () => {
  it('reads the order and the answer of our own button ids', () => {
    expect(parseCodConfirmReply(`codc:${ORDER}:yes`)).toEqual({ orderId: ORDER, choice: 'yes' });
    expect(parseCodConfirmReply(`codc:${ORDER}:no`)).toEqual({ orderId: ORDER, choice: 'no' });
    expect(parseCodConfirmReply(codConfirmButtonId(ORDER, 'yes'))).toEqual({ orderId: ORDER, choice: 'yes' });
  });

  it('ignores every other reply id, so it falls through to the bots', () => {
    for (const id of [null, undefined, 42, '', 'qr_' + ORDER, `codc:${ORDER}`, `codc:${ORDER}:maybe`, `codc:not-a-uuid:yes`,
      `xcodc:${ORDER}:yes`, `codc:${ORDER}:yes `, `codc:${ORDER}:yes:extra`, `codc:${ORDER}:YES2`, 'codc:' + 'a'.repeat(80)])
      expect(parseCodConfirmReply(id)).toBeNull();
  });

  it('fits Meta\'s 256-character button id limit with room to spare', () => {
    expect(codConfirmButtonId(ORDER, 'yes').length).toBeLessThan(64);
  });
});

describe('codTransition', () => {
  it('only a pending confirmation can be answered', () => {
    expect(codTransition('pending', 'yes')).toBe('confirmed');
    expect(codTransition('pending', 'no')).toBe('declined');
    for (const state of ['confirmed', 'declined', null, 'other']) {
      expect(codTransition(state, 'yes')).toBeNull();
      expect(codTransition(state, 'no')).toBeNull();
    }
  });

  it('knows the three states', () => {
    expect(['pending', 'confirmed', 'declined'].every(isCodConfirmation)).toBe(true);
    expect(isCodConfirmation('cancelled')).toBe(false);
  });
});

describe('initialCodConfirmation', () => {
  it('is pending only for a COD order of a store that asks', () => {
    expect(initialCodConfirmation('cod', true)).toBe('pending');
    expect(initialCodConfirmation('cod', false)).toBeNull();
    expect(initialCodConfirmation('online', true)).toBeNull();
  });
});

describe('abandonedCartSkip', () => {
  const ready: AbandonedCartFacts = {
    delayMinutes: 60, checkoutEnabled: true, purpose: 'shop', revoked: false, expired: false, orderId: null, cartLines: 2, remindedAt: null,
  };

  it('sends for an open shop session with items, no order and no earlier reminder', () => {
    expect(abandonedCartSkip(ready)).toBeNull();
  });

  it('skips with a code for each reason', () => {
    expect(abandonedCartSkip({ ...ready, remindedAt: new Date() })).toBe('already_reminded');
    expect(abandonedCartSkip({ ...ready, purpose: 'order' })).toBe('not_shop_session');
    expect(abandonedCartSkip({ ...ready, orderId: ORDER })).toBe('order_placed');
    expect(abandonedCartSkip({ ...ready, revoked: true })).toBe('session_closed');
    expect(abandonedCartSkip({ ...ready, expired: true })).toBe('session_closed');
    expect(abandonedCartSkip({ ...ready, cartLines: 0 })).toBe('cart_empty');
    expect(abandonedCartSkip({ ...ready, delayMinutes: null })).toBe('disabled');
    expect(abandonedCartSkip({ ...ready, checkoutEnabled: false })).toBe('store_closed');
  });

  it('an order placed wins over a closed session, so the reason is the useful one', () => {
    expect(abandonedCartSkip({ ...ready, orderId: ORDER, expired: true })).toBe('order_placed');
  });
});

describe('notice kinds', () => {
  it('has a template category for the two new kinds: the reminder is marketing, the COD question is utility', () => {
    expect(NOTICE_TEMPLATE_KINDS).toEqual(expect.arrayContaining(['abandoned_cart', 'cod_confirm']));
    expect(NOTICE_TEMPLATE_CATEGORY.abandoned_cart).toBe('MARKETING');
    expect(NOTICE_TEMPLATE_CATEGORY.cod_confirm).toBe('UTILITY');
  });
});

describe('parseStoreSettings (reminder and COD confirmation)', () => {
  const base = {
    currency: 'INR', prices_include_tax: true, default_tax_rate_bps: 1800, reservation_minutes: 15, checkout_enabled: true,
    low_stock_default: 5, document_prefix: 'RCPT', return_window_days: 7,
  };

  it('keeps the stored values when a client does not send the fields', () => {
    const parsed = parseStoreSettings(base);
    expect(parsed).not.toHaveProperty('abandoned_cart_delay_minutes');
    expect(parsed).not.toHaveProperty('cod_confirm_enabled');
  });

  it('accepts 30..2880 minutes, null (off) and a boolean', () => {
    expect(parseStoreSettings({ ...base, abandoned_cart_delay_minutes: 30, cod_confirm_enabled: true }))
      .toMatchObject({ abandoned_cart_delay_minutes: 30, cod_confirm_enabled: true });
    expect(parseStoreSettings({ ...base, abandoned_cart_delay_minutes: 2880 })).toMatchObject({ abandoned_cart_delay_minutes: 2880 });
    expect(parseStoreSettings({ ...base, abandoned_cart_delay_minutes: null })).toMatchObject({ abandoned_cart_delay_minutes: null });
  });

  it('refuses a delay outside the range, a fraction and a non-boolean switch', () => {
    for (const delay of [0, 29, 2881, 60.5, '60', true])
      expect(() => parseStoreSettings({ ...base, abandoned_cart_delay_minutes: delay })).toThrow(expect.objectContaining({ code: 'invalid' }));
    expect(() => parseStoreSettings({ ...base, cod_confirm_enabled: 'yes' })).toThrow(expect.objectContaining({ code: 'invalid' }));
  });
});
