// GET /api/broadcasts/drafts/[id] — everything a saved draft holds, to reopen it in the wizard (agent+).
// PUT /api/broadcasts/drafts/[id] — replace that draft's fields (agent+ with campaigns.send). Only a draft can change.
// DELETE /api/broadcasts/drafts/[id] — remove the draft once its campaign is created (agent+ with campaigns.send).

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { deleteCampaignDraft, loadCampaignDraft, saveCampaignDraft } from '@/lib/broadcasts/drafts';
import { readBoundedJson } from '@/lib/broadcasts/read-body';

export const runtime = 'nodejs';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const notFound = () => NextResponse.json({ error: 'Draft unavailable' }, { status: 404 });

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const draft = await loadCampaignDraft(tenantOf(ctx), id);
    if (!draft) return notFound();
    return NextResponse.json({ draft }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id)) return notFound();
    const result = await saveCampaignDraft(tenantOf(ctx), await readBoundedJson(request), id);
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'campaigns.send');
    const { id } = await params;
    if (!UUID.test(id) || !(await deleteCampaignDraft(tenantOf(ctx), id))) return notFound();
    return NextResponse.json({ success: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
