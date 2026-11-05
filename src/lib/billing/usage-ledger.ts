// The idempotent usage ledger (usage_events, 20261112100200_usage_ledger).
// One row per (workspace, metric, source event): a replay of the same inbound
// message, flow turn, task or request meters once. The SQL functions are
// SECURITY INVOKER and take the workspace from app_account_id(), so these
// wrappers must run inside withTenant for the workspace being metered; there
// is no account argument for a caller to get wrong.
//
//   reserveUsage  before a provider call: 'reserved', 'replay' (already settled,
//                 nothing more to meter) or 'over_limit'. A reservation stops
//                 counting by itself after 15 minutes.
//   settleUsage   after the call: adds the actual quantity to usage_counters once.
//   releaseUsage  the provider definitely did not bill.
//   recordUsage   no reservation was needed (unlimited): settled once per source event.

import { createHash, randomUUID } from 'node:crypto';
import type { TenantTransaction } from '@/lib/db/tenant';

export const LEDGER_METRICS = ['ai_messages', 'ai_tokens'] as const;
export type LedgerMetric = (typeof LEDGER_METRICS)[number];
export type ReserveResult = 'reserved' | 'replay' | 'over_limit';

const SOURCE_KEY = /^[\x21-\x7e]{1,200}$/;

function check(metric: LedgerMetric, sourceKey: string): void {
  if (!LEDGER_METRICS.includes(metric)) throw new Error('Unknown ledger metric');
  if (!SOURCE_KEY.test(sourceKey)) throw new Error('Invalid usage source key');
}

const positive = (n: number) => {
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('Usage quantity must be a positive integer');
  return n;
};

/** A source key the ledger accepts: printable ASCII up to 200 characters kept as is, anything else hashed. */
export function ledgerKey(raw: string): string {
  return SOURCE_KEY.test(raw) ? raw : `h:${createHash('sha256').update(raw).digest('hex')}`;
}

/** A fresh source key for one route request (in-route retries reuse it). */
export const newRequestKey = (): string => `req:${randomUUID()}`;

export async function reserveUsage(tx: TenantTransaction, metric: LedgerMetric, sourceKey: string, quantity: number, limit: number | null): Promise<ReserveResult> {
  check(metric, sourceKey);
  positive(quantity);
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error('Invalid usage limit');
  const [row] = await tx.$queryRaw<{ result: ReserveResult }[]>`
    SELECT billing_reserve_usage(${metric}, ${sourceKey}, ${quantity}::bigint, ${limit}::bigint) AS result`;
  return row.result;
}

/** Settles a reservation (or a released one) and counts `actual` once. False when it was already settled. */
export async function settleUsage(tx: TenantTransaction, metric: LedgerMetric, sourceKey: string, actual: number): Promise<boolean> {
  check(metric, sourceKey);
  if (!Number.isSafeInteger(actual) || actual < 0) throw new Error('Usage quantity must not be negative');
  const [row] = await tx.$queryRaw<{ done: boolean }[]>`SELECT billing_settle_usage(${metric}, ${sourceKey}, ${actual}::bigint) AS done`;
  return row.done;
}

export async function releaseUsage(tx: TenantTransaction, metric: LedgerMetric, sourceKey: string): Promise<boolean> {
  check(metric, sourceKey);
  const [row] = await tx.$queryRaw<{ done: boolean }[]>`SELECT billing_release_usage(${metric}, ${sourceKey}) AS done`;
  return row.done;
}

/** Records usage that needed no reservation. False when this source event was already recorded. */
export async function recordUsage(tx: TenantTransaction, metric: LedgerMetric, sourceKey: string, quantity: number): Promise<boolean> {
  check(metric, sourceKey);
  positive(quantity);
  const [row] = await tx.$queryRaw<{ done: boolean }[]>`SELECT billing_record_usage(${metric}, ${sourceKey}, ${quantity}::bigint) AS done`;
  return row.done;
}
