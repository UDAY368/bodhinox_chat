// POST /api/contacts/duplicates/dismiss { contact_ids: [a, b] } (admins and owners)
//   "Not duplicates": the pair is stored and never offered again. Origin + CSRF checked.
//   200 { dismissed: true }; 400 invalid_request; 401; 403 forbidden; 404 not_found (also another workspace's ids); 429.
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { dismissDuplicate, DuplicatesError } from '@/lib/contacts/duplicates';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

const NO_STORE = { 'Cache-Control': 'no-store' };
const schema = z.object({ contact_ids: z.tuple([z.string().uuid(), z.string().uuid()]) }).strict();

export async function POST(request: Request) {
  try {
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'admin'))
      return NextResponse.json({ error: 'forbidden', code: 'forbidden' }, { status: 403, headers: NO_STORE });
    const limit = await checkRateLimit(`contactDuplicateDismiss:${session.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = schema.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: 'invalid_request', code: 'invalid_request' }, { status: 400, headers: NO_STORE });
    const [first, second] = parsed.data.contact_ids;
    await dismissDuplicate({ accountId: session.accountId, userId: session.userId, role: session.role }, first, second);
    return NextResponse.json({ dismissed: true }, { headers: NO_STORE });
  } catch (error) {
    if (error instanceof DuplicatesError)
      return NextResponse.json({ error: error.code, code: error.code }, { status: error.status, headers: NO_STORE });
    return toErrorResponse(error);
  }
}
