// GET    /api/notifications/push-subscriptions — { available, public_key, devices }. Any member.
//        public_key is the VAPID application server key (public by design); null while push is not configured.
// POST   /api/notifications/push-subscriptions — PushSubscription.toJSON() { endpoint, keys: { p256dh, auth } }
//        stores this browser for the signed-in member. 200 { devices }; 400 invalid; 503 push not configured.
// DELETE /api/notifications/push-subscriptions — { endpoint } removes this browser. 200 { removed }.
// A member only ever sees or changes their own devices (RLS).

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { countPushDevices, deletePushSubscription, savePushSubscription } from '@/lib/notifications/push-subscriptions';
import { isAllowedPushEndpoint, parseSubscription, vapidConfig } from '@/lib/notifications/web-push';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const PRIVATE = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const config = vapidConfig();
    const devices = config ? await countPushDevices(tenantOf(ctx)) : 0;
    return NextResponse.json({ available: Boolean(config), public_key: config?.publicKey ?? null, devices }, { headers: PRIVATE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`push:subscribe:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    if (!vapidConfig()) return NextResponse.json({ error: 'push_unavailable', code: 'push_unavailable' }, { status: 503 });
    const subscription = parseSubscription(await request.json().catch(() => null));
    if (!subscription) return NextResponse.json({ error: 'invalid_subscription', code: 'invalid_subscription' }, { status: 400 });
    await savePushSubscription(tenantOf(ctx), subscription);
    return NextResponse.json({ devices: await countPushDevices(tenantOf(ctx)) }, { headers: PRIVATE });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`push:subscribe:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const endpoint = ((await request.json().catch(() => null)) as { endpoint?: unknown } | null)?.endpoint;
    if (!isAllowedPushEndpoint(endpoint)) return NextResponse.json({ error: 'invalid_subscription', code: 'invalid_subscription' }, { status: 400 });
    return NextResponse.json({ removed: await deletePushSubscription(tenantOf(ctx), endpoint) }, { headers: PRIVATE });
  } catch (error) {
    return toErrorResponse(error);
  }
}
