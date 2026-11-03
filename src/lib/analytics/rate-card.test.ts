import { describe, expect, it } from 'vitest';
import { countryForPhone, estimateCampaignCost, parseRateCard, RateCardInputError, recipientsByCountry, type RateCard } from './rate-card';

describe('rate card', () => {
  it('maps E.164 calling codes to countries by longest prefix', () => {
    expect(countryForPhone('+91 98765 43210')).toBe('IN');
    expect(countryForPhone('14155550100')).toBe('US');
    expect(countryForPhone('+971501234567')).toBe('AE');
    expect(countryForPhone('77011234567')).toBe('KZ');
    expect(countryForPhone('79161234567')).toBe('RU');
    expect(countryForPhone('+447700900123')).toBe('GB');
    expect(countryForPhone('+8801712345678')).toBe('BD');
    expect(countryForPhone('0000')).toBe('ZZ');
    expect(countryForPhone('not a phone')).toBe('ZZ');
    expect(countryForPhone('+999123456789')).toBe('ZZ');
    expect(recipientsByCountry(['919876543210', '919876543211', '14155550100', 'x'])).toEqual({ IN: 2, US: 1, ZZ: 1 });
  });

  it('estimates cost per country and lists unpriced countries', () => {
    const cards: RateCard[] = [
      { category: 'marketing', countryCode: 'IN', currency: 'USD', priceMinor: 1.07 },
      { category: 'marketing', countryCode: 'US', currency: 'USD', priceMinor: 2.5 },
      { category: 'utility', countryCode: 'BR', currency: 'USD', priceMinor: 0.8 },
      { category: 'marketing', countryCode: 'BR', currency: 'INR', priceMinor: 50 },
    ];
    const estimate = estimateCampaignCost({ category: 'marketing', currency: 'USD', recipientsByCountry: { US: 10, IN: 3, BR: 4, ZZ: 2, GB: 0 } }, cards);
    expect(estimate).toEqual({
      currency: 'USD',
      total: 28.21,
      byCountry: [
        { countryCode: 'IN', recipients: 3, unitPriceMinor: 1.07, totalMinor: 3.21 },
        { countryCode: 'US', recipients: 10, unitPriceMinor: 2.5, totalMinor: 25 },
      ],
      missingCountries: [{ countryCode: 'BR', recipients: 4 }, { countryCode: 'ZZ', recipients: 2 }],
    });
    expect(estimateCampaignCost({ category: 'service', currency: 'USD', recipientsByCountry: {} }, cards)).toMatchObject({ total: 0, byCountry: [] });
  });

  it('validates rate card writes', () => {
    expect(parseRateCard({ category: 'utility', country_code: 'IN', currency: 'INR', price_minor: 11.5 }))
      .toEqual({ category: 'utility', countryCode: 'IN', currency: 'INR', priceMinor: 11.5 });
    expect(parseRateCard({ category: 'utility', country_code: 'IN', currency: 'INR', price_minor: null }).priceMinor).toBeNull();
    for (const bad of [
      { category: 'promo', country_code: 'IN', currency: 'INR', price_minor: 1 },
      { category: 'utility', country_code: 'in', currency: 'INR', price_minor: 1 },
      { category: 'utility', country_code: 'IN', currency: 'rupee', price_minor: 1 },
      { category: 'utility', country_code: 'IN', currency: 'INR', price_minor: -1 },
      { category: 'utility', country_code: 'IN', currency: 'INR', price_minor: 0.00001 },
      { category: 'utility', country_code: 'IN', currency: 'INR', price_minor: '1' },
      { category: 'utility', country_code: 'IN', currency: 'INR' },
      null,
    ]) expect(() => parseRateCard(bad)).toThrow(RateCardInputError);
  });
});
