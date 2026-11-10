// /api/account/channels — which channels this workspace uses (Stage 1).
//   GET (any member)  200 { channels: { whatsapp, instagram }, enabled, chosen }; each channel is
//                     { channel, available, unavailableReason, enabled, explicit, connection, state }.
//   PUT (admins)      { channels: { whatsapp?: boolean, instagram?: boolean } } writes a row per named
//                     channel and returns the new state. Needs Origin + CSRF proof (or a bearer token).
//                     400 invalid_request; 402 plan_required and 503 platform_off (turning Instagram
//                     on); 409 channel_connected (disconnect first) and 409 last_channel.
// workspace_channels is not a browser resource; this route is its only browser path.

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { ChannelSettingsError, getWorkspaceChannels, parseChannelChanges, setWorkspaceChannels } from '@/lib/channels/workspace';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

const noStore = { 'Cache-Control': 'private, no-store' };

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    const state = await withTenant(tenant, (tx) => getWorkspaceChannels(tx, session.accountId));
    return NextResponse.json(state, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin')) throw new ForbiddenError('Changing channels requires an admin role');
    const limit = checkRateLimit(`workspaceChannels:${session.accountId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const changes = parseChannelChanges(await request.json().catch(() => null));
    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    const state = await withTenant(tenant, (tx) =>
      setWorkspaceChannels(tx, { accountId: session.accountId, userId: session.userId }, changes));
    return NextResponse.json(state, { headers: noStore });
  } catch (error) {
    if (error instanceof ChannelSettingsError) {
      const t = getT('Channels');
      const channel = error.channel ? t(`names.${error.channel}`) : '';
      return NextResponse.json({ error: t(`errors.${error.code}`, { channel }), code: error.code, channel: error.channel ?? null },
        { status: error.status, headers: noStore });
    }
    return toErrorResponse(error);
  }
}
