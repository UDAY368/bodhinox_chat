import { describe, expect, it } from 'vitest';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { normaliseMetaProduct, parseMetaPrice, syncErrorCategory } from './catalog-sync';

describe('parseMetaPrice', () => {
  it('reads Meta formatted prices into minor units', () => {
    expect(parseMetaPrice('₹1,234.50', 'INR')).toEqual({ price_minor: 123450, currency: 'INR' });
    expect(parseMetaPrice('$10.00', 'usd')).toEqual({ price_minor: 1000, currency: 'USD' });
    expect(parseMetaPrice('Rs. 99', 'INR')).toEqual({ price_minor: 9900, currency: 'INR' });
    expect(parseMetaPrice('¥500', 'JPY')).toEqual({ price_minor: 500, currency: 'JPY' });
    expect(parseMetaPrice('₹1,234.00', 'INR').price_minor).toBe(123400);
    expect(parseMetaPrice('₹1,23,456.50', 'INR').price_minor).toBe(12345650);
    expect(parseMetaPrice('$1,234,567', 'USD').price_minor).toBe(123456700);
    expect(parseMetaPrice('¥1,500', 'JPY').price_minor).toBe(1500);
    expect(parseMetaPrice('KD 1,234.500', 'KWD').price_minor).toBe(1234500);
  });

  it('never reads a comma decimal as a thousands separator', () => {
    for (const price of ['€12,50', '12,50 €', '10,50 €', '€10,5', '1,5', '1,2345', '12,3,456']) {
      expect(parseMetaPrice(price, 'EUR').price_minor).toBeNull();
    }
    // De-style thousands with a dot is refused by its decimal count, not read as 1.05.
    expect(parseMetaPrice('€1.050', 'EUR').price_minor).toBeNull();
    // For a three-decimal currency "1,234" may be 1.234: refused without a '.' decimal.
    expect(parseMetaPrice('1,234 KWD', 'KWD').price_minor).toBeNull();
  });

  it('drops a price it cannot read unambiguously rather than guessing', () => {
    expect(parseMetaPrice('1.234,50 €', 'EUR').price_minor).toBeNull();
    expect(parseMetaPrice('10.005', 'USD').price_minor).toBeNull();
    expect(parseMetaPrice('free', 'USD').price_minor).toBeNull();
    expect(parseMetaPrice('10.00', 'XX')).toEqual({ price_minor: null, currency: null });
    expect(parseMetaPrice(undefined, 'USD')).toEqual({ price_minor: null, currency: 'USD' });
  });
});

describe('normaliseMetaProduct', () => {
  it('keeps the fields we store, bounded', () => {
    expect(normaliseMetaProduct({
      id: '987', retailer_id: ' SKU-1 ', name: ' Blue shoe ', description: 'd'.repeat(20_000), price: '₹499.00', currency: 'INR',
      image_url: 'https://cdn.example/x.jpg', url: 'javascript:alert(1)', availability: 'In Stock', visibility: 'published',
    })).toEqual({
      retailer_id: 'SKU-1', meta_product_id: '987', name: 'Blue shoe', description: 'd'.repeat(10_000), price_minor: 49900, currency: 'INR',
      image_url: 'https://cdn.example/x.jpg', url: null, availability: 'in stock', is_hidden: false,
    });
  });

  it('hides staging products and skips ones without a usable id or name', () => {
    expect(normaliseMetaProduct({ id: '1', retailer_id: 'a', name: 'A', visibility: 'staging' })?.is_hidden).toBe(true);
    expect(normaliseMetaProduct({ id: '1', retailer_id: 'a', name: 'A' })?.is_hidden).toBe(false);
    expect(normaliseMetaProduct({ id: '1', retailer_id: '  ', name: 'A' })).toBeNull();
    expect(normaliseMetaProduct({ id: '1', retailer_id: 'a'.repeat(201), name: 'A' })).toBeNull();
    expect(normaliseMetaProduct({ id: '1', retailer_id: 'a', name: '' })).toBeNull();
  });
});

describe('syncErrorCategory', () => {
  it('maps Meta failures to fixed categories and never echoes Meta text', () => {
    expect(syncErrorCategory(new MetaApiError('secret detail', { httpStatus: 401, code: 190 }))).toBe('token');
    expect(syncErrorCategory(new MetaApiError('x', { httpStatus: 400, code: 100 }))).toBe('not_found');
    expect(syncErrorCategory(new MetaApiError('x', { httpStatus: 500 }))).toBe('unavailable');
    expect(syncErrorCategory(new Error('socket hang up'))).toBe('unavailable');
  });
});
