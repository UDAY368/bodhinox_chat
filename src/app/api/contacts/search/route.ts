// GET /api/contacts/search?q=&cursor=&limit=&channel=whatsapp|instagram
//   (any member) — contacts matching q by name, phone digits or Instagram username, newest first
//   (the newest contacts when q is empty). limit defaults to 20, at most 50.
//   200 { contacts: { id, name, phone, avatarUrl, channel }[], nextCursor: string | null };
//   400 for a bad q, cursor, limit or channel. Numbers are masked for a masked member.
import { NextResponse } from 'next/server';

import { getCurrentAccount } from '@/lib/auth/account';
import { AudienceFilterError } from '@/lib/audience/filter';
import { audienceError, tenantOf } from '@/lib/audience/http';
import { CONTACT_SEARCH_DEFAULT_LIMIT, CONTACT_SEARCH_MAX_LIMIT, searchContacts, type SearchChannel } from '@/lib/search/contacts';
import { parseLimit, parseQuery } from '@/lib/search/normalise';

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const params = new URL(request.url).searchParams;
    const channel = params.get('channel') || undefined;
    if (channel && channel !== 'whatsapp' && channel !== 'instagram') throw new AudienceFilterError('Invalid channel');
    const result = await searchContacts(tenantOf(ctx), {
      q: parseQuery(params.get('q')),
      cursor: params.get('cursor') || null,
      limit: parseLimit(params.get('limit'), CONTACT_SEARCH_DEFAULT_LIMIT, CONTACT_SEARCH_MAX_LIMIT),
      channel: channel as SearchChannel | undefined,
    });
    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return audienceError(err);
  }
}
