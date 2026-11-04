// GET /api/contacts/{id}/identities (any member)
//   The contact's Instagram identities (display fields only, never an IGSID or
//   token) and whether each can be unlinked. `enabled` says whether Instagram is
//   on, so the contact page offers link/unlink only then. While off it lists
//   nothing and makes no query. Members whose phone numbers are masked get the
//   Instagram handle masked too.
import { NextResponse } from 'next/server';
import { hasMinRole } from '@/lib/auth/roles';
import { requireSession } from '@/lib/auth/session';
import { listContactIdentities } from '@/lib/contacts/identity-link';
import { instagramConfig } from '@/lib/instagram/config';
import { NO_STORE } from '@/lib/instagram/http';
import { maskIdentityRow, resolvePhoneMask } from '@/lib/inbox/masking-apply';
import { identityRouteError, type IdentityRouteContext } from './_lib/http';

export async function GET(request: Request, context: IdentityRouteContext) {
  try {
    const { id } = await context.params;
    const ctx = await requireSession(request);
    if (!instagramConfig()) return NextResponse.json({ enabled: false, identities: [] }, { headers: NO_STORE });
    const [identities, mask] = await Promise.all([
      listContactIdentities({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }, id),
      resolvePhoneMask({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role }),
    ]);
    return NextResponse.json({
      enabled: true,
      can_link: hasMinRole(ctx.role, 'admin'),
      identities: identities.map((identity) => maskIdentityRow({
        id: identity.id,
        channel: identity.channel,
        instagram_account_id: identity.instagramAccountId,
        username: identity.username,
        display_name: identity.displayName,
        created_at: identity.createdAt.toISOString(),
        can_unlink: identity.canUnlink,
      }, mask)),
    }, { headers: NO_STORE });
  } catch (error) {
    return identityRouteError(error);
  }
}
