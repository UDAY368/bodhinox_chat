// Server-side loader for the workspace capabilities the node registry gates
// on (Phase 12, design §6.2). Reads existing configuration only, as booleans:
// never a key, token or secret. Kept apart from node-registry.ts so the
// client palette can import the registry without the database client.
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { shiprocketDisabled } from '@/lib/fulfilment/shiprocket-client';
import { zoomEnabled } from '@/lib/meetings/config';
import { googleSheetsEnabled } from '@/lib/integrations/google-sheets/config';
import type { WorkspaceCapabilities } from './node-registry';

interface CapabilityRow {
  payments: boolean;
  appointments: boolean;
  ai: boolean;
  capi: boolean;
  commerce: boolean;
  meetings: boolean;
  shipping: boolean;
  sheets: boolean;
}

/**
 * Reads the capabilities inside an existing tenant transaction. Use a worker
 * transaction (as loadWorkspaceCapabilities does): some of these tables are
 * readable by the app role only from agent or admin, and a capability must
 * not depend on who asks.
 */
export async function readWorkspaceCapabilities(tx: TenantTransaction, accountId: string,
  env: Record<string, string | undefined> = process.env): Promise<WorkspaceCapabilities> {
  const [row] = await tx.$queryRaw<CapabilityRow[]>(Prisma.sql`SELECT
    EXISTS (SELECT 1 FROM payment_providers WHERE account_id=${accountId}::uuid) AS payments,
    EXISTS (SELECT 1 FROM appointment_services WHERE account_id=${accountId}::uuid AND archived_at IS NULL) AS appointments,
    EXISTS (SELECT 1 FROM ai_configs WHERE account_id=${accountId}::uuid AND is_active) AS ai,
    EXISTS (SELECT 1 FROM meta_ad_connections WHERE account_id=${accountId}::uuid AND status='active'
      AND capi_enabled AND capi_dataset_id IS NOT NULL) AS capi,
    EXISTS (SELECT 1 FROM commerce_settings WHERE account_id=${accountId}::uuid AND checkout_enabled) AS commerce,
    EXISTS (SELECT 1 FROM meeting_connections WHERE account_id=${accountId}::uuid AND status='active') AS meetings,
    EXISTS (SELECT 1 FROM courier_connections WHERE account_id=${accountId}::uuid AND status='active') AS shipping,
    EXISTS (SELECT 1 FROM google_sheets_connections WHERE account_id=${accountId}::uuid AND status='active') AS sheets`);
  return {
    payments: row?.payments === true,
    appointments: row?.appointments === true,
    ai: row?.ai === true,
    capi: row?.capi === true,
    commerce: row?.commerce === true,
    meetings: zoomEnabled(env) && row?.meetings === true,
    shipping: !shiprocketDisabled(env) && row?.shipping === true,
    // Stage 5: the flag and an active Google connection (5G connects it).
    sheets: googleSheetsEnabled(env) && row?.sheets === true,
  };
}

/** The workspace's capabilities, read in a tenant-scoped worker transaction. */
export async function loadWorkspaceCapabilities(ctx: TenantContext): Promise<WorkspaceCapabilities> {
  return withTenant({ accountId: ctx.accountId, userId: ctx.userId, role: ctx.role },
    (tx) => readWorkspaceCapabilities(tx, ctx.accountId), getWorkerPrisma());
}
