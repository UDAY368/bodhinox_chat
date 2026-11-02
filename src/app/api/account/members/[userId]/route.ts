// ============================================================
// /api/account/members/[userId]
//
//   PATCH  — change a member's role and/or phone masking.   Admin+.
//            Body { role?, mask_phone_numbers? }; at least one.
//            mask_phone_numbers: true hides customers' full numbers
//            from an agent or viewer everywhere the browser reads
//            them (src/lib/inbox/masking-apply.ts); owners and admins
//            can't be masked (400). Unknown member: 404.
//   DELETE — remove a member.          Admin+.
//
// Both delegate to SECURITY DEFINER RPCs from migration 018:
//   - set_member_role(p_user_id, p_new_role)
//   - remove_account_member(p_user_id)
//
// The RPCs do the *real* authorisation work — caller must be
// admin+, target must be in caller's account, target can't be the
// owner, can't be self. The TS layer here only forwards the call
// and maps Postgres SQLSTATEs back to HTTP statuses.
// ============================================================

import { NextResponse } from 'next/server';
import type { DataError } from '@/lib/data/types';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { isAccountRole } from '@/lib/auth/roles';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { getT } from '@/lib/i18n/translate';
import { withTenant } from '@/lib/db/tenant';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const t = getT('Api');

// Map known SQLSTATEs from the RPCs (see migration 018) onto HTTP
// statuses. The `error.code` field is the SQLSTATE; the `message`
// is the human-readable RAISE message we put in the migration.
function rpcErrorToResponse(err: DataError): NextResponse {
  if (err.code === '42501') {
    return NextResponse.json({ error: err.message }, { status: 403 });
  }
  if (err.code === '22023') {
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
  console.error('[members route] unexpected RPC error:', err);
  return NextResponse.json(
    { error: t('account.members.updateFailed') },
    { status: 500 }
  );
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberRole:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const body = (await request.json().catch(() => null)) as {
      role?: unknown;
      mask_phone_numbers?: unknown;
    } | null;
    const role = body?.role;
    const mask = body?.mask_phone_numbers;

    if (mask !== undefined && typeof mask !== 'boolean') {
      return NextResponse.json(
        { error: t('account.members.maskInvalid') },
        { status: 400 }
      );
    }
    if (role !== undefined && mask !== undefined) {
      return NextResponse.json(
        { error: t('account.members.oneChange') },
        { status: 400 }
      );
    }
    if (mask !== undefined) {
      if (!UUID.test(userId)) {
        return NextResponse.json(
          { error: t('account.members.notFound') },
          { status: 404 }
        );
      }
      // RLS (admin_mask_update) also refuses masking an owner or admin.
      const outcome = await withTenant(ctx, async (tx) => {
        const rows = await tx.$queryRaw<{ role: string }[]>`
          SELECT role::text AS role FROM account_memberships
          WHERE account_id=${ctx.accountId}::uuid AND user_id=${userId}::uuid`;
        if (!rows[0]) return 'missing' as const;
        if (mask && !['agent', 'viewer'].includes(rows[0].role))
          return 'privileged' as const;
        await tx.$executeRaw`
          UPDATE account_memberships SET mask_phone_numbers=${mask}
          WHERE account_id=${ctx.accountId}::uuid AND user_id=${userId}::uuid`;
        return 'ok' as const;
      });
      if (outcome === 'missing')
        return NextResponse.json(
          { error: t('account.members.notFound') },
          { status: 404 }
        );
      if (outcome === 'privileged')
        return NextResponse.json(
          { error: t('account.members.maskPrivileged') },
          { status: 400 }
        );
      return NextResponse.json({ ok: true, mask_phone_numbers: mask });
    }

    if (!isAccountRole(role)) {
      return NextResponse.json(
        { error: t('account.members.roleInvalid') },
        { status: 400 }
      );
    }

    // The RPC blocks promotion to / demotion from owner, but
    // surface the friendlier 400 before crossing the wire too.
    if (role === 'owner') {
      return NextResponse.json(
        {
          error: t('account.members.useTransferOwnership'),
        },
        { status: 400 }
      );
    }

    const { error } = await ctx.db.rpc('set_member_role', {
      p_user_id: userId,
      p_new_role: role,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ userId: string }> }
) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:memberRemove:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { userId } = await params;

    const { data, error } = await ctx.db.rpc('remove_account_member', {
      p_user_id: userId,
    });

    if (error) return rpcErrorToResponse(error);

    return NextResponse.json({ ok: true, newPersonalAccountId: data });
  } catch (err) {
    return toErrorResponse(err);
  }
}
