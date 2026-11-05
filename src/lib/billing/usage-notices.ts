// Usage warnings at 80% and 100% of a FINITE plan limit: one usage_notices row
// per (workspace, limit, IST month, threshold), inserted ON CONFLICT DO NOTHING,
// and only when the row is new a 'billing' notification to owners/admins plus
// the existing billing.email job (recordBillingNotice). Unlimited keys never
// emit anything, so no existing workspace is notified.
//
// Metered keys (AI messages, AI tokens) are checked when usage settles; count
// keys emit the 100% notice when a gate refuses. Notices carry the limit name
// and numbers only. usage_notices is written by the worker role only.

import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { recordBillingNotice } from './billing-notify';
import { getEntitlements } from './entitlements';
import { USAGE_NOTICE_THRESHOLDS, type LimitKey } from './entitlements-catalogue';
import type { BillingNotice } from './lifecycle';
import { usagePeriod } from './usage';

export type NoticeThreshold = (typeof USAGE_NOTICE_THRESHOLDS)[number];

/** The thresholds `used` has reached for a finite `limit` (none for an unlimited one). */
export function reachedThresholds(used: number, limit: number | null): NoticeThreshold[] {
  if (limit === null || !Number.isFinite(used)) return [];
  if (limit <= 0) return [...USAGE_NOTICE_THRESHOLDS];
  return USAGE_NOTICE_THRESHOLDS.filter((t) => used * 100 >= limit * t);
}

/** The billing notice kind for a threshold (Billing.notices.usage_warning / usage_reached). */
const noticeFor = (threshold: NoticeThreshold): BillingNotice => (threshold >= 100 ? 'usage_reached' : 'usage_warning');

/**
 * Inside the caller's WORKER tenant transaction: records each threshold `used`
 * has reached, once per IST month, and notifies once for the highest new row
 * (reaching 100% at once does not also send the 80% warning). Returns the
 * thresholds that were new.
 */
export async function recordUsageNotices(tx: TenantTransaction, accountId: string, input: {
  key: LimitKey; used: number; limit: number | null; planName: string; at?: Date;
}): Promise<NoticeThreshold[]> {
  const reached = reachedThresholds(input.used, input.limit);
  if (!reached.length || input.limit === null) return [];
  const period = usagePeriod(input.at);
  const label = getT('Settings.plan.limits')(input.key);
  const fresh: NoticeThreshold[] = [];
  for (const threshold of reached) {
    const inserted = await tx.$executeRaw`INSERT INTO usage_notices(account_id, limit_key, period, threshold, limit_value, used_value)
      VALUES (${accountId}::uuid, ${input.key}, ${period}, ${threshold}, ${input.limit}, ${Math.max(0, Math.floor(input.used))})
      ON CONFLICT (account_id, limit_key, period, threshold) DO NOTHING`;
    if (inserted) fresh.push(threshold);
  }
  const top = fresh.at(-1);
  if (top !== undefined) {
    await recordBillingNotice(tx, accountId, noticeFor(top), `usage:${input.key}:${period}:${top}`, {
      plan: input.planName,
      number: `${label}: ${Math.floor(input.used).toLocaleString('en')}/${input.limit.toLocaleString('en')}`,
    });
  }
  return fresh;
}

/**
 * A gate refused `key`: records the 100% notice in its own worker transaction
 * (the refused one rolls back). Never throws: a refusal must reach the member
 * whatever happens to the notice.
 */
export async function notifyLimitRefused(accountId: string, key: LimitKey): Promise<void> {
  try {
    await withTenant({ accountId, role: 'owner' }, async (tx) => {
      const e = await getEntitlements(tx, accountId);
      const limit = e.limits[key];
      if (limit === null) return;
      await recordUsageNotices(tx, accountId, { key, used: limit, limit, planName: e.planName });
    }, getWorkerPrisma());
  } catch (error) {
    console.error('[billing] usage notice failed', { key, error: error instanceof Error ? error.name : 'unknown' });
  }
}
