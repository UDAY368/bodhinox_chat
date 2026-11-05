// Consented support access (diagnostics scope only, at most 24 hours).
//
// Platform side: an allowlisted, MFA-verified admin asks a workspace for
// access (crm_platform_support_request notifies its owners and admins), then
// reads crm_platform_support_diagnostics while the grant is approved and
// unexpired. The diagnostics are statuses, counts and error codes only.
//
// Tenant side (this file, app role inside withTenant, owners and admins
// only by RLS): approve, deny or revoke a request, or grant access
// proactively to a named allowlisted email. Every step writes a tenant
// audit_logs row (support.approved / denied / revoked). Impersonation and
// access to customer content do not exist.

import { NextResponse } from 'next/server';
import { AuthError } from '@/lib/auth/errors';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { SupportGrantStatus } from '@/types/platform';
import { isUuid } from './tenants';

export const MIN_GRANT_MINUTES = 15;
export const MAX_GRANT_MINUTES = 1440;
/** A request nobody answered within this window can no longer be approved. */
export const REQUEST_TTL_DAYS = 7;

export type SupportErrorCode = 'invalid' | 'not_found' | 'grant_open' | 'not_pending' | 'not_active' | 'request_expired';

const STATUS: Record<SupportErrorCode, number> = {
  invalid: 400, not_found: 404, grant_open: 409, not_pending: 409, not_active: 409, request_expired: 409,
};

export class SupportGrantError extends AuthError {
  constructor(readonly supportCode: SupportErrorCode) {
    super(supportCode, STATUS[supportCode], supportCode);
    this.name = 'SupportGrantError';
  }
}

/** { error, code } with the status of an AuthError (role, session, refusals); anything else is a logged-by-name 500. */
export function supportErrorResponse(error: unknown): NextResponse {
  const headers = { 'Cache-Control': 'private, no-store' };
  if (error instanceof AuthError) return NextResponse.json({ error: error.message, code: error.code }, { status: error.status, headers });
  console.error('Support grant operation failed', error instanceof Error ? error.name : 'unknown');
  return NextResponse.json({ error: 'Internal server error', code: 'internal' }, { status: 500, headers });
}

const minutesOk = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= MIN_GRANT_MINUTES && (v as number) <= MAX_GRANT_MINUTES;
const reasonOf = (v: unknown): string | null => {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  return r.length >= 10 && r.length <= 1000 ? r : null;
};
const plain = (body: unknown, keys: string[]): Record<string, unknown> | null => {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  return Object.keys(b).every((k) => keys.includes(k)) ? b : null;
};

// ---------------------------------------------------------------- platform side
export interface SupportRequestInput {
  accountId: string;
  reason: string;
  minutes: number;
}

/** POST /api/platform/support body: { accountId, reason (10..1000), minutes (15..1440) }. */
export function parseSupportRequest(body: unknown): SupportRequestInput | null {
  const b = plain(body, ['accountId', 'reason', 'minutes']);
  if (!b || !isUuid(b.accountId) || !minutesOk(b.minutes)) return null;
  const reason = reasonOf(b.reason);
  return reason ? { accountId: b.accountId.toLowerCase(), reason, minutes: b.minutes as number } : null;
}

// ---------------------------------------------------------------- tenant side
export interface TenantSupportGrant {
  id: string;
  requestedByEmail: string;
  reason: string;
  requestedMinutes: number;
  /** 'approved' past expires_at reads as 'expired'. */
  status: SupportGrantStatus;
  requestedAt: string;
  decidedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
  /** The request is still waiting and can be approved (younger than REQUEST_TTL_DAYS). */
  actionable: boolean;
}

type GrantRow = {
  id: string; requested_by_email: string; reason: string; requested_minutes: number; status: SupportGrantStatus;
  requested_at: Date; decided_at: Date | null; expires_at: Date | null; revoked_at: Date | null; stale: boolean;
};

const toGrant = (r: GrantRow): TenantSupportGrant => ({
  id: r.id, requestedByEmail: r.requested_by_email, reason: r.reason, requestedMinutes: Number(r.requested_minutes),
  status: r.status, requestedAt: r.requested_at.toISOString(), decidedAt: r.decided_at?.toISOString() ?? null,
  expiresAt: r.expires_at?.toISOString() ?? null, revokedAt: r.revoked_at?.toISOString() ?? null,
  actionable: r.status === 'requested' && !r.stale,
});

const SELECT_GRANT = (tx: TenantTransaction, accountId: string, id: string | null) => tx.$queryRaw<GrantRow[]>`
  SELECT id, requested_by_email, reason, requested_minutes,
    CASE WHEN status = 'approved' AND expires_at <= now() THEN 'expired'
         WHEN status = 'requested' AND requested_at < now() - make_interval(days => ${REQUEST_TTL_DAYS}::int) THEN 'expired'
         ELSE status END AS status,
    requested_at, decided_at, expires_at, revoked_at,
    requested_at < now() - make_interval(days => ${REQUEST_TTL_DAYS}::int) AS stale
  FROM support_grants
  WHERE account_id=${accountId}::uuid AND (${id}::uuid IS NULL OR id=${id}::uuid)
  ORDER BY requested_at DESC
  LIMIT 50`;

/** The workspace's grants, newest first (owners and admins; others see none by RLS). */
export async function listSupportGrants(tx: TenantTransaction, accountId: string): Promise<TenantSupportGrant[]> {
  return (await SELECT_GRANT(tx, accountId, null)).map(toGrant);
}

export type GrantDecision = { action: 'approve'; minutes: number | null } | { action: 'deny' } | { action: 'revoke' };

/** PATCH body: { action: 'approve', minutes? (15..requested) } | { action: 'deny' } | { action: 'revoke' }. */
export function parseGrantDecision(body: unknown): GrantDecision | null {
  const b = plain(body, ['action', 'minutes']);
  if (!b) return null;
  if (b.action === 'approve') {
    if (b.minutes === undefined || b.minutes === null) return { action: 'approve', minutes: null };
    return minutesOk(b.minutes) ? { action: 'approve', minutes: b.minutes } : null;
  }
  if ((b.action === 'deny' || b.action === 'revoke') && b.minutes === undefined) return { action: b.action };
  return null;
}

export interface ProactiveGrant {
  email: string;
  reason: string;
  minutes: number;
}

/** POST body: { email (an allowlisted platform admin), reason (10..1000), minutes (15..1440) }. */
export function parseProactiveGrant(body: unknown): ProactiveGrant | null {
  const b = plain(body, ['email', 'reason', 'minutes']);
  if (!b || typeof b.email !== 'string' || !minutesOk(b.minutes)) return null;
  const email = b.email.trim().toLowerCase();
  if (email.length < 3 || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return null;
  const reason = reasonOf(b.reason);
  return reason ? { email, reason, minutes: b.minutes as number } : null;
}

export interface Actor {
  accountId: string;
  userId: string;
}

async function audit(tx: TenantTransaction, actor: Actor, action: string, grantId: string, metadata: Record<string, unknown>) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id, user_id, action, resource_id, metadata)
    VALUES (${actor.accountId}::uuid, ${actor.userId}::uuid, ${action}, ${grantId}, ${JSON.stringify(metadata)}::jsonb)`;
}

/** Locks the grant row; an approved grant whose window passed reads as 'expired'. */
async function lockGrant(tx: TenantTransaction, accountId: string, grantId: string): Promise<GrantRow> {
  if (!isUuid(grantId)) throw new SupportGrantError('not_found');
  const rows = await tx.$queryRaw<GrantRow[]>`
    SELECT id, requested_by_email, reason, requested_minutes,
      CASE WHEN status = 'approved' AND expires_at <= now() THEN 'expired' ELSE status END AS status,
      requested_at, decided_at, expires_at, revoked_at,
      requested_at < now() - make_interval(days => ${REQUEST_TTL_DAYS}::int) AS stale
    FROM support_grants WHERE account_id=${accountId}::uuid AND id=${grantId}::uuid FOR UPDATE`;
  if (!rows[0]) throw new SupportGrantError('not_found');
  return rows[0];
}

/** Approve, deny or revoke one grant of the caller's workspace; returns it afterwards. */
export async function decideSupportGrant(tx: TenantTransaction, actor: Actor, grantId: string, decision: GrantDecision): Promise<TenantSupportGrant> {
  const row = await lockGrant(tx, actor.accountId, grantId);
  if (decision.action === 'approve' || decision.action === 'deny') {
    if (row.status !== 'requested') throw new SupportGrantError('not_pending');
    if (row.stale) throw new SupportGrantError('request_expired');
  }
  if (decision.action === 'approve') {
    // The approver grants the window asked for, or a shorter one.
    const minutes = Math.min(decision.minutes ?? row.requested_minutes, row.requested_minutes);
    await tx.$executeRaw`UPDATE support_grants SET status='approved', decided_by=${actor.userId}::uuid, decided_at=now(),
        expires_at=now() + make_interval(mins => ${minutes}::int)
      WHERE account_id=${actor.accountId}::uuid AND id=${row.id}::uuid`;
    await audit(tx, actor, 'support.approved', row.id, { requested_by_email: row.requested_by_email, minutes });
  } else if (decision.action === 'deny') {
    await tx.$executeRaw`UPDATE support_grants SET status='denied', decided_by=${actor.userId}::uuid, decided_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${row.id}::uuid`;
    await audit(tx, actor, 'support.denied', row.id, { requested_by_email: row.requested_by_email });
  } else {
    if (row.status !== 'approved') throw new SupportGrantError('not_active');
    await tx.$executeRaw`UPDATE support_grants SET status='revoked', revoked_at=now()
      WHERE account_id=${actor.accountId}::uuid AND id=${row.id}::uuid`;
    await audit(tx, actor, 'support.revoked', row.id, { requested_by_email: row.requested_by_email });
  }
  return toGrant((await SELECT_GRANT(tx, actor.accountId, row.id))[0]);
}

/**
 * Grants diagnostics access to a support address without a request; one open grant per address.
 * The answer never depends on the platform allowlist (a workspace admin must not be able to probe
 * which emails are platform admins): a grant to any other address is inert, because using one needs
 * requirePlatformAdmin (allowlist + MFA) and an email match in crm_platform_support_diagnostics.
 */
export async function createProactiveGrant(tx: TenantTransaction, actor: Actor, input: ProactiveGrant): Promise<TenantSupportGrant> {
  // A window that already passed, or a request nobody answered in time, no longer counts as open.
  await tx.$executeRaw`UPDATE support_grants SET status='expired'
    WHERE account_id=${actor.accountId}::uuid AND requested_by_email=${input.email}
      AND ((status='approved' AND expires_at <= now())
        OR (status='requested' AND requested_at < now() - make_interval(days => ${REQUEST_TTL_DAYS}::int)))`;
  const rows = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO support_grants(account_id, requested_by_email, reason, requested_minutes, status, decided_by, decided_at, expires_at)
    VALUES (${actor.accountId}::uuid, ${input.email}, ${input.reason}, ${input.minutes}::int, 'approved', ${actor.userId}::uuid, now(),
      now() + make_interval(mins => ${input.minutes}::int))
    ON CONFLICT DO NOTHING
    RETURNING id`;
  const id = rows[0]?.id;
  if (!id) throw new SupportGrantError('grant_open');
  await audit(tx, actor, 'support.approved', id, { requested_by_email: input.email, minutes: input.minutes, proactive: true });
  return toGrant((await SELECT_GRANT(tx, actor.accountId, id))[0]);
}
