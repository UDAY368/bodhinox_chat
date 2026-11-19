import { describe, expect, it } from 'vitest';
import { decodeCursor, encodeCursor, listSchedule, MAX_LIST_ROWS, parseScheduleFilter } from './listing';
import type { TenantTransaction } from '@/lib/db/tenant';

const ID = '44444444-4444-4444-8444-444444444444';
const range = 'from=2026-11-09T00:00:00Z&to=2026-11-16T00:00:00Z';

describe('schedule cursor', () => {
  it('round-trips a position and refuses anything else', () => {
    const at = new Date('2026-11-10T03:30:00Z');
    expect(decodeCursor(encodeCursor({ startAt: at, id: ID }))).toEqual({ startAt: at, id: ID });
    expect(decodeCursor('not a cursor!')).toBeNull();
    expect(decodeCursor(Buffer.from(`2026-11-10T03:30:00Z_x`).toString('base64url'))).toBeNull();
    expect(decodeCursor(Buffer.from(`soon_${ID}`).toString('base64url'))).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });
});

describe('parseScheduleFilter', () => {
  it('defaults to the full page and reads limit and cursor', () => {
    expect(parseScheduleFilter(new URLSearchParams(range)).limit).toBe(MAX_LIST_ROWS);
    const cursor = encodeCursor({ startAt: new Date('2026-11-10T00:00:00Z'), id: ID });
    const f = parseScheduleFilter(new URLSearchParams(`${range}&limit=50&cursor=${cursor}`));
    expect(f.limit).toBe(50);
    expect(f.cursor?.id).toBe(ID);
  });
  it('refuses a bad limit or a forged cursor', () => {
    for (const extra of ['limit=0', 'limit=501', 'limit=2.5', 'limit=x', 'cursor=@@'])
      expect(() => parseScheduleFilter(new URLSearchParams(`${range}&${extra}`))).toThrow('invalid');
  });
});

describe('listSchedule paging', () => {
  const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: ID, start_at: new Date(Date.UTC(2026, 10, 10, i)) }));
  const tx = (n: number, seen: unknown[][] = []) => ({
    $queryRawUnsafe: async (sql: string, ...args: unknown[]) => { seen.push([sql, ...args]); return rows(n); },
  }) as unknown as TenantTransaction;
  const base = { from: new Date('2026-11-09T00:00:00Z'), to: new Date('2026-11-16T00:00:00Z') };

  it('reads one more row than the page to say it was cut, and hands back the last row as the cursor', async () => {
    const seen: unknown[][] = [];
    const page = await listSchedule(tx(3, seen), 'acc', { ...base, limit: 2 });
    expect(String(seen[0][0])).toContain('LIMIT 3');
    expect(page.rows).toHaveLength(2);
    expect(page.truncated).toBe(true);
    expect(decodeCursor(page.nextCursor)).toEqual({ startAt: rows(2)[1].start_at, id: ID });
  });
  it('has no cursor on the last page', async () => {
    const page = await listSchedule(tx(2), 'acc', { ...base, limit: 2 });
    expect(page).toMatchObject({ truncated: false, nextCursor: null });
  });
  it('passes the cursor position to SQL as (start_at, id)', async () => {
    const seen: unknown[][] = [];
    const cursor = { startAt: new Date('2026-11-10T00:00:00Z'), id: ID };
    await listSchedule(tx(0, seen), 'acc', { ...base, cursor });
    expect(String(seen[0][0])).toContain('(a.start_at, a.id) >');
    expect(seen[0].slice(-2)).toEqual([cursor.startAt, ID]);
  });
});
