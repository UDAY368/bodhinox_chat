// Published flow versions (Phase 12, design §2.1).
//
// Publishing snapshots a flow's draft (trigger, entry, fallback policy,
// channel scope and nodes) into an immutable flow_versions row and points
// flows.published_version_id at it. Every run records the version it started
// on (flow_runs.flow_version_id) and keeps running on that snapshot: edits
// change future enrollments only. A run without a version (a draft's
// test-number run, or one started before the flow was versioned) runs on
// the live draft exactly as before.
//
// flow_versions is read and written only here, through withTenant raw SQL: it
// is not in the generic data contract, so no browser CRUD path reaches it.
import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { gateWithinLimit } from '@/lib/billing/limits';
import { loadFlowFormLookup } from '@/lib/whatsapp/forms/flow-lookup';
import { validateFlowForActivation, type CrossFlowSnapshot, type ValidationIssue } from './validate';
import type { WorkspaceCapabilities } from './node-registry';
import type { FlowChannelScope, FlowNodeRow, FlowNodeType, FlowRow, FlowTriggerConfig } from './types';

/** One node as a version stores it; positions are kept for the read-only canvas. */
export interface VersionNode {
  node_key: string;
  node_type: string;
  config: Record<string, unknown>;
  position_x?: number;
  position_y?: number;
}

export interface FlowVersionRow {
  id: string;
  account_id: string;
  flow_id: string;
  version: number;
  trigger_type: FlowRow['trigger_type'];
  trigger_config: Record<string, unknown>;
  /** Stage 5: the further triggers published with this version (empty: the primary only). Absent on rows read before Stage 5. */
  extra_triggers?: FlowTriggerConfig[];
  entry_node_id: string | null;
  fallback_policy: Record<string, unknown>;
  channel_scope: FlowChannelScope;
  nodes: VersionNode[];
  published_by: string | null;
  published_at: string;
}

/** The fields a definition hash covers; positions are layout, not behaviour. */
export interface DefinitionInput {
  trigger_type: string;
  trigger_config: unknown;
  /** Stage 5: counted only when non-empty, so every definition without extra triggers hashes exactly as before. */
  extra_triggers?: unknown;
  entry_node_id: string | null;
  fallback_policy: unknown;
  channel_scope?: string | null;
  nodes: ReadonlyArray<{ node_key: string; node_type: string; config: unknown }>;
}

/** A flow overlaid with the version it runs on: trigger, entry, fallback and scope come from the version. */
export type EffectiveFlow = FlowRow & { version_id?: string | null; version?: number };

export class FlowVersionError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'draft_changed'
      | 'invalid'
      | 'not_published'
      | 'active_runs'
      | 'nothing_to_migrate',
    public readonly status: number,
    public readonly detail: Record<string, unknown> = {},
  ) {
    super(code);
    this.name = 'FlowVersionError';
  }
}

// ============================================================
// Pure: canonical form and hash
// ============================================================

/** JSON with object keys sorted at every depth, so equal definitions serialise equally. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${sortedJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** The stable form of a flow definition. Node order and canvas positions do not count. */
export function canonicalDefinition(def: DefinitionInput): string {
  const nodes = [...def.nodes]
    .map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config ?? {} }))
    .sort((a, b) => (a.node_key < b.node_key ? -1 : a.node_key > b.node_key ? 1 : 0));
  return sortedJson({
    trigger_type: def.trigger_type,
    trigger_config: def.trigger_config ?? {},
    entry_node_id: def.entry_node_id ?? null,
    fallback_policy: def.fallback_policy ?? {},
    channel_scope: def.channel_scope ?? 'whatsapp',
    nodes,
    ...(Array.isArray(def.extra_triggers) && def.extra_triggers.length ? { extra_triggers: def.extra_triggers } : {}),
  });
}

export function definitionHash(def: DefinitionInput): string {
  return createHash('sha256').update(canonicalDefinition(def)).digest('hex');
}

/** Whether the draft differs from the version that is live (no version: always). */
export function hasUnpublishedChanges(draft: DefinitionInput, version: DefinitionInput | null): boolean {
  return !version || definitionHash(draft) !== definitionHash(version);
}

/** The flow as it runs on `version`: live routing (number, status, test numbers) stays the flow's. */
export function effectiveFlow(flow: FlowRow, version: FlowVersionRow): EffectiveFlow {
  return {
    ...flow,
    trigger_type: version.trigger_type,
    trigger_config: version.trigger_config,
    // Stage 5: matching reads the published extra triggers, never the draft's.
    extra_triggers: Array.isArray(version.extra_triggers) ? version.extra_triggers : [],
    entry_node_id: version.entry_node_id,
    fallback_policy: version.fallback_policy as unknown as FlowRow['fallback_policy'],
    channel_scope: version.channel_scope,
    version_id: version.id,
    version: version.version,
  };
}

/** A version's nodes keyed by node_key, shaped like flow_nodes rows for the engine. */
export function versionNodeMap(version: FlowVersionRow): Map<string, FlowNodeRow> {
  const map = new Map<string, FlowNodeRow>();
  for (const n of Array.isArray(version.nodes) ? version.nodes : []) {
    if (!n || typeof n.node_key !== 'string' || map.has(n.node_key)) continue;
    map.set(n.node_key, {
      id: `${version.id}:${n.node_key}`,
      flow_id: version.flow_id,
      node_key: n.node_key,
      node_type: n.node_type as FlowNodeType,
      config: (n.config ?? {}) as Record<string, unknown>,
      position_x: Number(n.position_x ?? 0),
      position_y: Number(n.position_y ?? 0),
      created_at: version.published_at,
    });
  }
  return map;
}

// ============================================================
// Reads (worker connection for the engine; any tenant transaction for routes)
// ============================================================

type VersionDbRow = Omit<FlowVersionRow, 'published_at'> & { published_at: Date | string };

const VERSION_COLUMNS = Prisma.sql`id::text, account_id::text, flow_id::text, version, trigger_type, trigger_config, extra_triggers,
  entry_node_id, fallback_policy, channel_scope, nodes, published_by::text, published_at`;

function toVersion(row: VersionDbRow): FlowVersionRow {
  return { ...row, published_at: row.published_at instanceof Date ? row.published_at.toISOString() : String(row.published_at) };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: unknown): value is string => typeof value === 'string' && UUID.test(value);

export async function readVersion(tx: TenantTransaction, accountId: string, versionId: string): Promise<FlowVersionRow | null> {
  if (!isUuid(versionId)) return null;
  const rows = await tx.$queryRaw<VersionDbRow[]>(Prisma.sql`SELECT ${VERSION_COLUMNS} FROM flow_versions
    WHERE account_id=${accountId}::uuid AND id=${versionId}::uuid`);
  return rows[0] ? toVersion(rows[0]) : null;
}

/** One version, read by the engine on the worker connection. */
export async function loadVersion(accountId: string, versionId: string): Promise<FlowVersionRow | null> {
  return withTenant({ accountId, role: 'owner' }, (tx) => readVersion(tx, accountId, versionId), getWorkerPrisma());
}

/** Several versions by id (the published ones of the active flows), read on the worker connection. */
export async function loadPublishedVersions(accountId: string, versionIds: string[]): Promise<Map<string, FlowVersionRow>> {
  const ids = [...new Set(versionIds.filter(isUuid))];
  if (!ids.length) return new Map();
  const rows = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<VersionDbRow[]>(Prisma.sql`
    SELECT ${VERSION_COLUMNS} FROM flow_versions WHERE account_id=${accountId}::uuid AND id = ANY(${ids}::uuid[])`), getWorkerPrisma());
  return new Map(rows.map((r) => [r.id, toVersion(r)]));
}

// ============================================================
// Publish
// ============================================================

interface FlowLockRow {
  id: string;
  name: string;
  status: FlowRow['status'];
  trigger_type: FlowRow['trigger_type'];
  trigger_config: Record<string, unknown> | null;
  extra_triggers: FlowTriggerConfig[] | null;
  entry_node_id: string | null;
  fallback_policy: Record<string, unknown> | null;
  channel_scope: FlowChannelScope | null;
  published_version_id: string | null;
}

async function lockFlow(tx: TenantTransaction, accountId: string, flowId: string): Promise<FlowLockRow> {
  if (!isUuid(flowId)) throw new FlowVersionError('not_found', 404);
  const rows = await tx.$queryRaw<FlowLockRow[]>(Prisma.sql`SELECT id::text, name, status, trigger_type, trigger_config, extra_triggers,
      entry_node_id, fallback_policy, channel_scope, published_version_id::text
    FROM flows WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid FOR UPDATE`);
  if (!rows[0]) throw new FlowVersionError('not_found', 404);
  return rows[0];
}

async function readDraftNodes(tx: TenantTransaction, accountId: string, flowId: string): Promise<VersionNode[]> {
  return tx.$queryRaw<VersionNode[]>(Prisma.sql`SELECT node_key, node_type, config, position_x, position_y
    FROM flow_nodes WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid ORDER BY node_key`);
}

function draftDefinition(flow: FlowLockRow, nodes: VersionNode[]): DefinitionInput {
  return {
    trigger_type: flow.trigger_type,
    trigger_config: flow.trigger_config ?? {},
    extra_triggers: flow.extra_triggers ?? [],
    entry_node_id: flow.entry_node_id,
    fallback_policy: flow.fallback_policy ?? {},
    channel_scope: flow.channel_scope ?? 'whatsapp',
    nodes,
  };
}

/**
 * The published graphs of every other active or paused flow, for the
 * cross-flow loop check. An active flow not yet versioned (a deploy-window
 * straggler) counts with its live draft, since that is what it runs.
 */
async function otherFlowSnapshots(tx: TenantTransaction, accountId: string, flowId: string): Promise<CrossFlowSnapshot[]> {
  const versioned = await tx.$queryRaw<{ id: string; name: string; entry_node_id: string | null; nodes: VersionNode[] }[]>(Prisma.sql`
    SELECT f.id::text, f.name, v.entry_node_id, v.nodes FROM flows f
    JOIN flow_versions v ON v.account_id=f.account_id AND v.id=f.published_version_id
    WHERE f.account_id=${accountId}::uuid AND f.id<>${flowId}::uuid AND f.status IN ('active','paused')`);
  const stragglers = await tx.$queryRaw<{ id: string; name: string; entry_node_id: string | null; nodes: VersionNode[] | null }[]>(Prisma.sql`
    SELECT f.id::text, f.name, f.entry_node_id,
      (SELECT jsonb_agg(jsonb_build_object('node_key',n.node_key,'node_type',n.node_type,'config',n.config))
        FROM flow_nodes n WHERE n.account_id=f.account_id AND n.flow_id=f.id) AS nodes
    FROM flows f WHERE f.account_id=${accountId}::uuid AND f.id<>${flowId}::uuid AND f.status='active' AND f.published_version_id IS NULL`);
  return [...versioned, ...stragglers].map((f) => ({ id: f.id, name: f.name, entry_node_id: f.entry_node_id, nodes: f.nodes ?? [] }));
}

const audit = (tx: TenantTransaction, accountId: string, userId: string, action: string, flowId: string, metadata: Record<string, unknown>) =>
  tx.$executeRaw(Prisma.sql`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${accountId}::uuid,${userId}::uuid,${action},${flowId},${JSON.stringify(metadata)}::jsonb)`);

/** Serialises publish, resume, the active-flow plan count and the cross-flow loop check per account. */
export async function lockAccountPublishing(tx: TenantTransaction, accountId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`flows-publish:${accountId}`}, 0))`);
}

export interface PublishArgs {
  accountId: string;
  flowId: string;
  userId: string;
  /** The draft hash the author saw; a different draft is refused with draft_changed (409). */
  expectedDraftHash?: string;
  /** The workspace's provider capabilities (loaded on the worker connection before the transaction). */
  caps: Partial<WorkspaceCapabilities>;
}

export interface PublishResult {
  flow: FlowRow;
  version: { id: string; version: number };
  reused: boolean;
}

/** The account's paid appointment services, read only when the graph has a booking step. */
async function paidServicesFor(tx: TenantTransaction, accountId: string, nodes: ReadonlyArray<{ node_type: string }>): Promise<ReadonlySet<string> | undefined> {
  if (!nodes.some((n) => n.node_type === 'book_appointment')) return undefined;
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text AS id FROM appointment_services
    WHERE account_id=${accountId}::uuid AND payment_required`);
  return new Set(rows.map((r) => r.id.toLowerCase()));
}

/**
 * Publishes (or resumes) a flow inside the caller's tenant transaction, which
 * must carry the publisher's live session (app connection, role >= agent):
 * the insert policy requires published_by = app_user_id(). Throws
 * FlowVersionError (draft_changed 409, invalid 422 with issues) or the plan
 * limit error.
 */
export async function publishFlow(tx: TenantTransaction, args: PublishArgs): Promise<PublishResult> {
  const { accountId, flowId, userId } = args;
  await lockAccountPublishing(tx, accountId);
  const flow = await lockFlow(tx, accountId, flowId);
  const nodes = await readDraftNodes(tx, accountId, flowId);
  const draft = draftDefinition(flow, nodes);
  const draftHash = definitionHash(draft);
  if (args.expectedDraftHash !== undefined && args.expectedDraftHash !== draftHash) {
    throw new FlowVersionError('draft_changed', 409, { draft_hash: draftHash });
  }
  const forms = nodes.some((n) => n.node_type === 'send_form') ? await loadFlowFormLookup(tx, accountId) : undefined;
  const paidServices = await paidServicesFor(tx, accountId, nodes);
  const otherFlows = await otherFlowSnapshots(tx, accountId, flowId);
  const issues: ValidationIssue[] = validateFlowForActivation({
    id: flowId,
    name: flow.name,
    trigger_type: flow.trigger_type,
    trigger_config: flow.trigger_config ?? {},
    extra_triggers: flow.extra_triggers ?? [],
    entry_node_id: flow.entry_node_id,
    fallback_policy: flow.fallback_policy ?? {},
    channel_scope: flow.channel_scope,
  }, nodes, { forms, caps: args.caps, otherFlows, paidServices });
  if (issues.some((i) => i.severity === 'error')) throw new FlowVersionError('invalid', 422, { issues });

  // Plan cap on live flows (testing drafts count, they run too); this flow does not count twice.
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM flows
    WHERE account_id=${accountId}::uuid AND id<>${flowId}::uuid
    AND (status='active' OR (status='draft' AND (cardinality(test_numbers)>0 OR cardinality(test_usernames)>0)))`);
  await gateWithinLimit(tx, accountId, 'active_flows', n + 1);

  const current = flow.published_version_id ? await readVersion(tx, accountId, flow.published_version_id) : null;
  let version: { id: string; version: number };
  let reused = false;
  if (current && current.flow_id === flowId && definitionHash(current) === draftHash) {
    version = { id: current.id, version: current.version };
    reused = true;
  } else {
    const snapshot = nodes.map((node) => ({ node_key: node.node_key, node_type: node.node_type, config: node.config ?? {},
      position_x: Number(node.position_x ?? 0), position_y: Number(node.position_y ?? 0) }));
    const [row] = await tx.$queryRaw<{ id: string; version: number }[]>(Prisma.sql`INSERT INTO flow_versions(account_id, flow_id,
        version, trigger_type, trigger_config, extra_triggers, entry_node_id, fallback_policy, channel_scope, nodes, published_by)
      VALUES (${accountId}::uuid, ${flowId}::uuid,
        (SELECT COALESCE(max(version),0)+1 FROM flow_versions WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid),
        ${flow.trigger_type}, ${JSON.stringify(flow.trigger_config ?? {})}::jsonb, ${JSON.stringify(flow.extra_triggers ?? [])}::jsonb,
        ${flow.entry_node_id},
        ${JSON.stringify(flow.fallback_policy ?? {})}::jsonb, ${flow.channel_scope ?? 'whatsapp'}, ${JSON.stringify(snapshot)}::jsonb,
        ${userId}::uuid)
      RETURNING id::text, version`);
    version = row;
  }
  // archived_at cleared: a flow the plan had archived is live again by the
  // member's choice, so billing restore() must not treat a later user archive
  // as plan-archived (and revive it). See clearPlanArchive.
  const [updated] = await tx.$queryRaw<FlowRow[]>(Prisma.sql`UPDATE flows SET status='active', published_version_id=${version.id}::uuid,
      test_numbers='{}', test_usernames='{}', archived_at=NULL, updated_at=now()
    WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid RETURNING *`);
  await clearPlanArchive(tx, accountId, flowId);
  // Draft test-number runs (and deploy-window stragglers) are unpinned and
  // would otherwise keep running the live draft, which is edited without
  // validation once the flow is published. The new version is a snapshot of
  // the draft just validated, so every current step exists in it.
  await tx.$executeRaw(Prisma.sql`UPDATE flow_runs SET flow_version_id=${version.id}::uuid
    WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid AND status='active' AND flow_version_id IS NULL`);
  await audit(tx, accountId, userId, 'flows.published', flowId, { version: version.version, reused, resumed: flow.status === 'paused' });
  return { flow: updated, version, reused };
}

// ============================================================
// Pause / archive
// ============================================================

/**
 * Marks the flow's open plan_archives row restored. The flow was taken out of
 * the plan archive by a member (publish or pause), so restore() must not act
 * on it later. Needs admin under the plan_archives policy; for an agent the
 * update matches nothing, and archived_at=NULL on the flow already keeps
 * restore() away from it.
 */
async function clearPlanArchive(tx: TenantTransaction, accountId: string, flowId: string): Promise<void> {
  await tx.$executeRaw(Prisma.sql`UPDATE plan_archives SET restored_at=now()
    WHERE account_id=${accountId}::uuid AND kind='flows' AND item_id=${flowId}::uuid AND restored_at IS NULL`);
}

/** Ends the flow's active runs (optionally only those on one version), returning how many. */
async function cancelFlowRuns(tx: TenantTransaction, accountId: string, flowId: string, reason: string,
  filter: { versionId?: string; runId?: string } = {}): Promise<number> {
  return tx.$executeRaw(Prisma.sql`UPDATE flow_runs SET status='cancelled', ended_at=now(), end_reason=${reason}, wait_until=NULL
    WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid AND status='active'
    ${filter.versionId ? Prisma.sql`AND flow_version_id=${filter.versionId}::uuid` : Prisma.empty}
    ${filter.runId ? Prisma.sql`AND id=${filter.runId}::uuid` : Prisma.empty}`);
}

export async function countActiveRuns(tx: TenantTransaction, accountId: string, flowId: string): Promise<number> {
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM flow_runs
    WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid AND status='active'`);
  return n;
}

/**
 * Pauses a published flow: no new enrollments, and runs already in progress
 * finish on their version unless cancelActive ends them now ('flow_paused').
 */
export async function pauseFlow(tx: TenantTransaction, args: { accountId: string; flowId: string; userId: string; cancelActive: boolean }):
  Promise<{ flow: FlowRow; cancelled: number }> {
  const flow = await lockFlow(tx, args.accountId, args.flowId);
  if (!flow.published_version_id) throw new FlowVersionError('not_published', 409);
  const cancelled = args.cancelActive ? await cancelFlowRuns(tx, args.accountId, args.flowId, 'flow_paused') : 0;
  const [updated] = await tx.$queryRaw<FlowRow[]>(Prisma.sql`UPDATE flows SET status='paused', archived_at=NULL, updated_at=now()
    WHERE account_id=${args.accountId}::uuid AND id=${args.flowId}::uuid RETURNING *`);
  await clearPlanArchive(tx, args.accountId, args.flowId);
  await audit(tx, args.accountId, args.userId, 'flows.paused', args.flowId, { cancelled });
  return { flow: updated, cancelled };
}

/**
 * Archives a flow. With runs in progress it is refused (active_runs, 409)
 * unless cancelActive ends them now ('flow_archived'). archived_at is not
 * set: that column means "off because of the plan".
 */
export async function archiveFlow(tx: TenantTransaction, args: { accountId: string; flowId: string; userId: string; cancelActive: boolean }):
  Promise<{ flow: FlowRow; cancelled: number }> {
  await lockFlow(tx, args.accountId, args.flowId);
  const active = await countActiveRuns(tx, args.accountId, args.flowId);
  if (active > 0 && !args.cancelActive) throw new FlowVersionError('active_runs', 409, { active_runs: active });
  const cancelled = active > 0 ? await cancelFlowRuns(tx, args.accountId, args.flowId, 'flow_archived') : 0;
  const [updated] = await tx.$queryRaw<FlowRow[]>(Prisma.sql`UPDATE flows SET status='archived', updated_at=now()
    WHERE account_id=${args.accountId}::uuid AND id=${args.flowId}::uuid RETURNING *`);
  await audit(tx, args.accountId, args.userId, 'flows.archived', args.flowId, { cancelled });
  return { flow: updated, cancelled };
}

/**
 * The old "back to draft" request. A published flow is paused instead (its
 * runs finish on their version). A flow never published keeps the pre-Phase
 * 12 meaning: a draft, which runs only for its test numbers, so a draft with
 * test numbers must pass validation and take a plan slot like a live flow.
 */
export async function moveToDraft(tx: TenantTransaction, args: { accountId: string; flowId: string; userId: string }):
  Promise<{ flow: FlowRow; paused: boolean }> {
  // The account publish lock first (publishFlow's order), so the active-flow count below is
  // serialised with every publish and test start: two cannot take the same plan slot.
  await lockAccountPublishing(tx, args.accountId);
  const flow = await lockFlow(tx, args.accountId, args.flowId);
  if (flow.published_version_id) {
    const paused = await pauseFlow(tx, { ...args, cancelActive: false });
    return { flow: paused.flow, paused: true };
  }
  const [{ testing }] = await tx.$queryRaw<{ testing: boolean }[]>(Prisma.sql`SELECT (cardinality(test_numbers)>0 OR cardinality(test_usernames)>0) AS testing
    FROM flows WHERE account_id=${args.accountId}::uuid AND id=${args.flowId}::uuid`);
  if (testing) {
    const nodes = await readDraftNodes(tx, args.accountId, args.flowId);
    const forms = nodes.some((n) => n.node_type === 'send_form') ? await loadFlowFormLookup(tx, args.accountId) : undefined;
    const paidServices = await paidServicesFor(tx, args.accountId, nodes);
    const issues = validateFlowForActivation({
      id: args.flowId, name: flow.name, trigger_type: flow.trigger_type, trigger_config: flow.trigger_config ?? {},
      extra_triggers: flow.extra_triggers ?? [], entry_node_id: flow.entry_node_id, fallback_policy: flow.fallback_policy ?? {}, channel_scope: flow.channel_scope,
    }, nodes, { forms, paidServices });
    if (issues.some((i) => i.severity === 'error')) throw new FlowVersionError('invalid', 422, { issues });
    const [{ n }] = await tx.$queryRaw<{ n: number }[]>(Prisma.sql`SELECT count(*)::int AS n FROM flows
      WHERE account_id=${args.accountId}::uuid AND id<>${args.flowId}::uuid
      AND (status='active' OR (status='draft' AND (cardinality(test_numbers)>0 OR cardinality(test_usernames)>0)))`);
    await gateWithinLimit(tx, args.accountId, 'active_flows', n + 1);
  }
  const [updated] = await tx.$queryRaw<FlowRow[]>(Prisma.sql`UPDATE flows SET status='draft', updated_at=now()
    WHERE account_id=${args.accountId}::uuid AND id=${args.flowId}::uuid RETURNING *`);
  return { flow: updated, paused: false };
}

// ============================================================
// Run migration and cancellation
// ============================================================

/**
 * Node types a waiting run may be moved between versions at. A booking step
 * is left out on purpose: its in-progress answers refer to the old step's
 * services and staff.
 */
const MIGRATABLE_WAITS = new Set(['send_buttons', 'send_list', 'send_form', 'collect_input', 'ask_media', 'ask_location', 'ask_address']);

/**
 * Seconds a run must have been still (no advance and no run event, such as
 * reply_received) before it may move. reply_received is logged as soon as a
 * reply starts being handled, so a reply in flight keeps its run on its
 * version; what remains is a reply whose engine load lands just before the
 * migrate commits, which the engine's version-checked claims then refuse.
 */
export const MIGRATE_IDLE_SECONDS = 60;

/**
 * The interactive contract of a waiting step that the customer already has
 * on their phone: the reply ids of its buttons or list rows, or its form.
 * A run may only move when the new step accepts the same taps.
 */
function waitContract(node: { node_type: string; config?: Record<string, unknown> | null }): string {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  const ids = (items: unknown): string[] => (Array.isArray(items) ? items : [])
    .map((item) => String((item as { reply_id?: unknown })?.reply_id ?? ''));
  if (node.node_type === 'send_buttons') return JSON.stringify(ids(cfg.buttons).sort());
  if (node.node_type === 'send_list') {
    const sections = Array.isArray(cfg.sections) ? cfg.sections : [];
    return JSON.stringify(sections.flatMap((section) => ids((section as { rows?: unknown })?.rows)).sort());
  }
  if (node.node_type === 'send_form') return String(cfg.form_id ?? '');
  return '';
}

/**
 * Whether a run waiting at `nodeKey` on `from` may continue on `to`: the same
 * step, of the same type, exists there and accepts the same replies (button
 * and list reply ids, or the same form).
 */
export function migratableAt(nodeKey: string | null, from: FlowVersionRow, to: FlowVersionRow): boolean {
  if (!nodeKey) return false;
  const before = versionNodeMap(from).get(nodeKey);
  const after = versionNodeMap(to).get(nodeKey);
  return Boolean(before && after && MIGRATABLE_WAITS.has(before.node_type) && after.node_type === before.node_type
    && waitContract(before) === waitContract(after));
}

/** No advance and no run event within MIGRATE_IDLE_SECONDS (alias r). */
const runIsIdle = Prisma.sql`(r.delay_until IS NULL AND r.last_advanced_at < now() - interval '60 seconds'
  AND NOT EXISTS (SELECT 1 FROM flow_run_events e WHERE e.account_id=r.account_id AND e.flow_run_id=r.id
    AND e.created_at > now() - interval '60 seconds'))`;

export interface MigrateResult {
  migrated: number;
  left: Array<{ node_key: string | null; count: number }>;
  to_version: number;
}

/**
 * Moves the waiting, idle runs of one old version onto the flow's live
 * version, inside the caller's tenant transaction. transition_seq is not
 * bumped: pending reply timeouts are keyed by it. The engine's claims
 * compare the run's version too, so one racing this update fails cleanly.
 */
export async function migrateRuns(tx: TenantTransaction, args: { accountId: string; flowId: string; userId: string; fromVersionId: string }):
  Promise<MigrateResult> {
  const { accountId, flowId } = args;
  const flow = await lockFlow(tx, accountId, flowId);
  const from = await readVersion(tx, accountId, args.fromVersionId);
  if (!from || from.flow_id !== flowId) throw new FlowVersionError('not_found', 404);
  const to = flow.published_version_id ? await readVersion(tx, accountId, flow.published_version_id) : null;
  if (!to || to.flow_id !== flowId || to.id === from.id) throw new FlowVersionError('nothing_to_migrate', 409);
  const runs = await tx.$queryRaw<{ id: string; current_node_key: string | null; idle: boolean }[]>(Prisma.sql`
    SELECT r.id::text, r.current_node_key, ${runIsIdle} AS idle
    FROM flow_runs r WHERE r.account_id=${accountId}::uuid AND r.flow_id=${flowId}::uuid
      AND r.flow_version_id=${from.id}::uuid AND r.status='active'`);
  const eligible = runs.filter((r) => r.idle && migratableAt(r.current_node_key, from, to));
  let moved: { id: string }[] = [];
  if (eligible.length) {
    // The position and idleness are checked again in the UPDATE itself, so a run that moved since is left alone.
    moved = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`UPDATE flow_runs r SET flow_version_id=${to.id}::uuid
      FROM unnest(${eligible.map((r) => r.id)}::uuid[], ${eligible.map((r) => r.current_node_key!)}::text[]) AS x(id, node_key)
      WHERE r.account_id=${accountId}::uuid AND r.flow_id=${flowId}::uuid AND r.id=x.id AND r.current_node_key=x.node_key
        AND r.flow_version_id=${from.id}::uuid AND r.status='active' AND ${runIsIdle}
      RETURNING r.id::text`);
  }
  const movedIds = new Set(moved.map((r) => r.id));
  if (moved.length) {
    // One 'migrated' event per moved run, so its timeline shows the switch.
    const payload = JSON.stringify({ by: args.userId, from_version: from.version, to_version: to.version });
    await tx.$executeRaw(Prisma.sql`INSERT INTO flow_run_events(account_id,flow_run_id,event_type,node_key,payload)
      SELECT ${accountId}::uuid, r.id, 'migrated', r.current_node_key, ${payload}::jsonb
      FROM flow_runs r WHERE r.account_id=${accountId}::uuid AND r.id = ANY(${[...movedIds]}::uuid[])`);
  }
  const left = new Map<string | null, number>();
  for (const r of runs) if (!movedIds.has(r.id)) left.set(r.current_node_key, (left.get(r.current_node_key) ?? 0) + 1);
  await audit(tx, accountId, args.userId, 'flows.runs_migrated', flowId, { from_version: from.version, to_version: to.version, migrated: movedIds.size });
  return { migrated: movedIds.size, left: [...left].map(([node_key, count]) => ({ node_key, count })), to_version: to.version };
}

/** Ends active runs of the flow, all of one version or one run, as 'cancelled_by_member'. */
export async function cancelRuns(tx: TenantTransaction, args: { accountId: string; flowId: string; userId: string; versionId?: string; runId?: string }):
  Promise<{ cancelled: number }> {
  await lockFlow(tx, args.accountId, args.flowId);
  if (args.versionId) {
    const version = await readVersion(tx, args.accountId, args.versionId);
    if (!version || version.flow_id !== args.flowId) throw new FlowVersionError('not_found', 404);
  }
  const cancelled = await cancelFlowRuns(tx, args.accountId, args.flowId, 'cancelled_by_member', { versionId: args.versionId, runId: args.runId });
  await audit(tx, args.accountId, args.userId, 'flows.runs_cancelled', args.flowId,
    { cancelled, ...(args.versionId ? { version_id: args.versionId } : {}), ...(args.runId ? { run_id: args.runId } : {}) });
  return { cancelled };
}

// ============================================================
// Draft save
// ============================================================

/** Draft columns PUT /api/flows/[id] may change. */
export interface DraftPatch {
  name?: string;
  description?: string | null;
  trigger_type?: string;
  trigger_config?: Record<string, unknown>;
  entry_node_id?: string | null;
  fallback_policy?: Record<string, unknown>;
  test_numbers?: string[];
  channel_scope?: FlowChannelScope;
  /** Stage 5: further triggers (Instagram flows; validated on publish). */
  extra_triggers?: FlowTriggerConfig[];
  /** Stage 5: Instagram usernames a draft runs for (lowercase, no @). */
  test_usernames?: string[];
}

/**
 * Saves the draft in the caller's tenant transaction: the flow row first
 * (taking the row lock publishFlow takes, so a publish never sees half a
 * save), then the whole node list replaced. Nothing here touches a published
 * version. Throws not_found when the flow is not the caller's.
 */
export async function saveDraft(tx: TenantTransaction, args: {
  accountId: string; flowId: string; patch: DraftPatch; nodes?: VersionNode[];
  /**
   * Stage 5 autosave: the draft's updated_at the editor last saw (ISO). When
   * the stored draft is newer (compared at millisecond precision, the
   * precision the browser has), nothing is written and draft_changed (409,
   * detail.stale_draft) is thrown. Absent: saved as before.
   */
  baseUpdatedAt?: string;
}): Promise<void> {
  const { accountId, flowId, patch } = args;
  if (!isUuid(flowId)) throw new FlowVersionError('not_found', 404);
  if (args.baseUpdatedAt !== undefined) {
    // Under the row lock, so two saves from two tabs cannot both pass the check.
    const [row] = await tx.$queryRaw<{ newer: boolean; updated_at: Date | null }[]>(Prisma.sql`SELECT
        date_trunc('milliseconds', updated_at) > ${args.baseUpdatedAt}::timestamptz AS newer, updated_at
      FROM flows WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid FOR UPDATE`);
    if (!row) throw new FlowVersionError('not_found', 404);
    if (row.newer) {
      throw new FlowVersionError('draft_changed', 409, { stale_draft: true, updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null });
    }
  }
  const sets: Prisma.Sql[] = [Prisma.sql`updated_at=now()`];
  if (patch.name !== undefined) sets.push(Prisma.sql`name=${patch.name}`);
  if (patch.description !== undefined) sets.push(Prisma.sql`description=${patch.description}`);
  if (patch.trigger_type !== undefined) sets.push(Prisma.sql`trigger_type=${patch.trigger_type}`);
  if (patch.trigger_config !== undefined) sets.push(Prisma.sql`trigger_config=${JSON.stringify(patch.trigger_config)}::jsonb`);
  if (patch.entry_node_id !== undefined) sets.push(Prisma.sql`entry_node_id=${patch.entry_node_id}`);
  if (patch.fallback_policy !== undefined) sets.push(Prisma.sql`fallback_policy=${JSON.stringify(patch.fallback_policy)}::jsonb`);
  if (patch.test_numbers !== undefined) sets.push(Prisma.sql`test_numbers=${patch.test_numbers}::text[]`);
  if (patch.channel_scope !== undefined) sets.push(Prisma.sql`channel_scope=${patch.channel_scope}`);
  if (patch.extra_triggers !== undefined) sets.push(Prisma.sql`extra_triggers=${JSON.stringify(patch.extra_triggers)}::jsonb`);
  if (patch.test_usernames !== undefined) sets.push(Prisma.sql`test_usernames=${patch.test_usernames}::text[]`);
  const updated = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`UPDATE flows SET ${Prisma.join(sets, ', ')}
    WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid RETURNING id::text`);
  if (!updated.length) throw new FlowVersionError('not_found', 404);
  if (args.nodes === undefined) return;
  await tx.$executeRaw(Prisma.sql`DELETE FROM flow_nodes WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid`);
  if (!args.nodes.length) return;
  const rows = args.nodes.map((n) => ({ node_key: n.node_key, node_type: n.node_type, config: n.config ?? {},
    position_x: Number(n.position_x ?? 0) || 0, position_y: Number(n.position_y ?? 0) || 0 }));
  // created_at follows the list order, which GET returns the nodes in.
  await tx.$executeRaw(Prisma.sql`INSERT INTO flow_nodes(account_id, flow_id, node_key, node_type, config, position_x, position_y, created_at)
    SELECT ${accountId}::uuid, ${flowId}::uuid, x.node_key, x.node_type, COALESCE(x.config, '{}'::jsonb),
      round(x.position_x)::int, round(x.position_y)::int, now() + (x.ord * interval '1 microsecond')
    FROM ROWS FROM (jsonb_to_recordset(${JSON.stringify(rows)}::jsonb)
        AS (node_key text, node_type text, config jsonb, position_x double precision, position_y double precision))
      WITH ORDINALITY AS x(node_key, node_type, config, position_x, position_y, ord)`);
}

// ============================================================
// Listing for the builder
// ============================================================

export interface VersionSummary {
  id: string;
  version: number;
  published_at: string;
  published_by_name: string | null;
  node_count: number;
  active_runs: number;
}

export async function listVersions(tx: TenantTransaction, accountId: string, flowId: string): Promise<VersionSummary[]> {
  const rows = await tx.$queryRaw<(Omit<VersionSummary, 'published_at'> & { published_at: Date })[]>(Prisma.sql`
    SELECT v.id::text, v.version, v.published_at, p.full_name AS published_by_name, jsonb_array_length(v.nodes)::int AS node_count,
      (SELECT count(*)::int FROM flow_runs r WHERE r.account_id=v.account_id AND r.flow_version_id=v.id AND r.status='active') AS active_runs
    FROM flow_versions v
    LEFT JOIN profiles p ON p.user_id=v.published_by
    WHERE v.account_id=${accountId}::uuid AND v.flow_id=${flowId}::uuid
    ORDER BY v.version DESC LIMIT 200`);
  return rows.map((r) => ({ ...r, published_at: r.published_at.toISOString() }));
}

/** Per-step counts for the builder (Stage 5): runs waiting at a step now, and runs that went past it. */
export interface NodeStat {
  waiting: number;
  passed: number;
}

/**
 * Waiting and passed counts per node_key of one flow, from run state: waiting
 * is the flow's active runs whose current step it is (a smart delay, a
 * question), passed is the runs that entered the step minus those still
 * waiting there. Null when the flow is not this workspace's. Counts only.
 */
export async function readNodeStats(tx: TenantTransaction, accountId: string, flowId: string): Promise<Record<string, NodeStat> | null> {
  if (!isUuid(flowId)) return null;
  const [flow] = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT id::text FROM flows
    WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid`);
  if (!flow) return null;
  const rows = await tx.$queryRaw<{ node_key: string; waiting: number; entered: number }[]>(Prisma.sql`
    WITH waiting AS (
      SELECT current_node_key AS node_key, count(*)::int AS n FROM flow_runs
      WHERE account_id=${accountId}::uuid AND flow_id=${flowId}::uuid AND status='active' AND current_node_key IS NOT NULL
      GROUP BY current_node_key
    ), entered AS (
      SELECT e.node_key, count(DISTINCT e.flow_run_id)::int AS n FROM flow_run_events e
      JOIN flow_runs r ON r.account_id=e.account_id AND r.id=e.flow_run_id
      WHERE r.account_id=${accountId}::uuid AND r.flow_id=${flowId}::uuid AND e.account_id=${accountId}::uuid
        AND e.event_type='node_entered' AND e.node_key IS NOT NULL
      GROUP BY e.node_key
    )
    SELECT COALESCE(w.node_key, x.node_key) AS node_key, COALESCE(w.n, 0) AS waiting, COALESCE(x.n, 0) AS entered
    FROM waiting w FULL JOIN entered x ON x.node_key=w.node_key
    LIMIT 500`);
  const stats: Record<string, NodeStat> = {};
  for (const row of rows) stats[row.node_key] = { waiting: row.waiting, passed: Math.max(0, row.entered - row.waiting) };
  return stats;
}

export interface PublishState {
  published_version: { id: string; version: number } | null;
  draft_hash: string;
  has_unpublished_changes: boolean;
}

/** What the builder shows next to the draft: the live version and whether the draft differs from it. */
export async function readPublishState(tx: TenantTransaction, accountId: string, flowId: string): Promise<PublishState | null> {
  if (!isUuid(flowId)) return null;
  const flows = await tx.$queryRaw<FlowLockRow[]>(Prisma.sql`SELECT id::text, name, status, trigger_type, trigger_config, extra_triggers,
      entry_node_id, fallback_policy, channel_scope, published_version_id::text
    FROM flows WHERE account_id=${accountId}::uuid AND id=${flowId}::uuid`);
  const flow = flows[0];
  if (!flow) return null;
  const draft = draftDefinition(flow, await readDraftNodes(tx, accountId, flowId));
  const live = flow.published_version_id ? await readVersion(tx, accountId, flow.published_version_id) : null;
  return {
    published_version: live ? { id: live.id, version: live.version } : null,
    draft_hash: definitionHash(draft),
    has_unpublished_changes: hasUnpublishedChanges(draft, live),
  };
}
