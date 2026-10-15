import { expect, it } from 'vitest';
import { buildQuery } from './builder';
it('preserves mutation returning, inclusive pagination and executes once', async () => {
  const executed: unknown[] = [];
  const query = buildQuery('contacts', async (spec) => {
    executed.push(spec);
    return { data: [{ id: 'a' }], error: null };
  })
    .update({ name: 'Alice' })
    .eq('id', 'a')
    .select('id')
    .range(10, 19);
  await query;
  await query;
  expect(executed).toEqual([
    {
      resource: 'contacts',
      operation: 'update',
      values: { name: 'Alice' },
      filters: [{ field: 'id', op: 'eq', value: 'a' }],
      projection: 'id',
      returning: true,
      offset: 10,
      limit: 10,
    },
  ]);
});
it('reports unsupported operations without executing them', async () => {
  let executed = false;
  const result = await buildQuery('contacts', async () => {
    executed = true;
    return { data: [], error: null };
  }).not('name', 'regex', 'x');
  expect(result.error?.code).toBe('UNSUPPORTED_QUERY');
  expect(executed).toBe(false);
});
