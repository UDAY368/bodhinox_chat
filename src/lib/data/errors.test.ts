import { expect, it } from 'vitest';
import { dataError } from './errors';
it('preserves uniqueness codes for existing deduplication without leaking SQL values', () => {
  const result = dataError({
    code: 'P2010',
    message: 'INSERT secret-value',
    meta: {
      driverAdapterError: {
        cause: {
          originalCode: '23505',
          originalMessage: 'duplicate key with secret-value',
        },
      },
    },
  });
  expect(result).toEqual({
    code: '23505',
    message: 'Duplicate record (23505)',
  });
  expect(JSON.stringify(result)).not.toContain('secret-value');
});
it('returns safe envelopes for known ORM constraint errors and unexpected failures', () => {
  expect(dataError({ code: 'P2003', message: 'private row' })).toMatchObject({
    code: '23503',
  });
  expect(dataError(new Error('password=secret'))).toEqual({
    code: 'DATABASE_ERROR',
    message: 'Database operation failed',
  });
});
