// GET /api/analytics/templates — template performance for a date range.
//
//   ?templateId=<uuid>  one template (by its name, across its languages);
//                       omitted: every template in the workspace.
//   ?preset=today|7d|30d|90d|custom&from=YYYY-MM-DD&to=YYYY-MM-DD&bucket=day|week
//                       see src/lib/analytics/range.ts (at most 366 days).
//
// Any member may read it, like the template list. Counts only (sent,
// delivered, read, replied, clicked, failed): no message text, contacts or
// phone numbers. Another account's template id is a 404 (RLS and the
// explicit account_id both scope the lookup).
//
// 200 TemplateAnalyticsResponse (src/components/analytics/templates/summarize.ts)

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { AnalyticsInputError, runAnalytics, templateDaily } from '@/lib/analytics/queries';
import { AnalyticsRangeError, bucketKeys, parseRange, rangeInputFromSearchParams } from '@/lib/analytics/range';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  summarizeTemplateRows,
  type TemplateAnalyticsResponse,
  type TemplateInfo,
} from '@/components/analytics/templates/summarize';

const t = getT('Validation.analytics');
const tApi = getT('Api');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const templateId = params.get('templateId');
    if (templateId !== null && !UUID.test(templateId))
      return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });

    const ctx = await requireRole('viewer');
    const limit = checkRateLimit(`analytics:templates:${ctx.userId}`, { limit: 60, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);

    const body = await runAnalytics(tenantOf(ctx), async (tx, timezone): Promise<TemplateAnalyticsResponse | null> => {
      const range = parseRange(rangeInputFromSearchParams(params), timezone);
      let template: TemplateInfo | null = null;
      if (templateId) {
        const found = await tx.$queryRaw<TemplateInfo[]>`
          SELECT id::text AS id, name, language, category, status, quality_score
          FROM message_templates WHERE account_id=${ctx.accountId}::uuid AND id=${templateId}::uuid`;
        if (!found[0]) return null;
        template = found[0];
      }
      const rows = await templateDaily(tx, ctx.accountId, range, template?.name ?? null);
      const summary = summarizeTemplateRows(rows, bucketKeys(range));
      return {
        range: {
          preset: range.preset, startDay: range.startDay, endDay: range.endDay,
          days: range.days, bucket: range.bucket, timezone: range.timezone,
        },
        template,
        ...summary,
        templates: template ? [] : summary.templates,
      };
    });
    if (!body) return NextResponse.json({ error: tApi('templates.notFound') }, { status: 404 });
    return NextResponse.json(body);
  } catch (error) {
    if (error instanceof AnalyticsRangeError)
      return NextResponse.json({ error: t('invalidRange') }, { status: 400 });
    if (error instanceof AnalyticsInputError)
      return NextResponse.json({ error: t('invalidFilter') }, { status: 400 });
    return toErrorResponse(error);
  }
}
