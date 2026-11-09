// Integration health from stored status columns only: no provider call runs
// on load.
//
// Tenant: one row per connected integration of the caller's workspace (app
// role, withTenant, column-level grants), with its status, last success,
// last error code and where to fix it. Never tokens, secrets or key ids.
//
// Platform: per-workspace attention counts (crm_platform_integration_health)
// the job / webhook backlog (crm_platform_job_backlog) and recent failed jobs, each requeueable
// (crm_platform_requeue_job, audited; never one whose provider outcome is uncertain). The platform key
// id is passed only while SaaS billing is configured, so the shared-key check
// is a no-op without BILLING_RAZORPAY_* keys.

import { AuthError } from '@/lib/auth/errors';
import { billingConfigured } from '@/lib/billing/razorpay-billing';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { PlatformAdmin, PlatformFailedJobRow, PlatformIntegrationHealthRow, PlatformJobBacklogRow } from '@/types/platform';
import { platformFailedJobs, platformIntegrationHealth, platformJobBacklog, platformRequeueJob } from './db';

export type IntegrationKind = 'whatsapp' | 'instagram' | 'meta_ads' | 'shopify' | 'woocommerce' | 'meetings' | 'courier' | 'razorpay';
export type HealthState = 'ok' | 'attention' | 'disconnected';

export interface IntegrationHealthRow {
  kind: IntegrationKind;
  id: string;
  /** A display name the workspace already sees in its settings (number name, @username, shop domain). */
  label: string | null;
  /** The provider-specific stored status ('active', 'token_invalid', ...). */
  status: string;
  state: HealthState;
  lastSuccessAt: string | null;
  lastErrorCode: string | null;
  tokenExpiresAt: string | null;
  /** Settings section to fix it. */
  href: string;
}

const HREF: Record<IntegrationKind, string> = {
  whatsapp: '/settings?tab=whatsapp', instagram: '/settings?tab=instagram', meta_ads: '/settings?tab=ads',
  shopify: '/settings?tab=connections', woocommerce: '/settings?tab=connections', meetings: '/settings?tab=connections',
  courier: '/settings?tab=connections', razorpay: '/settings?tab=payments',
};

const EXPIRY_WARNING_MS = 7 * 86_400_000;
const iso = (v: Date | null | undefined): string | null => (v ? v.toISOString() : null);

type Row = Record<string, unknown>;
const date = (v: unknown): Date | null => (v instanceof Date ? v : null);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);

function oauthState(status: string, lastErrorCode: string | null, tokenExpiresAt: Date | null, now: number): HealthState {
  if (status === 'disconnected') return 'disconnected';
  if (status !== 'active' || lastErrorCode) return 'attention';
  if (tokenExpiresAt && tokenExpiresAt.getTime() - now < EXPIRY_WARNING_MS) return 'attention';
  return 'ok';
}

/** Every connected integration of the workspace, from stored columns. Run inside withTenant (any member). */
export async function loadIntegrationHealth(tx: TenantTransaction, accountId: string, now = Date.now()): Promise<IntegrationHealthRow[]> {
  // One interactive transaction runs its statements one at a time.
  const numbers = await tx.$queryRaw<Row[]>`SELECT id, display_name, status, quality_rating, health_checked_at, health_error, health_error_at,
        access_token <> '' AS has_token
      FROM whatsapp_config WHERE account_id=${accountId}::uuid ORDER BY is_default DESC, created_at`;
  const instagram = await tx.$queryRaw<Row[]>`SELECT id, username, status, last_webhook_at, last_error_code, token_expires_at
      FROM instagram_accounts WHERE account_id=${accountId}::uuid AND status <> 'disconnected' ORDER BY connected_at`;
  const ads = await tx.$queryRaw<Row[]>`SELECT id, ad_account_name, status, insights_synced_at, last_error_code, token_expires_at
      FROM meta_ad_connections WHERE account_id=${accountId}::uuid AND status <> 'disconnected' ORDER BY created_at`;
  const shopify = await tx.$queryRaw<Row[]>`SELECT id, shop_domain, installed_at FROM shopify_stores
      WHERE account_id=${accountId}::uuid AND uninstalled_at IS NULL ORDER BY installed_at`;
  const woo = await tx.$queryRaw<Row[]>`SELECT id, store_url, connected_at FROM woocommerce_stores WHERE account_id=${accountId}::uuid ORDER BY connected_at`;
  const meetings = await tx.$queryRaw<Row[]>`SELECT id, provider, status, connected_at, last_error_code FROM meeting_connections
      WHERE account_id=${accountId}::uuid AND status <> 'disconnected' ORDER BY connected_at`;
  const courier = await tx.$queryRaw<Row[]>`SELECT id, provider, status, connected_at, last_error_code FROM courier_connections
      WHERE account_id=${accountId}::uuid AND status <> 'disconnected' ORDER BY connected_at`;
  const razorpay = await tx.$queryRaw<Row[]>`SELECT id, mode, connected_at FROM payment_providers WHERE account_id=${accountId}::uuid ORDER BY connected_at`;
  const rows: IntegrationHealthRow[] = [];
  for (const r of numbers) {
    const status = String(r.status);
    const checked = date(r.health_checked_at), failed = date(r.health_error_at);
    const failing = failed !== null && (checked === null || failed.getTime() >= checked.getTime());
    const disconnected = status === 'disconnected' || r.has_token !== true;
    rows.push({
      kind: 'whatsapp', id: String(r.id), label: text(r.display_name), status,
      state: disconnected ? 'disconnected' : failing || String(r.quality_rating ?? '').toUpperCase() === 'RED' ? 'attention' : 'ok',
      lastSuccessAt: iso(checked), lastErrorCode: failing ? text(r.health_error) ?? 'health_check_failed' : null, tokenExpiresAt: null, href: HREF.whatsapp,
    });
  }
  for (const r of instagram) {
    const status = String(r.status), code = text(r.last_error_code), expires = date(r.token_expires_at);
    rows.push({ kind: 'instagram', id: String(r.id), label: text(r.username), status, state: oauthState(status, code, expires, now),
      lastSuccessAt: iso(date(r.last_webhook_at)), lastErrorCode: code, tokenExpiresAt: iso(expires), href: HREF.instagram });
  }
  for (const r of ads) {
    const status = String(r.status), code = text(r.last_error_code), expires = date(r.token_expires_at);
    rows.push({ kind: 'meta_ads', id: String(r.id), label: text(r.ad_account_name), status,
      state: status === 'pending' ? 'attention' : oauthState(status, code, expires, now),
      lastSuccessAt: iso(date(r.insights_synced_at)), lastErrorCode: code, tokenExpiresAt: iso(expires), href: HREF.meta_ads });
  }
  for (const r of shopify)
    rows.push({ kind: 'shopify', id: String(r.id), label: text(r.shop_domain), status: 'active', state: 'ok',
      lastSuccessAt: iso(date(r.installed_at)), lastErrorCode: null, tokenExpiresAt: null, href: HREF.shopify });
  for (const r of woo)
    rows.push({ kind: 'woocommerce', id: String(r.id), label: text(r.store_url), status: 'active', state: 'ok',
      lastSuccessAt: iso(date(r.connected_at)), lastErrorCode: null, tokenExpiresAt: null, href: HREF.woocommerce });
  for (const [kind, list] of [['meetings', meetings], ['courier', courier]] as const)
    for (const r of list) {
      const status = String(r.status), code = text(r.last_error_code);
      rows.push({ kind, id: String(r.id), label: text(r.provider), status, state: oauthState(status, code, null, now),
        lastSuccessAt: iso(date(r.connected_at)), lastErrorCode: code, tokenExpiresAt: null, href: HREF[kind] });
    }
  for (const r of razorpay)
    rows.push({ kind: 'razorpay', id: String(r.id), label: text(r.mode), status: 'active', state: 'ok',
      lastSuccessAt: iso(date(r.connected_at)), lastErrorCode: null, tokenExpiresAt: null, href: HREF.razorpay });
  return rows;
}

export interface PlatformHealth {
  integrations: PlatformIntegrationHealthRow[];
  backlog: PlatformJobBacklogRow[];
  /** Failed jobs of the last 7 days, newest first (at most 50), for requeue. */
  failedJobs: PlatformFailedJobRow[];
  /** False when SaaS billing has no keys: the shared-key check did not run. */
  sharedKeyCheck: boolean;
}

export async function loadPlatformHealth(env: Record<string, string | undefined> = process.env): Promise<PlatformHealth> {
  const configured = billingConfigured(env);
  const keyId = configured ? env.BILLING_RAZORPAY_KEY_ID?.trim() || null : null;
  const [integrations, backlog, failedJobs] = await Promise.all([platformIntegrationHealth(keyId), platformJobBacklog(), platformFailedJobs()]);
  return { integrations, backlog, failedJobs, sharedKeyCheck: keyId !== null };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Body { reason (3..1000) }: puts one failed job back in the queue with a fresh attempt budget,
 * audited with the session admin's email. 404 unknown, 409 'not_failed' (already pending, running or
 * done) or 'needs_reconciliation' (its provider outcome is uncertain: never re-run blindly).
 */
export async function requeueFailedJob(admin: PlatformAdmin, id: string, raw: unknown): Promise<void> {
  if (!UUID.test(id)) throw new AuthError('Not found', 404, 'not_found');
  const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
  if (reason.length < 3 || reason.length > 1000) throw new AuthError('reason_required', 400, 'reason_required');
  const outcome = await platformRequeueJob(id, admin.email, reason);
  if (outcome === 'requeued') return;
  if (outcome === 'not_failed' || outcome === 'needs_reconciliation') throw new AuthError(outcome, 409, outcome);
  throw new AuthError('Not found', 404, 'not_found');
}
