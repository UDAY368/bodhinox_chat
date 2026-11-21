import { Prisma } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { FIRST_REPLY_LABEL, firstRepliesSql, isFirstReplyMessage, medianOf, medianSecondsSql } from './first-reply';
import { estimateAiCost } from './ai-cost';

const A = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
const text = (sql: Prisma.Sql) => sql.text.replace(/\s+/g, ' ');

describe('the one first-reply definition', () => {
  it('is shown everywhere as "Median first reply"', () => {
    expect(FIRST_REPLY_LABEL).toBe('Median first reply');
  });

  it('ends a wait only with a member or AI reply that did not fail and is not a template or note', () => {
    const rule = text(isFirstReplyMessage('m'));
    expect(rule).toContain("m.status <> 'failed'");
    expect(rule).toContain("m.content_type NOT IN ('template','system')");
    // Members always count; other non-customer senders (bot, flow, automation) only when the AI wrote it.
    expect(rule).toContain("m.sender_type='agent'");
    expect(rule).toContain("m.sender_type <> 'customer' AND m.ai_generated");
  });

  it('binds the workspace and the range as parameters and scopes every message read to the workspace', () => {
    const sql = firstRepliesSql(A, Prisma.sql`${'2026-10-01T00:00:00Z'}::timestamptz`, Prisma.sql`${'2026-10-08T00:00:00Z'}::timestamptz`);
    expect(sql.values).toContain(A);
    expect(sql.text).not.toContain(A);
    expect(text(sql)).toContain('WHERE m.account_id=');
    // Reads a window either side of the range so a wait's start and its reply are both seen.
    expect(text(sql)).toContain("interval '7 days'");
    // Waits are attributed to the range their first customer message falls in.
    expect(text(sql)).toMatch(/w\.wait_at >= \$\d+::timestamptz AND w\.wait_at < \$\d+::timestamptz/);
  });

  it('narrows to a scope when given one', () => {
    const scoped = firstRepliesSql(A, Prisma.sql`now()`, Prisma.sql`now()`, Prisma.sql`AND m.conversation_id IN (SELECT id FROM scope)`);
    expect(text(scoped)).toContain('AND m.conversation_id IN (SELECT id FROM scope)');
  });

  it('medians in SQL with percentile_cont, rounded to whole seconds', () => {
    expect(text(medianSecondsSql())).toContain('percentile_cont(0.5) WITHIN GROUP (ORDER BY secs)');
  });
});

describe('medianOf (combines stored per-wait seconds the way percentile_cont does)', () => {
  it('returns null without answered waits', () => {
    expect(medianOf([])).toBeNull();
  });

  it('takes the middle value of an odd count and interpolates an even count', () => {
    expect(medianOf([300, 60, 120])).toBe(120);
    expect(medianOf([60, 120, 300, 600])).toBe(210);
    expect(medianOf([1, 2])).toBe(2); // 1.5 rounds half up, as round(numeric) does
  });

  it('does not reorder the caller\'s array', () => {
    const values = [3, 1, 2];
    medianOf(values);
    expect(values).toEqual([3, 1, 2]);
  });
});

describe('estimated AI cost', () => {
  it('multiplies tokens by the list price and reports unpriced models instead of guessing', () => {
    const cost = estimateAiCost([
      { provider: 'anthropic', model: 'claude-haiku-5-5', promptTokens: 2_000_000, completionTokens: 1_000_000 },
      { provider: 'openai_compatible', model: 'my-local-model', promptTokens: 500, completionTokens: 500 },
    ]);
    // 2M x $0.10 + 1M x $0.50 = $0.70
    expect(cost.estimatedUsd).toBe(0.7);
    expect(cost.unpricedTokens).toBe(1000);
    expect(cost.byModel.find((m) => m.model === 'my-local-model')?.estimatedUsd).toBeNull();
    expect(cost.promptTokens + cost.completionTokens).toBe(3_001_000);
  });

  it('is zero for no usage', () => {
    expect(estimateAiCost([])).toMatchObject({ estimatedUsd: 0, unpricedTokens: 0, byModel: [] });
  });
});
