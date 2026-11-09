import React from 'react';
import { readFileSync } from 'node:fs';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';

import { SHIPMENT_ERROR_CODES, SHIPMENT_EXCEPTION_KINDS } from '@/lib/fulfilment/types';
import { SHOP_ERROR_CODES, type StorefrontOrderView } from './api';
import { OrderSummary } from './order-summary';

type Tree = Record<string, unknown>;
const load = (locale: string) => JSON.parse(readFileSync(`${process.cwd()}/messages/${locale}.json`, 'utf8')) as Tree;
const at = (tree: Tree, path: string): unknown => path.split('.').reduce<unknown>((node, key) => (node as Tree | undefined)?.[key], tree);
const en = load('en');

const order = (extra: Partial<StorefrontOrderView>): StorefrontOrderView => ({
  reference: 'AB12CD34', status: 'expired', currency: 'INR', subtotalMinor: 10000, discountMinor: 0, shippingMinor: 0, paymentMethod: 'online',
  codFeeMinor: 0, taxMinor: 0, totalMinor: 10000, taxInclusive: true, amountPaidMinor: 0, priced: true,
  lines: [{ name: 'Tulsi', sku: 'TUL-1', qty: 1, unitPriceMinor: 10000, lineTotalMinor: 10000 }],
  paymentUrl: null, paymentPending: false, paymentFailed: false, returnWindowDays: null, reservationExpiresAt: null, paidAt: null, documentNumber: null, ...extra,
});
const render = (view: StorefrontOrderView) => renderToStaticMarkup(
  <NextIntlClientProvider locale="en" timeZone="UTC" messages={{ Storefront: en.Storefront as Tree }} onError={() => {}}>
    <OrderSummary order={view} locale="en" />
  </NextIntlClientProvider>,
);

describe('payment-setup failure on the order page', () => {
  it('says payment could not be set up instead of "not paid in time"', () => {
    const html = render(order({ paymentFailed: true }));
    expect(html).toContain('Payment could not be set up');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('Expired: not paid in time');
  });
  it('keeps the plain expiry for an order that ran out of time', () => {
    const html = render(order({}));
    expect(html).toContain('Expired: not paid in time');
    expect(html).not.toContain('Payment could not be set up');
  });
});

describe('return window on the order page (audit 22)', () => {
  it('tells the customer the window once the order has left, and says when there are no returns', () => {
    expect(render(order({ status: 'fulfilled', returnWindowDays: 7 }))).toContain('Returns are accepted within 7 days of delivery.');
    expect(render(order({ status: 'fulfilled', returnWindowDays: 1 }))).toContain('within 1 day of delivery');
    expect(render(order({ status: 'dispatched', returnWindowDays: 0 }))).toContain('does not accept returns');
    expect(render(order({ status: 'paid', returnWindowDays: null }))).not.toContain('Returns are accepted');
  });
});

describe.each(['en', 'es', 'pt', 'ko'])('commerce labels in %s', (locale) => {
  const messages = load(locale);
  it('labels every storefront refusal code, shipment refusal and shipment exception', () => {
    for (const code of SHOP_ERROR_CODES) expect(at(messages, `Storefront.errors.${code}`), code).toEqual(expect.any(String));
    for (const code of SHIPMENT_ERROR_CODES) expect(at(messages, `Validation.shipments.${code}`), code).toEqual(expect.any(String));
    for (const kind of SHIPMENT_EXCEPTION_KINDS) {
      expect(at(messages, `Commerce.shipmentExceptions.kinds.${kind}`), kind).toEqual(expect.any(String));
      expect(at(messages, `Commerce.shipmentExceptions.hints.${kind}`), kind).toEqual(expect.any(String));
    }
  });
  it('labels the checkout-link failure notice for every reason it names', () => {
    for (const reason of ['not_connected', 'provider_auth', 'other'])
      expect(at(messages, `Commerce.checkoutLinkFailed.reasons.${reason}`), reason).toEqual(expect.any(String));
    expect(at(messages, 'Payments.refunds.errors.shipment_live')).toEqual(expect.any(String));
  });
});
