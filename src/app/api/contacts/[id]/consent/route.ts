import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { setInstagramConsentByMember } from '@/lib/contacts/instagram-member-consent';
import { setWhatsAppConsent, type WhatsAppConsentState } from '@/lib/contacts/whatsapp-consent';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES: readonly WhatsAppConsentState[] = ['opted_in', 'opted_out', 'cleared'];

/**
 * POST { state: 'opted_in' | 'opted_out' | 'cleared', channel?: 'whatsapp' | 'instagram' }:
 * an agent or above records the contact's consent on one channel (WhatsApp when
 * channel is left out). Instagram takes opted_in or opted_out only, and only for a
 * contact with an Instagram identity. Audited, and shown on the contact's timeline;
 * the browser cannot write these columns.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as { state?: unknown; channel?: unknown } | null;
    const state = body?.state;
    const channel = body?.channel ?? 'whatsapp';
    if (!UUID.test(contactId) || typeof state !== 'string' || !STATES.includes(state as WhatsAppConsentState)
      || (channel !== 'whatsapp' && channel !== 'instagram') || (channel === 'instagram' && state === 'cleared'))
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    const tenant = { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role };
    if (channel === 'instagram') {
      const result = await setInstagramConsentByMember(tenant, contactId, state as 'opted_in' | 'opted_out');
      if (result === 'not_found') return NextResponse.json({ error: 'not_found' }, { status: 404 });
      if (result === 'no_identity') return NextResponse.json({ error: 'no_instagram' }, { status: 409 });
      return NextResponse.json({ ok: true, ...result });
    }
    const result = await setWhatsAppConsent(tenant, contactId, state as WhatsAppConsentState);
    if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
