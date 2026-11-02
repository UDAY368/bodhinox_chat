// POST /api/broadcasts/api-campaigns { name, templateId, whatsappConfigId? } — create an API
// campaign (agent+). whatsappConfigId must be one of the workspace's numbers; default when omitted.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { createApiCampaign } from '@/lib/broadcasts/api-campaign';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json(await createApiCampaign(tenantOf(ctx), await request.json().catch(() => null)), { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
