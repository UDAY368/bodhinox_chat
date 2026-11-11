// GET  /api/inbox/labels?channel=whatsapp|instagram (any member) — the workspace's
//   conversation labels and the label links of the conversations the caller may
//   see (agent visibility, src/lib/inbox/inbox-scope.ts):
//   200 { labels: { id, name, color }[], links: { conversation_id, label_id }[] }.
// POST /api/inbox/labels (agents and above) — create { name, color? }:
//   201 { label }; 400 invalid_name | invalid_color; 409 name_taken | limit (20 per workspace).
// CSRF/mutation origin is enforced by src/proxy.ts.
import { NextResponse } from 'next/server';

import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import {
  createLabel, LABEL_WRITE_LIMIT, labelErrorResponse, listLabelLinks, listLabels, parseLabelCreate,
} from '@/lib/inbox/labels';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('viewer');
    const raw = new URL(request.url).searchParams.get('channel');
    const channel = raw === 'whatsapp' || raw === 'instagram' ? raw : undefined;
    const tenant = tenantOf(ctx);
    const [labels, links] = await Promise.all([listLabels(tenant), listLabelLinks(tenant, channel)]);
    return NextResponse.json({ labels, links }, { headers });
  } catch (error) {
    return labelErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`inbox:labels:${ctx.userId}`, LABEL_WRITE_LIMIT);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseLabelCreate(await request.json().catch(() => null));
    return NextResponse.json({ label: await createLabel(tenantOf(ctx), input) }, { status: 201, headers });
  } catch (error) {
    return labelErrorResponse(error);
  }
}
