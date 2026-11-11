// Tracked links for flow buttons (Stage 5, 5F; 5B calls trackedUrl and
// linkClicked from the engine).
//
//   trackedUrl     creates (or reuses, by run, node key and slot) a 32-hex token
//                  in flow_tracked_links and returns `<app origin>/r/<token>`.
//                  A retried send therefore sends the same link.
//   /r/<token>     looks up campaign tokens first (unchanged), then flow tokens
//                  (recordFlowClick / flowClickDestination below): the first
//                  click sets first_clicked_at, every recorded click raises the
//                  count, and a run started from a comment marks the comment
//                  funnel's link_clicked step.
//   linkClicked    whether a step's tracked link was opened (the `link_click`
//                  condition).
//   flowLinkStats  CTR per flow: runs with at least one click / runs that were
//                  sent a tracked link (a flow with no tracked link has no CTR).
//
// Writes run as the worker role inside withTenant (FORCE RLS); the app role
// reads rows for CTR but never the token. Nothing here logs a URL, a token or
// anything about the contact.
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { appOrigin } from '@/lib/broadcasts/tracking';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { markCommentFunnelStepTx } from '@/lib/instagram/comment-funnel';
import { isDryRun } from '@/lib/runtime/dry-run-guard';
import type { FlowRunRow } from './types';

/** The run fields link tracking needs. */
export type TrackedLinkRun = Pick<FlowRunRow, 'id' | 'account_id' | 'flow_id' | 'contact_id' | 'conversation_id'>;

export const FLOW_LINK_TOKEN = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_MAX = 200;

/**
 * A destination a flow link may redirect to: an absolute http(s) URL without
 * credentials, at most 2,048 characters (the column's own check).
 */
export function validFlowLinkUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** `<app origin>/r/<token>`. */
export function flowLinkUrl(token: string, origin = appOrigin()): string {
  return `${origin}/r/${token}`;
}

const validKey = (value: string) => typeof value === 'string' && value.length >= 1 && value.length <= KEY_MAX;

/**
 * The URL to send for a button. Returns the tracked `/r/<token>` link, reusing
 * the token of an earlier attempt of the same run, step and slot. Returns `url`
 * unchanged (untracked) for a destination that is not a valid http(s) URL, for
 * malformed run fields, and inside a flow dry run (which may not write).
 */
export async function trackedUrl(run: TrackedLinkRun, nodeKey: string, slot: string, url: string): Promise<string> {
  if (isDryRun() || !validFlowLinkUrl(url) || !validKey(nodeKey) || !validKey(slot)) return url;
  if (!UUID.test(run.account_id) || !UUID.test(run.id) || !UUID.test(run.flow_id)) return url;
  const token = randomBytes(16).toString('hex');
  const rows = await withTenant({ accountId: run.account_id, role: 'owner' }, async (tx) => {
    await tx.$executeRaw`INSERT INTO flow_tracked_links(account_id,token,flow_id,flow_run_id,node_key,slot,contact_id,conversation_id,url)
      VALUES(${run.account_id}::uuid,${token},${run.flow_id}::uuid,${run.id}::uuid,${nodeKey},${slot},
        ${run.contact_id ?? null}::uuid,${run.conversation_id ?? null}::uuid,${url})
      ON CONFLICT (account_id, flow_run_id, node_key, slot) DO NOTHING`;
    return tx.$queryRaw<{ token: string }[]>`SELECT token FROM flow_tracked_links
      WHERE account_id=${run.account_id}::uuid AND flow_run_id=${run.id}::uuid AND node_key=${nodeKey} AND slot=${slot}`;
  }, getWorkerPrisma());
  const stored = rows[0]?.token?.trim();
  return stored && FLOW_LINK_TOKEN.test(stored) ? flowLinkUrl(stored) : url;
}

/** Whether the contact opened a tracked link sent by this run's step `nodeKey`. */
export async function linkClicked(accountId: string, runId: string, nodeKey: string): Promise<boolean> {
  if (!UUID.test(accountId) || !UUID.test(runId) || !validKey(nodeKey)) return false;
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ clicked: boolean }[]>`
    SELECT EXISTS(SELECT 1 FROM flow_tracked_links WHERE account_id=${accountId}::uuid AND flow_run_id=${runId}::uuid
      AND node_key=${nodeKey} AND first_clicked_at IS NOT NULL) AS clicked`, getWorkerPrisma());
  return rows[0]?.clicked === true;
}

interface ResolvedFlowLink {
  account_id: string;
  link_id: string;
  flow_run_id: string;
  url: string;
}

async function resolveFlowToken(token: string): Promise<ResolvedFlowLink | null> {
  if (!FLOW_LINK_TOKEN.test(token)) return null;
  const [hit] = await getWorkerPrisma().$queryRaw<ResolvedFlowLink[]>`
    SELECT account_id::text, link_id::text, flow_run_id::text, url FROM resolve_flow_link_token(${token})`;
  return hit && validFlowLinkUrl(hit.url) ? hit : null;
}

/** The destination of a flow token without recording anything (rate-limited repeat hits). */
export async function flowClickDestination(token: string): Promise<string | null> {
  return (await resolveFlowToken(token))?.url ?? null;
}

/**
 * Records a click on a flow token and returns its destination, or null for an
 * unknown token. The first click stamps first_clicked_at; the comment funnel's
 * link_clicked step is marked once when the run came from a comment.
 */
export async function recordFlowClick(token: string): Promise<string | null> {
  const hit = await resolveFlowToken(token);
  if (!hit) return null;
  await withTenant({ accountId: hit.account_id, role: 'owner' }, async (tx) => {
    await tx.$executeRaw`UPDATE flow_tracked_links
      SET click_count=click_count+1, first_clicked_at=COALESCE(first_clicked_at, now())
      WHERE account_id=${hit.account_id}::uuid AND id=${hit.link_id}::uuid`;
    await markCommentFunnelStepTx(tx, hit.account_id, hit.flow_run_id, 'link_clicked');
  }, getWorkerPrisma());
  return hit.url;
}

/** Runs that were sent a tracked link, and how many of them had a click. */
export interface FlowLinkStats {
  sent: number;
  clicked: number;
}

/**
 * Click-through rate as a whole percent: runs with a click over runs sent a
 * tracked link. Null when no run was sent a tracked link (the UI shows a dash,
 * not 0%).
 */
export function clickThroughRate(stats: FlowLinkStats | null | undefined): number | null {
  if (!stats || !(stats.sent > 0)) return null;
  const clicked = Math.min(Math.max(stats.clicked, 0), stats.sent);
  return Math.round((clicked / stats.sent) * 100);
}

/**
 * Link stats per flow (all time, or from `since`), inside the caller's tenant
 * transaction. Flows without a tracked link are absent from the map.
 */
export async function flowLinkStats(tx: TenantTransaction, accountId: string, flowIds: readonly string[],
  since?: Date): Promise<Map<string, FlowLinkStats>> {
  const ids = flowIds.filter((id) => UUID.test(id));
  if (!UUID.test(accountId) || ids.length === 0) return new Map();
  const after = since ? Prisma.sql`AND created_at >= ${since.toISOString()}::timestamptz` : Prisma.empty;
  const rows = await tx.$queryRaw<{ flow_id: string; sent: number; clicked: number }[]>(Prisma.sql`
    SELECT flow_id::text, count(DISTINCT flow_run_id)::int AS sent,
      count(DISTINCT flow_run_id) FILTER (WHERE first_clicked_at IS NOT NULL)::int AS clicked
    FROM flow_tracked_links
    WHERE account_id=${accountId}::uuid AND flow_id = ANY(${ids}::uuid[]) ${after}
    GROUP BY flow_id`);
  return new Map(rows.map((row) => [row.flow_id, { sent: row.sent, clicked: row.clicked }]));
}
