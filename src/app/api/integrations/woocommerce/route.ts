// /api/integrations/woocommerce — WooCommerce store connections (admin only).
//   GET                                   list stores (never the secret)
//   POST   { storeUrl, consentMetaKey? }   connect; returns the webhook secret ONCE
//   PATCH  { id, consentMetaKey }          change the consent meta key
//   DELETE ?id=…                           disconnect (the webhook URL stops working, the
//                                         store's queued sends are skipped and, with no
//                                         store left, every WooCommerce rule is switched off)
// Mutations pass the proxy's session origin/CSRF check like every dashboard route.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { wooDeliveryUrl } from '@/lib/integrations/woocommerce/delivery-url';
import {
  createWooStore,
  deleteWooStore,
  listWooStores,
  stopWooStore,
  updateWooStoreConsentKey,
  WooStoreInputError,
} from '@/lib/integrations/woocommerce/stores';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const isUuid = (id: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const noStore = { 'Cache-Control': 'private, no-store' };
const bad = (code: string, status = 400) => NextResponse.json({ error: 'Invalid store', code }, { status });

export async function GET() {
  try {
    const ctx = await requireRole('admin');
    const stores = await withTenant(tenantOf(ctx), (tx) => listWooStores(tx, ctx.accountId));
    return NextResponse.json(
      { stores: stores.map((s) => ({ ...s, delivery_url: wooDeliveryUrl(s.id) })) },
      { headers: noStore },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`admin:wooStore:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const { store, webhookSecret } = await withTenant(tenantOf(ctx), (tx) =>
      createWooStore(tx, ctx.accountId, { storeUrl: body?.storeUrl, consentMetaKey: body?.consentMetaKey }));
    return NextResponse.json(
      { store: { ...store, delivery_url: wooDeliveryUrl(store.id) }, webhookSecret },
      { status: 201, headers: noStore },
    );
  } catch (err) {
    if (err instanceof WooStoreInputError) return bad(err.code, err.code === 'store_exists' ? 409 : 400);
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    const id = typeof body?.id === 'string' ? body.id : '';
    const store = await withTenant(tenantOf(ctx), (tx) => updateWooStoreConsentKey(tx, ctx.accountId, id, body?.consentMetaKey));
    if (!store) return NextResponse.json({ error: 'Not found' }, { status: 404 });
    return NextResponse.json({ store: { ...store, delivery_url: wooDeliveryUrl(store.id) } }, { headers: noStore });
  } catch (err) {
    if (err instanceof WooStoreInputError) return bad(err.code);
    return toErrorResponse(err);
  }
}

export async function DELETE(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const id = new URL(request.url).searchParams.get('id') ?? '';
    const deleted = await withTenant(tenantOf(ctx), (tx) => deleteWooStore(tx, ctx.accountId, id));
    // Runs even when nothing was deleted, so a retry finishes a cleanup that
    // failed after an earlier delete; it does nothing while the store exists.
    if (isUuid(id)) await withTenant({ accountId: ctx.accountId, role: 'owner' }, (tx) => stopWooStore(tx, ctx.accountId, id), getWorkerPrisma());
    return deleted ? NextResponse.json({ deleted: true }) : NextResponse.json({ error: 'Not found' }, { status: 404 });
  } catch (err) {
    return toErrorResponse(err);
  }
}
