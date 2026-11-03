// GET /api/conversations/{id}/ad-referral — every member, viewers included.
//   The ad or post that started this conversation, for the inbox badge:
//   200 { referral: { headline, source_url, source_type, created_at } | null }
//   404 when the conversation is not visible. Stored data only (no Meta call,
//   so it is not gated on the Meta ads flag). Never returns the click id.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getT } from '@/lib/i18n/translate';
import { conversationAdReferral, ConversationNotFoundError } from '@/lib/meta-ads/conversation-referral';

const NO_STORE = { 'Cache-Control': 'private, no-store' };
type Context = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('viewer');
    const { id } = await context.params;
    const referral = await conversationAdReferral(tenantOf(ctx), id);
    return NextResponse.json(
      {
        referral: referral && {
          headline: referral.headline,
          source_url: referral.sourceUrl,
          source_type: referral.sourceType,
          created_at: referral.createdAt,
        },
      },
      { headers: NO_STORE },
    );
  } catch (error) {
    if (error instanceof ConversationNotFoundError)
      return NextResponse.json({ error: getT('Api.metaAds')('notFound'), code: 'not_found' }, { status: 404, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
