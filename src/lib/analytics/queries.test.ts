import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

const h = vi.hoisted(() => ({ statements: [] as { text: string; values: unknown[] }[], result: [] as unknown[] }));
vi.mock('@/lib/db/tenant', () => ({
  withTenant: async (_context: unknown, fn: (tx: unknown) => unknown) => fn(tx),
}));

import { parseRange } from './range';
import { AGENT_ATTRIBUTION_CUTOFF, agentLeaderboard, aiStats, AnalyticsInputError, campaignFunnel, conversationStats, flowStats, runAnalytics, templateDaily } from './queries';

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER = '33333333-3333-4333-8333-333333333333';
const tx = {
  $queryRaw: async (sql: Prisma.Sql | TemplateStringsArray, ...values: unknown[]) => {
    const text = Array.isArray(sql) ? (sql as TemplateStringsArray).join('?') : (sql as Prisma.Sql).text;
    h.statements.push({ text, values: Array.isArray(sql) ? values : (sql as Prisma.Sql).values });
    return h.result;
  },
} as never;
const range = parseRange({ preset: '7d' }, 'Asia/Kolkata', new Date('2026-11-03T10:00:00Z'));
const last = () => h.statements[h.statements.length - 1];
const squash = (s: string) => s.replace(/\s+/g, ' ');

beforeEach(() => {
  h.statements = [];
  h.result = [{ stats: {}, board: [], funnel: { totals: {}, broadcasts: [] } }];
});

/** Every table read is scoped by account_id and every time column is bounded by the range. */
function expectScoped(text: string, tables: string[], timeColumns: string[]) {
  const sql = squash(text);
  for (const table of tables) expect(sql).toMatch(new RegExp(`FROM ${table}\\b`));
  const accountParams = [...sql.matchAll(/account_id=\$(\d+)::uuid/g)].map((m) => Number(m[1]));
  expect(accountParams.length).toBeGreaterThan(0);
  for (const n of accountParams) expect(last().values[n - 1]).toBe(ACCOUNT);
  for (const column of timeColumns) {
    expect(sql).toMatch(new RegExp(`${column} >= \\$\\d+::timestamptz`));
    expect(sql).toMatch(new RegExp(`${column} < \\$\\d+::timestamptz`));
  }
  expect(last().values).toContain(range.from.toISOString());
  expect(last().values).toContain(range.to.toISOString());
  // Reports never select message text.
  expect(sql).not.toMatch(/content_text|ai_handoff_summary\b(?! IS (NOT )?NULL)|question\b/);
}

describe('analytics SQL shape', () => {
  it('conversation stats scope conversations, messages and campaign sends to the workspace and range', async () => {
    await conversationStats(tx, ACCOUNT, range);
    expectScoped(last().text, ['conversations', 'messages', 'broadcast_recipients'], ['m.created_at', 's.created_at', 'resolved_at', 'sent_at']);
    expect(last().text).not.toContain('team_members');
    expect(squash(last().text)).not.toContain('m.conversation_id IN');
  });

  it('applies number and team filters, and refuses malformed ids', async () => {
    await conversationStats(tx, ACCOUNT, range, { whatsappConfigId: OTHER, teamId: OTHER });
    const sql = squash(last().text);
    expect(sql).toMatch(/c\.whatsapp_config_id=\$\d+::uuid/);
    expect(sql).toMatch(/tm\.account_id=\$\d+::uuid AND tm\.team_id=\$\d+::uuid/);
    expect(sql).toContain('m.conversation_id IN (SELECT id FROM scope)');
    await expect(conversationStats(tx, ACCOUNT, range, { teamId: "x' OR 1=1" })).rejects.toBeInstanceOf(AnalyticsInputError);
    await expect(flowStats(tx, ACCOUNT, range, 'nope')).rejects.toBeInstanceOf(AnalyticsInputError);
    await expect(campaignFunnel(tx, ACCOUNT, { broadcastId: 'nope' })).rejects.toBeInstanceOf(AnalyticsInputError);
    await expect(templateDaily(tx, ACCOUNT, range, '')).rejects.toBeInstanceOf(AnalyticsInputError);
  });

  it('scopes the leaderboard, AI, flow and template reports', async () => {
    await agentLeaderboard(tx, ACCOUNT, range);
    expectScoped(last().text, ['account_memberships', 'messages', 'conversations'], ['m.created_at', 'resolved_at']);
    // Assignee fallback only before the cutoff; first responses from each conversation's first wait.
    expect(squash(last().text)).toMatch(/CASE WHEN m\.created_at < \$\d+::timestamptz THEN c\.assigned_agent_id END/);
    expect(squash(last().text)).toContain('FROM first_waits r');
    expect(last().values).toContain(AGENT_ATTRIBUTION_CUTOFF);
    await aiStats(tx, ACCOUNT, range);
    expectScoped(last().text, ['messages', 'conversations', 'ai_unanswered_questions'], ['created_at', 'ai_handoff_at']);
    expect(squash(last().text)).toContain('NOT c.bot_paused AND c.ai_handoff_summary IS NULL');
    await flowStats(tx, ACCOUNT, range, OTHER);
    expectScoped(last().text, ['flow_runs'], ['started_at']);
    expect(squash(last().text)).toMatch(/flow_id=\$\d+::uuid/);
    await templateDaily(tx, ACCOUNT, range, 'order_update');
    expectScoped(last().text, ['broadcast_recipients', 'messages'], ['r.sent_at', 'm.created_at']);
    expect(last().values).toEqual(expect.arrayContaining(['order_update', 'day', 'Asia/Kolkata']));
  });

  it('funnels a range by schedule time or one campaign by id', async () => {
    await campaignFunnel(tx, ACCOUNT, { range });
    expectScoped(last().text, ['broadcasts', 'broadcast_recipients'], ['COALESCE\\(scheduled_at, created_at\\)']);
    await campaignFunnel(tx, ACCOUNT, { broadcastId: OTHER });
    expect(squash(last().text)).toMatch(/account_id=\$\d+::uuid AND id=\$\d+::uuid/);
    expect(last().values).toContain(OTHER);
  });

  it('runs inside the tenant transaction with a statement timeout and the workspace timezone', async () => {
    h.result = [{ timezone: 'Asia/Kolkata' }];
    const seen = await runAnalytics({ accountId: ACCOUNT }, async (_tx, timezone) => timezone);
    expect(seen).toBe('Asia/Kolkata');
    expect(h.statements[0].text).toContain('statement_timeout');
    expect(squash(h.statements[1].text)).toContain('FROM workspace_inbox_settings WHERE account_id=');
    h.result = [{ timezone: 'Not/AZone' }];
    expect(await runAnalytics({ accountId: ACCOUNT }, async (_tx, timezone) => timezone)).toBe('UTC');
  });
});
