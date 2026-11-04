// GET /api/flows/capabilities — which provider-gated node capabilities this
// workspace has configured ({payments, appointments, ai, capi, commerce,
// meetings, shipping}: booleans only). Any member (viewer+). The builder
// palette disables nodes whose capability is missing; publishing refuses them.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { loadWorkspaceCapabilities } from '@/lib/flows/capabilities';

export async function GET() {
  try {
    const ctx = await requireRole('viewer');
    const capabilities = await loadWorkspaceCapabilities({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role });
    return NextResponse.json(capabilities, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (error) {
    return toErrorResponse(error);
  }
}
