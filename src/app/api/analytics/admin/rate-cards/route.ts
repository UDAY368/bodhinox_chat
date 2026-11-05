// /api/analytics/admin/rate-cards — Meta's per-message rate card (platform data).
//   GET  any signed-in member: ?category=&currency= narrows the list.
//   PUT  platform admins only (verified email in PLATFORM_ADMIN_EMAILS, verified MFA factor,
//        recent MFA check: requirePlatformAdmin), recorded in the platform audit trail. Body
//        { cards: [{ category, country_code, currency, price_minor }] }, at most
//        1000 rows; price_minor null removes that row. Origin/CSRF is checked
//        here as well as in the proxy (a platform-wide write).

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requireSession } from '@/lib/auth/session';
import { isRateCategory, listRateCards, MAX_RATE_CARDS_PER_WRITE, parseRateCard, RateCardInputError, upsertRateCards } from '@/lib/analytics/rate-card';
import { getT } from '@/lib/i18n/translate';
import { hashRequestIp } from '@/lib/platform/audit';
import { platformErrorResponse, requirePlatformAdmin } from '@/lib/platform/auth';

const t = getT('Validation.analytics');

export async function GET(request: Request) {
  try {
    await requireSession(request);
    const params = new URL(request.url).searchParams;
    const category = params.get('category'), currency = params.get('currency');
    if ((category && !isRateCategory(category)) || (currency && !/^[A-Z]{3}$/.test(currency)))
      return NextResponse.json({ error: t('invalidRateCard') }, { status: 400 });
    const cards = await listRateCards({ category: category && isRateCategory(category) ? category : undefined, currency: currency || undefined });
    return NextResponse.json({ cards });
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    // Runs on the worker role (no PLATFORM_DATABASE_URL needed); non-admins keep getting 403.
    const admin = await requirePlatformAdmin(request, { mutation: true, console: false });
    const body = (await request.json().catch(() => null)) as { cards?: unknown } | null;
    const raw = body && typeof body === 'object' ? body.cards : null;
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_RATE_CARDS_PER_WRITE)
      return NextResponse.json({ error: t('invalidRateCard') }, { status: 400 });
    let cards;
    try {
      cards = raw.map(parseRateCard);
    } catch (error) {
      if (error instanceof RateCardInputError) return NextResponse.json({ error: t('invalidRateCard') }, { status: 400 });
      throw error;
    }
    // The audit row is written in the same worker transaction as the rate cards.
    const updated = await upsertRateCards(cards, {
      adminEmail: admin.email, action: 'analytics.rate_cards_updated', targetRef: 'meta_rate_cards',
      detail: { rows: cards.length, removed: cards.filter((c) => c.priceMinor === null).length },
      ipHash: hashRequestIp(request),
    });
    return NextResponse.json({ updated });
  } catch (error) {
    return platformErrorResponse(error);
  }
}
