// Instagram › Ref links (Stage 3): the ref links a workspace can share, one per
// ref key of each of its ig_ref flows and per Instagram account the flow
// listens on. Read-only; creating a link is creating an ig_ref flow in the
// flow builder, which validates the keys on publish.
//
// Any member may read it (as the member, app role). The plan feature, the
// workspace filter and RLS all keep another workspace's flows and accounts
// out. A draft flow's keys are listed but marked draft: its link starts
// nothing until the flow is published. Nothing about people is read.
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant } from '@/lib/db/tenant';
import { instagramConfig } from './config';
import type { InstagramActor } from './connection';
import { InstagramError } from './errors';
import { isRefKey, refLinkUrl } from './ref-links';

export interface RefLinkRow {
  flowId: string;
  flowName: string;
  flowStatus: 'draft' | 'active' | 'paused';
  key: string;
  instagramAccountId: string;
  username: string | null;
  /** The https://ig.me link, or null when the account has no username yet. */
  url: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_FLOWS = 200;

interface FlowRow { id: string; name: string; status: string; trigger_config: unknown }
interface AccountRow { id: string; username: string | null }

/** The keys and the account an ig_ref trigger lists, read leniently (anything malformed is skipped). */
export function refsOfTrigger(config: unknown): { keys: string[]; instagramAccountId: string | null } {
  const row = config && typeof config === 'object' ? config as Record<string, unknown> : {};
  const keys = Array.isArray(row.refs) ? [...new Set(row.refs.filter(isRefKey))] : [];
  const account = typeof row.instagram_account_id === 'string' && UUID.test(row.instagram_account_id)
    ? row.instagram_account_id.toLowerCase() : null;
  return { keys, instagramAccountId: account };
}

/** Pure: one row per flow, key and account (all connected accounts when the trigger names none). */
export function buildRefLinks(flows: readonly FlowRow[], accounts: readonly AccountRow[]): RefLinkRow[] {
  const rows: RefLinkRow[] = [];
  for (const flow of flows) {
    if (flow.status !== 'draft' && flow.status !== 'active' && flow.status !== 'paused') continue;
    const { keys, instagramAccountId } = refsOfTrigger(flow.trigger_config);
    const targets = instagramAccountId ? accounts.filter((a) => a.id.toLowerCase() === instagramAccountId) : accounts;
    for (const key of keys) {
      for (const account of targets) {
        rows.push({
          flowId: flow.id, flowName: flow.name, flowStatus: flow.status, key, instagramAccountId: account.id,
          username: account.username, url: account.username ? refLinkUrl(account.username, key) : null,
        });
      }
    }
  }
  return rows;
}

/** Any member: the workspace's ref links. */
export async function listRefLinks(actor: InstagramActor): Promise<RefLinkRow[]> {
  if (!instagramConfig()) throw new InstagramError('instagram_not_enabled');
  return withTenant(actor, async (tx) => {
    await requireFeature(tx, actor.accountId, 'instagram');
    const accounts = await tx.$queryRaw<AccountRow[]>`SELECT id::text AS id, username FROM instagram_accounts
      WHERE account_id=${actor.accountId}::uuid AND status<>'disconnected' ORDER BY created_at, id LIMIT 50`;
    if (!accounts.length) return [];
    // A live flow's published version is what runs; a draft has only its own trigger.
    const flows = await tx.$queryRaw<FlowRow[]>`SELECT f.id::text AS id, f.name, f.status,
        COALESCE(v.trigger_config, f.trigger_config) AS trigger_config
      FROM flows f LEFT JOIN flow_versions v ON v.account_id=f.account_id AND v.id=f.published_version_id AND v.flow_id=f.id
      WHERE f.account_id=${actor.accountId}::uuid AND f.trigger_type='ig_ref' AND f.status IN ('draft','active','paused')
        AND f.channel_scope IN ('instagram','any')
      ORDER BY f.created_at, f.id LIMIT ${MAX_FLOWS}`;
    return buildRefLinks(flows, accounts);
  });
}
