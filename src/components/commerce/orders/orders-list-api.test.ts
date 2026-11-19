import { describe, expect, it } from 'vitest';

import { dateRangeFor, orderQueryParams } from './orders-list-api';
import { parseOrderFilters } from '@/lib/commerce/orders';

describe('orderQueryParams', () => {
  it('sends every list filter, and the server reads back the same filters', () => {
    const params = orderQueryParams({
      status: 'confirmed', source: 'manual', q: ' Asha ', tag: 'VIP', codConfirmation: 'declined', payment: 'cod', cashDue: true,
      from: '2026-11-01T00:00:00.000Z', to: '2026-11-07T23:59:59.999Z',
    });
    expect(Object.fromEntries(params)).toEqual({
      status: 'confirmed', source: 'manual', q: 'Asha', tag: 'VIP', cod_confirmation: 'declined', payment: 'cod', cash_due: '1',
      from: '2026-11-01T00:00:00.000Z', to: '2026-11-07T23:59:59.999Z',
    });
    expect(parseOrderFilters(params)).toMatchObject({
      status: 'confirmed', source: 'manual', q: 'Asha', tag: 'vip', codConfirmation: 'declined', payment: 'cod', cashDue: true,
      from: new Date('2026-11-01T00:00:00.000Z'), to: new Date('2026-11-07T23:59:59.999Z'),
    });
  });

  it('leaves out empty filters', () => {
    expect(orderQueryParams({ status: '', payment: '', cashDue: false, q: '  ', from: null }).toString()).toBe('');
  });
});

describe('dateRangeFor', () => {
  const now = new Date(2026, 10, 19, 15, 30); // 19 Nov 2026, local time
  it.each([
    ['today', new Date(2026, 10, 19)],
    ['d7', new Date(2026, 10, 13)],
    ['d30', new Date(2026, 9, 21)],
    ['month', new Date(2026, 10, 1)],
  ] as const)('%s starts at local midnight with no end', (preset, from) => {
    expect(dateRangeFor(preset, { from: '', to: '' }, now)).toEqual({ from: from.toISOString(), to: null });
  });

  it('covers whole custom days and ignores a missing end', () => {
    expect(dateRangeFor('custom', { from: '2026-11-02', to: '2026-11-04' }, now)).toEqual({
      from: new Date(2026, 10, 2).toISOString(), to: new Date(2026, 10, 4, 23, 59, 59, 999).toISOString(),
    });
    expect(dateRangeFor('custom', { from: '2026-11-02', to: '' }, now).to).toBeNull();
    expect(dateRangeFor('any', { from: '2026-11-02', to: '2026-11-04' }, now)).toEqual({ from: null, to: null });
  });
});
