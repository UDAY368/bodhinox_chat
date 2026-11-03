import { expect, it } from 'vitest';
import { pickCurrency, prefixesToCountries, templateRateCategory } from './campaign-cost';

it('maps template categories to rate categories, defaulting to marketing', () => {
  expect(templateRateCategory('Utility')).toBe('utility');
  expect(templateRateCategory('Authentication')).toBe('authentication');
  expect(templateRateCategory('Marketing')).toBe('marketing');
  expect(templateRateCategory(null)).toBe('marketing');
});

it('picks the requested currency, else INR, else the first one', () => {
  const card = (currency: string) => ({ category: 'marketing' as const, countryCode: 'IN', currency, priceMinor: 1 });
  expect(pickCurrency([card('USD'), card('INR')], 'USD')).toEqual({ currency: 'USD', currencies: ['INR', 'USD'] });
  expect(pickCurrency([card('USD'), card('INR')], 'EUR').currency).toBe('INR');
  expect(pickCurrency([card('USD'), card('EUR')]).currency).toBe('EUR');
  expect(pickCurrency([])).toEqual({ currency: null, currencies: [] });
});

it('turns 4-digit phone prefixes into country counts', () => {
  expect(prefixesToCountries([
    { prefix: '9198', n: 3 }, { prefix: '9199', n: 2 }, { prefix: '1415', n: 1 }, { prefix: '4479', n: 4 }, { prefix: '', n: 5 }, { prefix: '9990', n: 1 },
  ])).toEqual({ IN: 5, US: 1, GB: 4, ZZ: 6 });
});
