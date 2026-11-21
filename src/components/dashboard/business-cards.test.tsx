import { describe, expect, it } from 'vitest';

import { headlineCurrency } from './business-cards';

describe('Home revenue card currency', () => {
  it('headlines the workspace currency when it has revenue, else the largest amount', () => {
    expect(headlineCurrency({ USD: 900, INR: 50000 }, 'INR')).toBe('INR');
    expect(headlineCurrency({ USD: 900, EUR: 100 }, 'INR')).toBe('USD');
    expect(headlineCurrency({ INR: 0, USD: 5 }, 'INR')).toBe('USD');
  });

  it('has no headline without revenue', () => {
    expect(headlineCurrency({}, 'INR')).toBeNull();
    expect(headlineCurrency({ INR: 0 }, 'INR')).toBeNull();
  });
});
