// The platform audit trail. Every platform action is recorded through
// crm_platform_audit, which also writes the tenant audit_logs row when the
// action targets a workspace, in the same call. The console uses the platform
// role; the older platform-wide routes (plan prices, Meta rate cards) stay on
// the worker role, which may execute crm_platform_audit and nothing else of it.
// Details carry ids, statuses, counts and amounts only.

import { createHash } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { getPlatformPrisma, getWorkerPrisma } from '@/lib/db/prisma';

export interface PlatformAuditEntry {
  adminEmail: string;
  /** Lowercase dotted name, e.g. 'billing.prices_updated'. */
  action: string;
  accountId?: string | null;
  targetRef?: string | null;
  reason?: string | null;
  detail?: Record<string, unknown>;
  ipHash?: string | null;
}

const ACTION = /^[a-z][a-z0-9_.]{1,79}$/;

/** SHA-256 of the caller's first forwarded address with AUDIT_IP_SALT (or the JWT key id); null when unknown. */
export function hashRequestIp(request: Request, salt = process.env.AUDIT_IP_SALT || process.env.AUTH_JWT_KID || 'bodhinox'): string | null {
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim();
  if (!forwarded || forwarded.length > 64) return null;
  return createHash('sha256').update(`${salt}:${forwarded}`).digest('hex');
}

/** Records one platform action; returns the platform_audit_log id. */
export async function recordPlatformAudit(entry: PlatformAuditEntry, via: 'platform' | 'worker' = 'platform'): Promise<string> {
  return recordPlatformAuditTx(via === 'worker' ? getWorkerPrisma() : getPlatformPrisma(), entry);
}

/**
 * Records one platform action through `db`: pass the transaction of the change it
 * describes, so the change and its audit row commit (or roll back) together.
 */
export async function recordPlatformAuditTx(db: Pick<Prisma.TransactionClient, '$queryRaw'>, entry: PlatformAuditEntry): Promise<string> {
  if (!ACTION.test(entry.action)) throw new Error('Invalid platform audit action');
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT crm_platform_audit(${entry.adminEmail}, ${entry.action}, ${entry.accountId ?? null}::uuid, ${entry.targetRef ?? null},
      ${entry.reason ?? null}, ${JSON.stringify(entry.detail ?? {})}::jsonb, ${entry.ipHash ?? null}) AS id`;
  return String(rows[0].id);
}
