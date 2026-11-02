// PATCH  /api/whatsapp/numbers/[id] { display_name?: string | null, is_default?: true }
//        Rename a number and/or make it the workspace default (admin).
//        Answers { number: WhatsAppNumberDto }.
// DELETE /api/whatsapp/numbers/[id] — disconnect one number (admin), in one
//        transaction. The row is kept (status 'disconnected', token cleared)
//        so conversations, campaigns and flows keep their number and nothing
//        is re-routed; reconnecting the same Phone Number ID revives it. Its
//        live flows go back to draft, campaigns scheduled or sending on it
//        (and open API campaigns) are held (not cancelled, not moved) with the
//        reason in the audit log, and if it was the default the oldest
//        remaining connected number becomes the default. Answers
//        { disconnected: true, new_default_id, new_default, no_default_left,
//        paused_flows, held_campaigns: [{ id, name, status }], message }
//        where message says, in words, what changed.
// Tenant scoped through withTenant; mutation origin/CSRF is enforced by the
// proxy for every /api mutation. Responses never include token columns.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { DISPLAY_NAME_MAX, disconnectAndReport, disconnectResponse, renameNumber, toNumberDto } from '@/lib/whatsapp/number-admin';
import { listNumbers, NoNumberError, setDefaultNumber } from '@/lib/whatsapp/numbers';

const t = getT('whatsappNumbers');
type Context = { params: Promise<{ id: string }> };

const Body = z.object({
  display_name: z.string().max(DISPLAY_NAME_MAX).nullable().optional(),
  is_default: z.literal(true).optional(),
}).strict().refine((b) => b.display_name !== undefined || b.is_default !== undefined);

const notFound = () => NextResponse.json({ error: t('errors.notFound') }, { status: 404 });

export async function PATCH(request: Request, context: Context) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`whatsappNumbers:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await context.params;
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: t('api.invalidChange') }, { status: 400 });

    const number = await withTenant(tenantOf(ctx), async (tx) => {
      if (parsed.data.is_default) await setDefaultNumber(tx, ctx.accountId, id);
      if (parsed.data.display_name !== undefined && !(await renameNumber(tx, ctx.accountId, id, parsed.data.display_name))) {
        throw new NoNumberError('not_found');
      }
      return (await listNumbers(tx, ctx.accountId)).find((n) => n.id === id) ?? null;
    });
    if (!number) return notFound();
    return NextResponse.json({ number: toNumberDto(number) });
  } catch (error) {
    if (error instanceof NoNumberError && error.reason === 'disconnected') {
      return NextResponse.json({ error: t('errors.disconnected'), code: 'whatsapp_number_disconnected' }, { status: 409 });
    }
    if (error instanceof NoNumberError) return notFound();
    return toErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`whatsappNumbers:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await context.params;
    const outcome = await withTenant(tenantOf(ctx), (tx) => disconnectAndReport(tx, ctx.accountId, id, ctx.userId));
    if (!outcome) return notFound();
    return NextResponse.json(disconnectResponse(outcome));
  } catch (error) {
    return toErrorResponse(error);
  }
}
