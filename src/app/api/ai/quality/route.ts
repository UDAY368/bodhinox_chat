// GET /api/ai/quality (admins and owners, 'ai.settings') — the AI quality
//   page's numbers for the last 30 days, from one fixed aggregate query over
//   ai_suggestions (plus assessment sources and this month's AI tokens):
//   200 { window_days, replies: { total, accepted, edited, rejected, ignored,
//         acceptance_rate, edit_rate, rejection_rate, median_edit_distance },
//         summaries, routed_to_staff, guard_flags: [{ flag, count }],
//         assessments: { model, deterministic }, tokens_this_month }.
//   Rates are 0..1 over every reply suggestion shown (null with none);
//   median_edit_distance is 0..1000 (normalised Levenshtein x 1000) over
//   sent suggestions. Counts only: no suggestion text, no customer content.

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { aiTokensUsed } from '@/lib/billing/limits';

const noStore = { 'Cache-Control': 'private, no-store' };
const WINDOW_DAYS = 30;
const FLAG_LIMIT = 20;

interface CountsRow {
  replies: number;
  accepted: number;
  edited: number;
  rejected: number;
  summaries: number;
  routed: number;
  median_edit: number | null;
}

const rate = (n: number, total: number): number | null => (total > 0 ? Math.round((n / total) * 1000) / 1000 : null);

async function readQuality(tx: TenantTransaction, accountId: string) {
  const [counts] = await tx.$queryRaw<CountsRow[]>`
    SELECT count(*) FILTER (WHERE kind='reply')::int AS replies,
      count(*) FILTER (WHERE kind='reply' AND status='accepted')::int AS accepted,
      count(*) FILTER (WHERE kind='reply' AND status='edited')::int AS edited,
      count(*) FILTER (WHERE kind='reply' AND status='rejected')::int AS rejected,
      count(*) FILTER (WHERE kind='summary')::int AS summaries,
      count(*) FILTER (WHERE kind='route_to_staff')::int AS routed,
      (percentile_cont(0.5) WITHIN GROUP (ORDER BY edit_distance)
        FILTER (WHERE kind='reply' AND status IN ('accepted','edited') AND edit_distance IS NOT NULL))::float8 AS median_edit
    FROM ai_suggestions
    WHERE account_id=${accountId}::uuid AND created_at >= now() - make_interval(days => ${WINDOW_DAYS}::int)`;
  const flags = await tx.$queryRaw<{ flag: string; count: number }[]>`
    SELECT f AS flag, count(*)::int AS count
    FROM ai_suggestions s CROSS JOIN LATERAL unnest(s.guard_flags) AS f
    WHERE s.account_id=${accountId}::uuid AND s.created_at >= now() - make_interval(days => ${WINDOW_DAYS}::int)
    GROUP BY f ORDER BY count(*) DESC, f LIMIT ${FLAG_LIMIT}::int`;
  const sources = await tx.$queryRaw<{ source: string; count: number }[]>`
    SELECT source, count(*)::int AS count FROM ai_assessments
    WHERE account_id=${accountId}::uuid AND created_at >= now() - make_interval(days => ${WINDOW_DAYS}::int)
    GROUP BY source`;
  const tokens = await aiTokensUsed(tx, accountId);

  const c: CountsRow = counts ?? { replies: 0, accepted: 0, edited: 0, rejected: 0, summaries: 0, routed: 0, median_edit: null };
  const ignored = Math.max(0, c.replies - c.accepted - c.edited - c.rejected);
  return {
    window_days: WINDOW_DAYS,
    replies: {
      total: c.replies, accepted: c.accepted, edited: c.edited, rejected: c.rejected, ignored,
      acceptance_rate: rate(c.accepted, c.replies),
      edit_rate: rate(c.edited, c.replies),
      rejection_rate: rate(c.rejected, c.replies),
      median_edit_distance: c.median_edit === null ? null : Math.round(Number(c.median_edit)),
    },
    summaries: c.summaries,
    routed_to_staff: c.routed,
    // Flags are fixed reason codes; anything else is dropped defensively.
    guard_flags: flags.filter((f) => /^[a-z0-9_:.-]{1,64}$/i.test(f.flag)).map((f) => ({ flag: f.flag, count: f.count })),
    assessments: {
      model: sources.find((s) => s.source === 'model')?.count ?? 0,
      deterministic: sources.find((s) => s.source === 'deterministic')?.count ?? 0,
    },
    tokens_this_month: tokens,
  };
}

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    await requirePermission(tenantOf(ctx), 'ai.settings');
    const view = await withTenant(tenantOf(ctx), (tx) => readQuality(tx, ctx.accountId));
    return NextResponse.json(view, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}
