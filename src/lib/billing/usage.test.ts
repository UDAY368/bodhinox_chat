import { describe, expect, it } from 'vitest';
import { ACTIVE_CONTACTS_CACHE_MS, meterIsFresh } from './usage';

describe('meterIsFresh', () => {
  const now = new Date('2026-11-02T10:00:00Z');
  it('reuses a value computed within the cache window', () => {
    expect(meterIsFresh(new Date(now.getTime() - ACTIVE_CONTACTS_CACHE_MS + 1), now)).toBe(true);
    expect(meterIsFresh(now, now)).toBe(true);
  });
  it('recomputes an old, future-dated or missing value', () => {
    expect(meterIsFresh(new Date(now.getTime() - ACTIVE_CONTACTS_CACHE_MS), now)).toBe(false);
    expect(meterIsFresh(new Date(now.getTime() + 1000), now)).toBe(false);
    expect(meterIsFresh(null, now)).toBe(false);
  });
});

describe('outboundMessagesThisMonth', () => {
  it('counts agent and bot messages since the IST month began, reused for ten minutes per workspace', async () => {
    const { outboundMessagesThisMonth, resetOutboundCacheForTests } = await import('./usage');
    resetOutboundCacheForTests();
    const sql: string[] = [];
    let n = 41;
    const tx = { $queryRaw: async (s: TemplateStringsArray) => { sql.push(s.join('?')); return [{ n: n++ }]; } } as never;
    const at = new Date('2026-11-05T10:00:00Z');
    expect(await outboundMessagesThisMonth(tx, 'acc-1', at)).toBe(41);
    expect(await outboundMessagesThisMonth(tx, 'acc-1', new Date(at.getTime() + ACTIVE_CONTACTS_CACHE_MS - 1))).toBe(41);
    expect(sql).toHaveLength(1);
    expect(sql[0]).toContain("sender_type IN ('agent','bot')");
    expect(await outboundMessagesThisMonth(tx, 'acc-2', at)).toBe(42);
    expect(await outboundMessagesThisMonth(tx, 'acc-1', new Date(at.getTime() + ACTIVE_CONTACTS_CACHE_MS))).toBe(43);
  });
});
