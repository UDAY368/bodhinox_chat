import { beforeEach, describe, expect, it } from 'vitest';
import type { Prisma } from '@prisma/client';

import { AnalyticsInputError } from '@/lib/analytics/queries';
import { parseRange } from '@/lib/analytics/range';
import { commentFunnel, parseFunnelBy } from './funnel';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const range = parseRange({ preset: '7d' }, 'Asia/Kolkata', new Date('2026-11-03T10:00:00Z'));
const statements: { text: string; values: unknown[] }[] = [];
const totals = { comments: 4, dms: 2, optIns: 1, clicks: 1, leads: 1, follows: 1 };
const tx = {
  $queryRaw: async (sql: Prisma.Sql) => {
    statements.push({ text: sql.text.replace(/\s+/g, ' '), values: sql.values });
    return statements.length === 1 ? [totals] : [{ id: 'x', name: null, ...totals }];
  },
} as never;

beforeEach(() => { statements.length = 0; });

describe('comment funnel SQL', () => {
  it('scopes every statement to the workspace and the range, by post', async () => {
    const funnel = await commentFunnel(tx, ACCOUNT, range, 'post');
    expect(funnel.totals).toEqual(totals);
    expect(statements).toHaveLength(2);
    for (const s of statements) {
      expect(s.text).toMatch(/FROM instagram_comment_events e/);
      expect(s.text).toMatch(/e\.account_id=\$(\d+)::uuid/);
      const n = Number(/e\.account_id=\$(\d+)::uuid/.exec(s.text)![1]);
      expect(s.values[n - 1]).toBe(ACCOUNT);
      expect(s.text).toMatch(/e\.received_at >= \$\d+::timestamptz AND e\.received_at < \$\d+::timestamptz/);
      expect(s.values).toContain(range.from.toISOString());
      expect(s.values).toContain(range.to.toISOString());
    }
    expect(statements[1].text).toContain('GROUP BY e.media_id');
  });

  it('joins runs and flows within the workspace when grouped by flow', async () => {
    await commentFunnel(tx, ACCOUNT, range, 'flow');
    const sql = statements[1].text;
    expect(sql).toContain('JOIN flow_runs r ON r.account_id=e.account_id AND r.id=e.flow_run_id');
    expect(sql).toContain('LEFT JOIN flows f ON f.account_id=r.account_id AND f.id=r.flow_id');
  });

  it('reads counts only: no commenter id, comment id or text', async () => {
    await commentFunnel(tx, ACCOUNT, range, 'flow');
    await commentFunnel(tx, ACCOUNT, range, 'post');
    for (const s of statements) expect(s.text).not.toMatch(/from_igsid|comment_id|content_text|reply_text/);
  });

  it('parses the grouping and refuses anything else', () => {
    expect(parseFunnelBy(null)).toBe('post');
    expect(parseFunnelBy('flow')).toBe('flow');
    expect(() => parseFunnelBy("post'; DROP TABLE x")).toThrow(AnalyticsInputError);
  });
});
