// Connected integrations for the plan's 'integrations' limit. Counts exactly
// what crm_platform_usage_value(account, 'integrations') counts
// (20261112100100_plan_versions): payment_providers rows, shopify_stores not
// uninstalled, woocommerce_stores rows, and meeting_connections /
// courier_connections / meta_ad_connections whose status is not 'disconnected'.
// Only account_id, status and uninstalled_at are read, which both the app and
// worker roles may select.
//
// The gate (requireIntegrationRoom in limits.ts) runs only where a NEW
// connection row is created; reconnecting or updating an existing one never
// checks, so no connected integration is refused.

import type { TenantTransaction } from '@/lib/db/tenant';

export async function countIntegrations(tx: TenantTransaction, accountId: string): Promise<number> {
  const [row] = await tx.$queryRaw<{ n: number }[]>`SELECT (
      (SELECT count(*) FROM payment_providers x WHERE x.account_id=${accountId}::uuid)
    + (SELECT count(*) FROM shopify_stores x WHERE x.account_id=${accountId}::uuid AND x.uninstalled_at IS NULL)
    + (SELECT count(*) FROM woocommerce_stores x WHERE x.account_id=${accountId}::uuid)
    + (SELECT count(*) FROM meeting_connections x WHERE x.account_id=${accountId}::uuid AND x.status<>'disconnected')
    + (SELECT count(*) FROM courier_connections x WHERE x.account_id=${accountId}::uuid AND x.status<>'disconnected')
    + (SELECT count(*) FROM meta_ad_connections x WHERE x.account_id=${accountId}::uuid AND x.status<>'disconnected')
    )::int AS n`;
  return row?.n ?? 0;
}
