// PUT /api/flows/[id]/number { whatsapp_config_id: string | null }
// Which WhatsApp number's inbound messages can trigger the flow: one of the
// workspace's numbers, or null for every number (the default). Same role as
// editing a flow (agent). Tenant scoped; the number must be the workspace's.
// Answers { whatsapp_config_id }.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';

const t = getT('whatsappNumbers');
const Body = z.object({ whatsapp_config_id: z.string().uuid().nullable() }).strict();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success || !UUID.test(id)) return NextResponse.json({ error: t('picker.flowNumberInvalid') }, { status: 400 });
    const numberId = parsed.data.whatsapp_config_id;

    const outcome = await withTenant(tenantOf(ctx), async (tx) => {
      if (numberId) {
        const number = await tx.whatsapp_config.findFirst({ where: { account_id: ctx.accountId, id: numberId }, select: { id: true } });
        if (!number) return 'number' as const;
      }
      const { count } = await tx.flows.updateMany({
        where: { account_id: ctx.accountId, id },
        data: { whatsapp_config_id: numberId },
      });
      return count === 1 ? ('ok' as const) : ('flow' as const);
    });
    if (outcome === 'number') return NextResponse.json({ error: t('errors.notFound') }, { status: 404 });
    if (outcome === 'flow') return NextResponse.json({ error: t('picker.flowNotFound') }, { status: 404 });
    return NextResponse.json({ whatsapp_config_id: numberId });
  } catch (error) {
    return toErrorResponse(error);
  }
}
