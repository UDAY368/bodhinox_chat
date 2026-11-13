// GET /api/conversations/{id}/export — the conversation's messages as a CSV
// download (agent and above; the latest 10,000). Phone numbers in the text are
// masked for a member whose numbers are masked. Another workspace's id, or a
// conversation the member cannot see, is 404. Nothing from a message is logged.

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { ConversationActionError, exportConversation } from '@/lib/inbox/conversation-actions';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

type Context = { params: Promise<{ id: string }> };
const NO_STORE = { 'Cache-Control': 'private, no-store' };

export async function GET(_request: Request, context: Context) {
  try {
    const ctx = await requireRole('agent');
    const { id } = await context.params;
    const limit = checkRateLimit(`conversationExport:${ctx.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const tenant = tenantOf(ctx);
    const { csv, fileName } = await withTenant(tenant, (tx) => exportConversation(tx, tenant, id));
    return new NextResponse(csv, {
      headers: {
        ...NO_STORE,
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${fileName}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (error instanceof ConversationActionError)
      return NextResponse.json({ error: error.code }, { status: error.status, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
