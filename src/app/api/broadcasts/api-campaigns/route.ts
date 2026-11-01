// POST /api/broadcasts/api-campaigns { name, templateId } — create an API campaign (agent+).

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
