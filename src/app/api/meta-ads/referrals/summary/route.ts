// GET /api/meta-ads/referrals/summary — any member. Conversations started from
// click-to-WhatsApp ads in the last 30 days, from referrals stored with inbound
// messages: { conversations, days }. Not flag-gated: referral capture is always
// on and this makes no Meta call.

import { NextResponse } from 'next/server';
import { requireSession } from '@/lib/auth/session';
import { actorOf, metaAdsRouteError, NO_STORE } from '@/lib/meta-ads/http';
import { countAdStartedConversations } from '@/lib/meta-ads/insights';

export const runtime = 'nodejs';
const DAYS = 30;

export async function GET(request: Request) {
  try {
    const session = await requireSession(request);
    const conversations = await countAdStartedConversations(actorOf(session), DAYS);
    return NextResponse.json({ conversations, days: DAYS }, { headers: NO_STORE });
  } catch (error) {
    return metaAdsRouteError(error);
  }
}
