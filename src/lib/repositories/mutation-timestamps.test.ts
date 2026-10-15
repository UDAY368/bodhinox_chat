import { expect, it } from 'vitest';
import { executeInTransaction, type SqlTransaction } from './crm';
it('adds a server timestamp after validating a browser mutation without mutating caller data', async () => {
  const queries: { sql: string; values: unknown[] }[] = [];
  const tx: SqlTransaction = {
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) => {
      queries.push({ sql, values });
      return [] as T;
    },
  };
  const input = {
    resource: 'contacts',
    operation: 'update' as const,
    values: { name: 'Saved' },
    filters: [
      {
        field: 'id',
        op: 'eq' as const,
        value: '33333333-3333-4333-8333-333333333333',
      },
    ],
  };
  await executeInTransaction(
    tx,
    input,
    {
      accountId: '11111111-1111-4111-8111-111111111111',
      userId: '22222222-2222-4222-8222-222222222222',
      role: 'agent',
    },
    true
  );
  expect(queries[0].sql).toContain('"updated_at" =');
  expect(
    queries[0].values.some(
      (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value)
    )
  ).toBe(true);
  expect(input.values).toEqual({ name: 'Saved' });
});
