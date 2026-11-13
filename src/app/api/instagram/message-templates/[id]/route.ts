// PATCH /api/instagram/message-templates/[id] (agents and above) — replace a saved
//   Instagram template ({ name, kind, payload }, checked as on create): 200 { template }.
// DELETE (agents and above) — 200 { ok: true }.
// Another workspace's id answers 404 (RLS and the account filter). Behind INSTAGRAM_ENABLED.
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { instagramEnabled } from '@/lib/instagram/config';
import {
  deleteInstagramTemplate,
  InstagramTemplateError,
  updateInstagramTemplate,
} from '@/lib/instagram/message-templates';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const headers = { 'Cache-Control': 'private, no-store' };
const off = () => NextResponse.json({ error: 'Not found' }, { status: 404, headers });
type Params = { params: Promise<{ id: string }> };
const templateErrorResponse = (error: InstagramTemplateError) =>
  NextResponse.json({ error: error.code }, { status: error.code === 'not_found' ? 404 : 400, headers });

export async function PATCH(request: Request, { params }: Params) {
  try {
    if (!instagramEnabled()) return off();
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`igTemplates:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const template = await updateInstagramTemplate(tenantOf(ctx), id, await request.json().catch(() => null));
    return NextResponse.json({ template }, { headers });
  } catch (error) {
    if (error instanceof InstagramTemplateError) return templateErrorResponse(error);
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: Params) {
  try {
    if (!instagramEnabled()) return off();
    const ctx = await requireRole('agent');
    const { id } = await params;
    await deleteInstagramTemplate(tenantOf(ctx), id);
    return NextResponse.json({ ok: true }, { headers });
  } catch (error) {
    if (error instanceof InstagramTemplateError) return templateErrorResponse(error);
    return toErrorResponse(error);
  }
}
