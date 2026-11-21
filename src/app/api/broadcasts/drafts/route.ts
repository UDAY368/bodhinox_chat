// POST /api/broadcasts/drafts — save a new campaign draft with every wizard field (agent+ with campaigns.send).
// The draft's CSV rows and settings are stored server-side (lib/broadcasts/drafts); nothing is sent.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { saveCampaignDraft } from '@/lib/broadcasts/drafts';
import { readBoundedJson } from '@/lib/broadcasts/read-body';

export const runtime = 'nodejs';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const result = await saveCampaignDraft(tenantOf(ctx), await readBoundedJson(request));
    return NextResponse.json(result, { status: 201, headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
