import { describe, expect, it } from 'vitest';
import { isPlatformAdmin, parsePlanPrice, PriceInputError, pricesFromEnv } from './prices';

const price = { plan: 'basic', interval: 'month', amount_minor: 99_900, provider_plan_id: 'plan_ABC123' };

describe('isPlatformAdmin', () => {
  it('matches listed emails case-insensitively and nothing when unset', () => {
    const env = { PLATFORM_ADMIN_EMAILS: ' Ops@Example.com , ,x' };
    expect(isPlatformAdmin('ops@example.com', env)).toBe(true);
    expect(isPlatformAdmin('other@example.com', env)).toBe(false);
    expect(isPlatformAdmin('x', env)).toBe(false);
    expect(isPlatformAdmin('ops@example.com', {})).toBe(false);
    expect(isPlatformAdmin(undefined, env)).toBe(false);
  });
});

describe('parsePlanPrice', () => {
  it('accepts a valid price with defaults', () => {
    expect(parsePlanPrice(price)).toEqual({ plan: 'basic', interval: 'month', currency: 'INR', amountMinor: 99_900, provider: 'razorpay', providerPlanId: 'plan_ABC123', active: true });
  });
  it.each([
    { ...price, plan: 'Basic!' },
    { ...price, interval: 'week' },
    { ...price, amount_minor: 0 },
    { ...price, amount_minor: 1.5 },
    { ...price, currency: 'USD' },
    { ...price, provider: 'stripe' },
    { ...price, provider_plan_id: 'abc' },
    { ...price, active: 'yes' },
  ])('rejects %o', (bad) => {
    expect(() => parsePlanPrice(bad)).toThrow(PriceInputError);
  });
});

describe('pricesFromEnv', () => {
  it('parses the seed and refuses bad JSON', () => {
    expect(pricesFromEnv({})).toEqual([]);
    expect(pricesFromEnv({ BILLING_PLAN_PRICES: JSON.stringify([price]) })).toHaveLength(1);
    expect(() => pricesFromEnv({ BILLING_PLAN_PRICES: '{' })).toThrow(PriceInputError);
    expect(() => pricesFromEnv({ BILLING_PLAN_PRICES: '{}' })).toThrow(PriceInputError);
  });
});
