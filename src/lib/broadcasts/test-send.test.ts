import { describe, expect, it } from 'vitest';
import { testParams } from './test-send';

describe('testParams', () => {
  const contact = { id: 'c', name: 'Asha', phone: '14155550101', email: null, company: 'Acme', opted_out_at: null, blocked_at: null };
  const variables = {
    '1': { type: 'static' as const, value: 'Diwali' },
    '2': { type: 'field' as const, value: 'name' as const },
    '3': { type: 'field' as const, value: 'email' as const },
    '4': { type: 'custom_field' as const, value: '00000000-0000-4000-8000-000000000001' },
    '5': { type: 'csv_column' as const, value: 'order_id' },
  };
  const keys = ['1', '2', '3', '4', '5'];

  it("uses the matching contact's values and marks every gap visibly", () => {
    expect(testParams(keys, variables, contact, new Map([['00000000-0000-4000-8000-000000000001', 'Gold']])))
      .toEqual(['Diwali', 'Asha', '[email]', 'Gold', '[order_id]']);
  });

  it('marks contact values as placeholders when the number is not a contact', () => {
    expect(testParams(keys, variables, null, new Map())).toEqual(['Diwali', '[name]', '[email]', '[4]', '[order_id]']);
  });
});
