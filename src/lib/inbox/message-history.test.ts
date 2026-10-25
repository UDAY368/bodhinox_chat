import { expect, it } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { DataClient, QuerySpec } from '@/lib/data/types';
import { loadMessagePage } from './message-history';
it('bounds newest history and uses timestamp plus id for stable older boundaries', async () => {
  const specs: QuerySpec[] = [];
  const rows = [
    { id: 'b', created_at: '2026-01-01T00:00:00Z' },
    { id: 'a', created_at: '2026-01-01T00:00:00Z' },
  ];
  const db = {
    from: (name: string) =>
      buildQuery(name, async (spec) => {
        specs.push(spec);
        return { data: rows, error: null };
      }),
  } as unknown as DataClient;
  const page = await loadMessagePage(db, 'conversation');
  expect(page.data?.map((m) => m.id)).toEqual(['a', 'b']);
  expect(specs[0].limit).toBe(50);
  expect(specs[0].orders?.map((o) => [o.field, o.ascending])).toEqual([
    ['created_at', false],
    ['id', false],
  ]);
  await loadMessagePage(db, 'conversation', {
    id: 'a',
    created_at: '2026-01-01T00:00:00Z',
  });
  expect(specs[1].or).toEqual([
    'created_at.lt.2026-01-01T00:00:00Z,and(created_at.eq.2026-01-01T00:00:00Z,id.lt.a)',
  ]);
  expect(specs[1].filters).toContainEqual({
    field: 'conversation_id',
    op: 'eq',
    value: 'conversation',
  });
});
