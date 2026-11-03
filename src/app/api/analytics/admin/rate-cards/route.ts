// /api/analytics/admin/rate-cards — Meta's per-message rate card (platform data).
//   GET  any signed-in member: ?category=&currency= narrows the list.
//   PUT  platform admins only (verified email in PLATFORM_ADMIN_EMAILS). Body
//        { cards: [{ category, country_code, currency, price_minor }] }, at most
//        1000 rows; price_minor null removes that row. Origin/CSRF is checked
//        here as well as in the proxy (a platform-wide write).

import { NextResponse } from 'next/server';

import { ForbiddenError, toErrorResponse } from '@/lib/auth/account';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { isPlatformAdmin } from '@/lib/billing/prices';
import { isRateCategory, listRateCards, MAX_RATE_CARDS_PER_WRITE, parseRateCard, RateCardInputError, upsertRateCards } from '@/lib/analytics/rate-card';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

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
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!isPlatformAdmin(session.user.email)) throw new ForbiddenError();
    const limit = checkRateLimit(`rateCards:${session.userId}`, { limit: 30, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
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
    return NextResponse.json({ updated: await upsertRateCards(cards) });
  } catch (error) {
    return toErrorResponse(error);
  }
}
