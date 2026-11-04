// GET /api/commerce/notice-templates: the order notice template per kind and the
//   approved UTILITY/MARKETING templates to choose from (agents and above). 200 { templates }
// PUT /api/commerce/notice-templates { kind, template_name, language } (admins; both null clears).
//   200 { templates }; 400 { error, code: invalid | template_not_found | wrong_category }.
// Dispatched, delivered and feedback need a UTILITY template; repeat_purchase a MARKETING one.

import { NextResponse } from 'next/server';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getNoticeTemplates, noticeTemplateErrorResponse, parseNoticeTemplateInput, saveNoticeTemplate } from '@/lib/commerce/notice-templates';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json({ templates: await getNoticeTemplates(tenantOf(ctx)) }, { headers: NO_STORE });
  } catch (error) {
    return noticeTemplateErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:notice-templates:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseNoticeTemplateInput(await request.json().catch(() => null));
    const templates = await saveNoticeTemplate({ ...tenantOf(ctx), userId: ctx.userId }, input);
    return NextResponse.json({ templates }, { headers: NO_STORE });
  } catch (error) {
    return noticeTemplateErrorResponse(error);
  }
}
