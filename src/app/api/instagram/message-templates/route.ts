// GET /api/instagram/message-templates (any member) — the workspace's saved Instagram
//   card and button messages: 200 { templates: [{ id, name, kind, payload, updated_at }] }.
// POST (agents and above) — { name, kind: 'cards' | 'button', payload } checked against
//   Instagram's limits (reply buttons get their payload from the server):
//   201 { template }; 400 { error: invalid_template | duplicate_name | too_many }.
// Read and written as the member under RLS. CSRF/mutation origin is enforced by
// src/proxy.ts. Behind INSTAGRAM_ENABLED (404 when off).
import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { instagramEnabled } from '@/lib/instagram/config';
import {
  createInstagramTemplate,
  InstagramTemplateError,
  listInstagramTemplates,
} from '@/lib/instagram/message-templates';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const headers = { 'Cache-Control': 'private, no-store' };
const off = () => NextResponse.json({ error: 'Not found' }, { status: 404, headers });

function templateErrorResponse(error: InstagramTemplateError) {
  return NextResponse.json({ error: error.code }, { status: error.code === 'not_found' ? 404 : 400, headers });
}

export async function GET() {
  try {
    if (!instagramEnabled()) return off();
    const ctx = await requireRole('viewer');
    return NextResponse.json({ templates: await listInstagramTemplates(tenantOf(ctx)) }, { headers });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    if (!instagramEnabled()) return off();
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`igTemplates:${ctx.userId}`, RATE_LIMITS.send);
    if (!limit.success) return rateLimitResponse(limit);
    const template = await createInstagramTemplate({ ...tenantOf(ctx), userId: ctx.userId }, await request.json().catch(() => null));
    return NextResponse.json({ template }, { status: 201, headers });
  } catch (error) {
    if (error instanceof InstagramTemplateError) return templateErrorResponse(error);
    return toErrorResponse(error);
  }
}
