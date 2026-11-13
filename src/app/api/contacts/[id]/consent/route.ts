import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { setWhatsAppConsent, type WhatsAppConsentState } from '@/lib/contacts/whatsapp-consent';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STATES: readonly WhatsAppConsentState[] = ['opted_in', 'opted_out', 'cleared'];

/**
 * POST { state: 'opted_in' | 'opted_out' | 'cleared' }: an agent or above records the
 * contact's WhatsApp consent. Audited; the browser cannot write these columns.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id: contactId } = await params;
    const body = (await request.json().catch(() => null)) as { state?: unknown } | null;
    const state = body?.state;
    if (!UUID.test(contactId) || typeof state !== 'string' || !STATES.includes(state as WhatsAppConsentState))
      return NextResponse.json({ error: 'invalid_request' }, { status: 400 });
    const result = await setWhatsAppConsent(
      { accountId: ctx.accountId, userId: ctx.userId, role: ctx.role },
      contactId,
      state as WhatsAppConsentState
    );
    if (!result) return NextResponse.json({ error: 'not_found' }, { status: 404 });
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    return toErrorResponse(error);
  }
}
