// Flow engine, run group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { instagramFactsFrom, normalizeTestUsername, type InstagramInboundFacts } from "../triggers";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { effectiveFlow, loadVersion, versionNodeMap, type EffectiveFlow } from "../versions";
import { databaseAdmin } from "../admin-client";
import { scopeIncludes, triggerAvailableOn, type Channel } from "@/lib/channels/capabilities";
import { type FlowNodeRow, type FlowRow, type FlowRunRow, type TriggerFrequency } from "../types";

export type AdminClient = ReturnType<typeof databaseAdmin>;

export async function loadActiveRunForConversation(
  db: AdminClient,
  accountId: string,
  contactId: string,
  conversationId: string,
): Promise<FlowRunRow | null> {
  // Only the run on this inbound's conversation may answer it (see the
  // multi-number policy in the header). The partial unique index
  // `idx_one_active_run_per_conversation` makes two active runs on one
  // conversation impossible, but .maybeSingle() would throw on >1 row
  // after manual SQL and kill dispatch for the conversation; .limit(1)
  // picks the newest and lets the cron sweep clean up the stale one.
  const { data, error } = await db
    .from("flow_runs")
    .select("*")
    .eq("account_id", accountId)
    .eq("contact_id", contactId)
    .eq("conversation_id", conversationId)
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(1);
  if (error) {
    console.error("[flows] loadActiveRunForConversation error:", error.message);
    return null;
  }
  const rows = (data as FlowRunRow[] | null) ?? [];
  return rows[0] ?? null;
}

export async function loadFlow(
  db: AdminClient,
  flowId: string,
): Promise<FlowRow | null> {
  const { data, error } = await db
    .from("flows")
    .select("*")
    .eq("id", flowId)
    .maybeSingle();
  if (error) {
    console.error("[flows] loadFlow error:", error.message);
    return null;
  }
  return (data as FlowRow | null) ?? null;
}

/**
 * Load every node of a flow in one round trip and key them by
 * `node_key`. The advance loop is then in-memory — a 5-node
 * auto-advancing chain costs one SELECT, not five.
 *
 * Returns an empty map on error so the caller can still dispatch
 * cleanly (every subsequent .get() returns undefined → the run
 * fails with node_not_found, same as the old per-node lookup).
 */
export async function loadAllNodes(
  db: AdminClient,
  flowId: string,
): Promise<Map<string, FlowNodeRow>> {
  const { data, error } = await db
    .from("flow_nodes")
    .select("*")
    .eq("flow_id", flowId);
  if (error) {
    console.error("[flows] loadAllNodes error:", error.message);
    return new Map();
  }
  const map = new Map<string, FlowNodeRow>();
  for (const row of (data ?? []) as FlowNodeRow[]) {
    map.set(row.node_key, row);
  }
  return map;
}

/**
 * The graph a run executes (Phase 12). A run pinned to a version runs on that
 * version's snapshot, with the flow's trigger, entry, fallback policy and
 * scope taken from the version; the flow's status and number stay live. An
 * unpinned run (a draft's test-number run, or one started before the flow
 * was versioned) runs on the live draft as before. A pinned version that
 * cannot be found gives an empty graph, which ends the run cleanly.
 */
export async function loadRunGraph(
  db: AdminClient,
  run: Pick<FlowRunRow, "account_id" | "flow_id"> & { flow_version_id?: string | null },
): Promise<{ flow: EffectiveFlow | null; nodes: Map<string, FlowNodeRow> }> {
  if (!run.flow_version_id) {
    const [flow, nodes] = await Promise.all([loadFlow(db, run.flow_id), loadAllNodes(db, run.flow_id)]);
    return { flow, nodes };
  }
  const [flow, version] = await Promise.all([loadFlow(db, run.flow_id), loadVersion(run.account_id, run.flow_version_id)]);
  if (!flow || !version || version.flow_id !== run.flow_id) return { flow, nodes: new Map() };
  return { flow: effectiveFlow(flow, version), nodes: versionNodeMap(version) };
}

/**
 * The graph a new run of `flow` starts on: its published version, or the live
 * draft for a draft being tested and for an active flow not yet versioned (a
 * deploy-window straggler, logged). Null when the published version is gone.
 */
export async function startGraph(
  db: AdminClient,
  flow: FlowRow,
): Promise<{ flow: EffectiveFlow; nodes: Map<string, FlowNodeRow> } | null> {
  if (flow.published_version_id && flow.status !== "draft") {
    const version = await loadVersion(flow.account_id, flow.published_version_id);
    if (!version || version.flow_id !== flow.id) return null;
    return { flow: effectiveFlow(flow, version), nodes: versionNodeMap(version) };
  }
  if (flow.status === "active") console.warn("[flows] unversioned active flow", { flowId: flow.id });
  return { flow, nodes: await loadAllNodes(db, flow.id) };
}

/** The fallback policy a run follows: its version's, or the live flow's when unpinned. */
export async function runFallbackPolicy(db: AdminClient, run: FlowRunRow): Promise<FlowRow["fallback_policy"] | undefined> {
  if (run.flow_version_id) {
    const version = await loadVersion(run.account_id, run.flow_version_id);
    return version?.fallback_policy as FlowRow["fallback_policy"] | undefined;
  }
  return (await loadFlow(db, run.flow_id))?.fallback_policy;
}

export async function logEvent(
  db: AdminClient,
  flowRunId: string,
  event_type:
    | "started"
    | "node_entered"
    | "message_sent"
    | "reply_received"
    | "fallback_fired"
    | "handoff"
    | "timeout"
    | "error"
    | "completed"
    | "delay_scheduled"
    | "input_invalid"
    | "attribute_set"
    | "api_request"
    | "flow_connected"
    | "agent_assigned"
    | "form_sent"
    | "form_submitted"
    | "payment_link_sent"
    | "payment_received"
    | "payment_expired"
    | "ai_replied"
    | "ai_handoff"
    | "conversion_queued"
    | "ad_click",
  node_key: string | null,
  payload: Record<string, unknown> = {},
): Promise<void> {
  const { error } = await db.from("flow_run_events").insert({
    flow_run_id: flowRunId,
    event_type,
    node_key,
    payload,
  });
  if (error) {
    // Logging failure is non-fatal — surface but don't throw.
    console.error("[flows] logEvent error:", error.message);
  }
}

/**
 * Idempotency check — has a `reply_received` event with this Meta
 * message_id already been recorded for any of the contact's flow
 * runs? If yes, the inbound is a duplicate (Meta retry) and we
 * exit without re-advancing.
 *
 * Implementation note: scoped to runs belonging to this user/contact
 * so the lookup is cheap (the index on flow_run_events(flow_run_id,
 * event_type) plus the small set of runs per contact).
 */
export async function isDuplicateInbound(
  db: AdminClient,
  accountId: string,
  contactId: string,
  metaMessageId: string,
): Promise<boolean> {
  // Fetch ALL run ids for this contact in this account (active +
  // historical). Bounded by how many flows the customer has been
  // through — small.
  const { data: runs } = await db
    .from("flow_runs")
    .select("id")
    .eq("account_id", accountId)
    .eq("contact_id", contactId);
  if (!runs?.length) return false;
  const runIds = runs.map((r) => (r as { id: string }).id);

  const { count } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .in("flow_run_id", runIds)
    .eq("event_type", "reply_received")
    .filter("payload->>meta_message_id", "eq", metaMessageId);
  return (count ?? 0) > 0;
}

/**
 * Whether a flow listens on the number an inbound arrived on. A flow tied to a
 * number (flows.whatsapp_config_id) starts only for messages on it; an untied
 * flow (null, every flow before multi-number) starts on every number.
 */
export function flowListensOnNumber(
  flow: { whatsapp_config_id?: string | null },
  inboundNumberId: string | null,
): boolean {
  const tied = flow.whatsapp_config_id ?? null;
  return !tied || tied === inboundNumberId;
}

/**
 * Whether a flow may start on a conversation (Phase 11). The flow's
 * channel_scope must include the conversation's channel. On WhatsApp the
 * number tie applies as before; on Instagram the number tie is ignored and
 * only the triggers Instagram supports can start a run.
 */
export function flowListensOnConversation(
  flow: Pick<FlowRow, "channel_scope" | "whatsapp_config_id" | "trigger_type">,
  conversation: { channel: Channel; whatsappConfigId: string | null },
): boolean {
  if (!scopeIncludes(flow.channel_scope, conversation.channel)) return false;
  if (conversation.channel === "instagram") return triggerAvailableOn(flow.trigger_type, "instagram");
  return flowListensOnNumber(flow, conversation.whatsappConfigId);
}

/** The contact's stored Instagram username on the conversation's Instagram account, lowercase; "" when none. */
export async function storedInstagramUsername(accountId: string, contactId: string, conversationId: string): Promise<string> {
  const rows = await withTenant({ accountId, role: "owner" }, (tx) => tx.$queryRaw<{ username: string | null }[]>`
    SELECT i.username FROM conversations v JOIN contact_channel_identities i ON i.account_id=v.account_id
      AND i.contact_id=v.contact_id AND i.instagram_account_id=v.instagram_account_id AND i.channel='instagram'
    WHERE v.account_id=${accountId}::uuid AND v.id=${conversationId}::uuid AND v.contact_id=${contactId}::uuid AND v.channel='instagram'
    LIMIT 1`, getWorkerPrisma());
  return normalizeTestUsername(rows[0]?.username);
}

/** What the stored Instagram message is (a story reply or mention); an unreadable row is an ordinary message. */
export async function storedInstagramFacts(db: AdminClient, accountId: string, conversationId: string, metaMessageId: string): Promise<InstagramInboundFacts> {
  const { data, error } = await db.from("messages").select("interactive_payload")
    .eq("account_id", accountId).eq("conversation_id", conversationId).eq("message_id", metaMessageId).maybeSingle();
  if (error || !data) return {};
  return instagramFactsFrom((data as { interactive_payload?: unknown }).interactive_payload);
}

/**
 * Whether a once-limited trigger may start this flow for the contact again:
 * `once_per_24h` allows one run per contact in any 24 hours. A failed lookup
 * says no, so a database hiccup never repeats a message.
 */
export async function frequencyAllows(db: AdminClient, accountId: string, flowId: string, contactId: string,
  frequency: TriggerFrequency | undefined): Promise<boolean> {
  if (frequency !== "once_per_24h") return true;
  const since = new Date(Date.now() - 24 * 3_600_000).toISOString();
  const { count, error } = await db.from("flow_runs").select("id", { count: "exact", head: true })
    .eq("account_id", accountId).eq("flow_id", flowId).eq("contact_id", contactId).gte("started_at", since);
  return !error && (count ?? 0) === 0;
}
