// Platform console: SaaS billing reconciliation (Phase 14). Server only.
// Lists and resolves billing_reconciliation_items and queues a provider
// re-fetch, all through crm_platform_* definers (audited in SQL). Resolving
// never edits a subscription or an intent; a re-fetch queues the existing
// billing.lifecycle_sweep (fetch-then-apply, safe to repeat).

import { AuthError } from '@/lib/auth/errors';
import { billingConfigured } from '@/lib/billing/razorpay-billing';
import type { PlatformAdmin, PlatformReconciliationItem, ReconciliationStatus } from '@/types/platform';
import { platformBillingRefetch, platformReconciliationList, platformReconciliationResolve } from './db';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const invalid = () => new AuthError('invalid_request', 400, 'invalid_request');

const CURSOR = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z)\|([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

/**
 * Query: status=open (default) | resolved | all, cursor=<opened_at at microsecond precision>|<item id>
 * (the previous page's nextCursor), limit=1..100 (default 50).
 */
export function parseReconciliationQuery(params: URLSearchParams): { status: ReconciliationStatus | null; cursor: { at: string; id: string } | null; limit: number } {
  const rawStatus = params.get('status') ?? 'open';
  if (!['open', 'resolved', 'all'].includes(rawStatus)) throw invalid();
  const rawCursor = params.get('cursor');
  const match = rawCursor ? CURSOR.exec(rawCursor) : null;
  if (rawCursor && (!match || Number.isNaN(new Date(match[1]).getTime()))) throw invalid();
  const cursor = match ? { at: match[1], id: match[2].toLowerCase() } : null;
  const rawLimit = params.get('limit');
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw invalid();
  return { status: rawStatus === 'all' ? null : (rawStatus as ReconciliationStatus), cursor, limit };
}

export async function listReconciliation(params: URLSearchParams): Promise<{ items: PlatformReconciliationItem[]; nextCursor: string | null }> {
  const query = parseReconciliationQuery(params);
  const rows = await platformReconciliationList(query);
  const last = rows.at(-1);
  const items: PlatformReconciliationItem[] = rows.map((row) => {
    const item: PlatformReconciliationItem & { cursorAt?: string } = { ...row };
    delete item.cursorAt;
    return item;
  });
  return { items, nextCursor: last && rows.length === query.limit ? `${last.cursorAt}|${last.id}` : null };
}

/** Body { note }: 3-1000 characters, stored with the resolution and in both audit trails. */
export async function resolveReconciliation(admin: PlatformAdmin, id: string, raw: unknown): Promise<void> {
  if (!UUID.test(id)) throw new AuthError('Not found', 404, 'not_found');
  const note = isObject(raw) && typeof raw.note === 'string' ? raw.note.trim() : '';
  if (note.length < 3 || note.length > 1000) throw new AuthError('note_required', 400, 'note_required');
  if (!(await platformReconciliationResolve(id, admin.email, note))) throw new AuthError('Not found', 404, 'not_found');
}

/** Body { accountId, reason? }: queues the lifecycle sweep for that workspace. */
export async function refetchFromProvider(admin: PlatformAdmin, raw: unknown): Promise<void> {
  if (!billingConfigured()) throw new AuthError('billing_not_configured', 503, 'billing_not_configured');
  if (!isObject(raw) || typeof raw.accountId !== 'string' || !UUID.test(raw.accountId)) throw invalid();
  const reason = typeof raw.reason === 'string' && raw.reason.trim() ? raw.reason.trim().slice(0, 500) : null;
  if (!(await platformBillingRefetch(raw.accountId, admin.email, reason)))
    throw new AuthError('no_provider_subscription', 404, 'no_provider_subscription');
}
