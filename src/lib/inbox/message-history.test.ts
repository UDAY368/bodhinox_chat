import { describe, expect, it } from 'vitest';
import { buildQuery } from '@/lib/data/builder';
import type { DataClient, QuerySpec } from '@/lib/data/types';
import type { Message } from '@/types';
import { historyAfterNewestPage, isNearBottom, loadMessagePage, MESSAGE_PAGE_SIZE } from './message-history';
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

const msg = (id: string, minute = 0) =>
  ({ id, conversation_id: 'c1', created_at: new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString() }) as Message;

describe('historyAfterNewestPage', () => {
  const older = { conversationId: 'c1', before: msg('m1'), hasOlder: true };

  it('keeps the place in history when a resync page overlaps what is shown', () => {
    const shown = new Set(['m1', 'm2', 'm3']);
    expect(historyAfterNewestPage(older, 'c1', [msg('m3', 3), msg('m4', 4)], shown)).toBe(older);
  });

  it('starts again from the page on first load, another conversation, or a gap', () => {
    const page = [msg('m9', 9), msg('m10', 10)];
    expect(historyAfterNewestPage(null, 'c1', page, new Set())).toEqual({ conversationId: 'c1', before: page[0], hasOlder: false });
    expect(historyAfterNewestPage(older, 'c2', page, new Set(['m9']))?.conversationId).toBe('c2');
    expect(historyAfterNewestPage(older, 'c1', page, new Set(['m1']))).toEqual({ conversationId: 'c1', before: page[0], hasOlder: false });
  });

  it('reports older history when the page is full', () => {
    const page = Array.from({ length: MESSAGE_PAGE_SIZE }, (_, i) => msg(`n${i}`, i));
    expect(historyAfterNewestPage(null, 'c1', page, new Set()).hasOlder).toBe(true);
  });
});

it('follows new messages only near the end of the thread', () => {
  expect(isNearBottom({ scrollHeight: 2000, scrollTop: 1500, clientHeight: 480 })).toBe(true);
  expect(isNearBottom({ scrollHeight: 2000, scrollTop: 200, clientHeight: 480 })).toBe(false);
});
