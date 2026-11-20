// Flow engine, start group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { botRepliesPaused } from "@/lib/whatsapp/bot-pause";
import { isTestUsername } from "../triggers";
import { decodePostback } from "@/lib/instagram/postback-payloads";
import { postCommentPublicReply } from "@/lib/instagram/private-reply";
import { pickPublicReply } from "@/lib/instagram/comment-matching";
import { validCommentReply } from "@/lib/instagram/graph-limits";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant, type TenantTransaction } from "@/lib/db/tenant";
import { effectiveFlow, loadPublishedVersions } from "../versions";
import { effectiveTriggers } from "../flow-triggers";
import { instagramAutomationAllowed } from "@/lib/contacts/channel-consent";
import { databaseAdmin } from "../admin-client";
import { scopeIncludes, type Channel } from "@/lib/channels/capabilities";
import { type DispatchInboundInput, type DispatchInboundResult, type FlowNodeRow, type FlowRow, type FlowRunRow, type TagAddedTriggerConfig, type IgCommentTriggerConfig, type IgLiveCommentTriggerConfig, startsFromComment, FLOW_TRIGGER_LIMITS } from "../types";
import { closureForActiveRun } from "./helpers";
import { type AdminClient, flowListensOnConversation, loadActiveRunForConversation, loadRunGraph, logEvent, startGraph, storedInstagramUsername } from "./run";
import { endRun, scheduleDelay } from "./control";
import { FlowAdvanceInterrupted, advanceFromNodeKey, closeActiveRun, committedRuns, continueNewRun, endInterruptedRun, guardCommitted, startNewRun } from "../engine";

/**
 * Continues a failed run that the replay route has re-opened (Phase 12,
 * design §3.3). The route checked eligibility (a transient send failure,
 * no ambiguous or accepted outbound intent for the failed step), set the run
 * active again and moved its transition_seq on, so every send here gets a
 * fresh dispatchOnce key. This re-checks that nothing moved since, then runs
 * the pinned version from `nodeKey` (the failed step; the run's current node
 * when absent). The bot-pause, blocked-contact and opt-out checks still apply.
 */
export async function replayRun(args: {
  accountId: string;
  runId: string;
  /** The transition_seq the route left the run at; a run that moved since is stale. */
  seq?: number;
  nodeKey?: string;
}): Promise<"replayed" | "stale"> {
  const db = databaseAdmin();
  const { data, error } = await db.from("flow_runs").select("*").eq("account_id", args.accountId).eq("id", args.runId).maybeSingle();
  if (error) throw new Error("Flow replay run lookup failed");
  const run = data as FlowRunRow | null;
  // Replay is for runs pinned to a version only: the graph cannot change under it.
  if (!run || run.status !== "active" || !run.flow_version_id || run.delay_until) return "stale";
  if (args.seq !== undefined && (run.transition_seq ?? 0) !== args.seq) return "stale";
  const startKey = args.nodeKey ?? run.current_node_key;
  if (!startKey) return "stale";
  const { flow, nodes } = await loadRunGraph(db, run);
  const now = new Date();
  const closure = closureForActiveRun({ run: { ...run, current_node_key: startKey }, flow, nodeKeys: nodes, now });
  if (closure) {
    await closeActiveRun(db, run, closure, now);
    return "replayed";
  }
  const { data: contact, error: contactError } = await db.from("contacts").select("blocked_at,opted_out_at")
    .eq("account_id", run.account_id).eq("id", run.contact_id!).maybeSingle();
  if (contactError) throw new Error("Flow replay contact lookup failed");
  // STOP since the failure: the replay sends nothing, like a STOP during an active run.
  if ((contact as { opted_out_at?: string | null } | null)?.opted_out_at) {
    await endRun(db, run.id, "cancelled", "contact_opted_out");
    return "replayed";
  }
  if (!run.conversation_id || !contact || (contact as { blocked_at?: string | null }).blocked_at ||
      (await botRepliesPaused(run.account_id, run.conversation_id))) {
    await endRun(db, run.id, "cancelled", "bot_paused_during_wait");
    return "replayed";
  }
  await advanceFromNodeKey(db, run, startKey, nodes);
  return "replayed";
}

/** The `flow.replay` job (queued by the replay route; registered in jobs/handlers). */
export async function handleFlowReplay(payload: { accountId: string; runId: string; seq?: number; nodeKey?: string }): Promise<"replayed" | "stale"> {
  return replayRun(payload);
}

/** Start only the selected active flow; never hijack an existing contact run. */
export async function startFlowById(input: DispatchInboundInput & {
  flowId: string;
  /** Stage 5: variables the new run starts with (a start_flow action passes its chain depth only). */
  vars?: Record<string, unknown>;
}): Promise<{ outcome: 'started' | 'unavailable' | 'conflict' }> {
  const db = databaseAdmin();
  const contact = await db.from('contacts').select('id').eq('account_id', input.accountId).eq('id', input.contactId).maybeSingle();
  const conversation = await db.from('conversations').select('id, channel').eq('account_id', input.accountId)
    .eq('id', input.conversationId).eq('contact_id', input.contactId).maybeSingle();
  if (contact.error || conversation.error) throw new Error('Explicit flow ownership lookup failed');
  if (!contact.data || !conversation.data || await botRepliesPaused(input.accountId, input.conversationId)) return { outcome: 'unavailable' };
  const target = await db.from('flows').select('*').eq('account_id', input.accountId).eq('id', input.flowId).eq('status', 'active').maybeSingle();
  if (target.error) throw new Error('Explicit flow target lookup failed');
  const flow = target.data as FlowRow | null;
  // Entry and channel scope are checked on the graph the run will start on (its published version).
  if (!flow || flow.id !== input.flowId || flow.account_id !== input.accountId || flow.status !== 'active') return { outcome: 'unavailable' };
  const channel: Channel = (conversation.data as { channel?: string | null }).channel === 'instagram' ? 'instagram' : 'whatsapp';
  // Same policy as inbound dispatch: only a run on this conversation conflicts.
  const existing = await db.from('flow_runs').select('id').eq('account_id', input.accountId).eq('contact_id', input.contactId)
    .eq('conversation_id', input.conversationId).eq('status', 'active').limit(1);
  if (existing.error) throw new Error('Explicit flow active run lookup failed');
  if (existing.data?.length) return { outcome: 'conflict' };
  const graph = await startGraph(db, flow);
  if (!graph || !graph.flow.entry_node_id || !graph.nodes.has(graph.flow.entry_node_id)) return { outcome: 'unavailable' };
  if (!scopeIncludes(graph.flow.channel_scope, channel)) return { outcome: 'unavailable' };
  const result = await startNewRun(db, graph.flow, input, graph.nodes, input.vars ?? {}).catch((err: unknown) => {
    if (err instanceof FlowAdvanceInterrupted) return endInterruptedRun(db, err.run);
    throw err;
  });
  if (result.outcome === 'duplicate_inbound_ignored') return { outcome: 'conflict' };
  if (result.flow_run_id) {
    const run = await db.from('flow_runs').select('status').eq('account_id', input.accountId).eq('id', result.flow_run_id).maybeSingle();
    if (run.error) throw new Error('Explicit flow run outcome lookup failed');
    if (!run.data || run.data.status === 'failed') return { outcome: 'unavailable' };
  }
  return { outcome: result.consumed && result.outcome !== 'no_match' ? 'started' : 'unavailable' };
}

/** What startTagAddedFlows did with a newly added tag. */
export type TagAddedFlowStart = "started" | "none" | "unavailable" | "conflict";

/**
 * A tag newly added to a contact (the tag writer, contacts/tag-events.ts):
 * starts the oldest live flow whose trigger is tag_added with that tag, on the
 * conversation the tag was added in. Live flows only (drafts are tested by
 * message); the flow must run on the conversation's channel and number, the
 * contact must not be blocked or (Instagram) unsubscribed, and one run per
 * conversation still holds (startFlowById answers "conflict" while a run is
 * active, so a flow's own set_tag step never starts a second run). The chain
 * depth goes into the run's variables, so tag steps in the new run keep
 * counting towards MAX_TAG_CHAIN_DEPTH.
 */
export async function startTagAddedFlows(input: {
  accountId: string;
  contactId: string;
  /** The conversation the tag was added in; absent: the contact's most recently active one. */
  conversationId?: string;
  tagId: string;
  chainDepth: number;
}): Promise<{ outcome: TagAddedFlowStart; flowId?: string }> {
  const db = databaseAdmin();
  const conversationQuery = db.from("conversations").select("id, channel, whatsapp_config_id").eq("account_id", input.accountId)
    .eq("contact_id", input.contactId);
  const [conversation, contact] = await Promise.all([
    input.conversationId
      ? conversationQuery.eq("id", input.conversationId).maybeSingle()
      : conversationQuery.order("last_message_at", { ascending: false, nullsFirst: false }).limit(1).maybeSingle(),
    db.from("contacts").select("id, blocked_at, opted_out_at").eq("account_id", input.accountId).eq("id", input.contactId).maybeSingle(),
  ]);
  if (conversation.error || contact.error) throw new Error("Tag flow ownership lookup failed");
  const row = (Array.isArray(conversation.data) ? conversation.data[0] : conversation.data) as
    { id: string; channel?: string | null; whatsapp_config_id?: string | null } | null | undefined;
  // A tag start is business-initiated (nobody just wrote in): a blocked contact, or one who
  // sent STOP (opted_out_at, either channel), gets no flow, like a template send.
  const person = contact.data as { blocked_at?: string | null; opted_out_at?: string | null } | null;
  if (!row || !person || person.blocked_at || person.opted_out_at) return { outcome: "none" };
  const channel: Channel = row.channel === "instagram" ? "instagram" : "whatsapp";
  if (channel === "instagram" && !(await instagramAutomationAllowed(input.accountId, input.contactId))) return { outcome: "none" };

  // Not narrowed by the row's trigger_type: that is the draft's, and a live flow runs its published version.
  const active = await db.from("flows").select("*").eq("account_id", input.accountId).eq("status", "active")
    .order("created_at", { ascending: true });
  if (active.error) throw new Error("Tag flow lookup failed");
  const live = ((active.data ?? []) as FlowRow[]).filter((f) => f.status === "active" && f.published_version_id);
  if (!live.length) return { outcome: "none" };
  // Matched on the published version (what the run starts on), like an inbound message.
  const versions = await loadPublishedVersions(input.accountId, live.map((f) => f.published_version_id as string));
  const target = { channel, whatsappConfigId: row.whatsapp_config_id ?? null };
  const match = live.flatMap((f) => {
    const version = versions.get(f.published_version_id as string);
    return version && version.flow_id === f.id ? [effectiveFlow(f, version)] : [];
  }).find((flow) => flow.trigger_type === "tag_added" && flowListensOnConversation(flow, target)
    && (flow.trigger_config as unknown as TagAddedTriggerConfig | null)?.tag_id === input.tagId);
  if (!match) return { outcome: "none" };
  const result = await startFlowById({
    accountId: input.accountId,
    userId: match.user_id,
    contactId: input.contactId,
    conversationId: row.id,
    flowId: match.id,
    // A synthetic start event: no customer text.
    message: { kind: "text", text: "", meta_message_id: `tag-added:${row.id}:${input.tagId}:${Date.now()}` },
    vars: { _tag_chain_depth: input.chainDepth },
  });
  return { outcome: result.outcome, flowId: match.id };
}

/**
 * A conversation starter (ice breaker) tap with no run waiting: starts the
 * flow its payload names (`ib:<flow id>`), whatever that flow's trigger. The
 * payload is only a claim, so the flow must still be listed among the starters
 * of this conversation's own Instagram account, be live in this workspace and
 * run on Instagram. Null when the message is not such a tap or the flow is
 * gone; the message then goes through the ordinary triggers.
 */
export async function startIceBreakerFlow(db: AdminClient, input: DispatchInboundInput): Promise<DispatchInboundResult | null> {
  if (input.message.kind !== "interactive_reply") return null;
  const code = decodePostback(input.message.reply_id);
  // A persistent menu item (`menu:<flow id>`, Stage 3) starts its flow the same way, listed in persistent_menu instead.
  if (!code || (code.kind !== "ice_breaker" && code.kind !== "menu")) return null;
  // Stage 5: no automated start for a contact unsubscribed on Instagram.
  if (!(await instagramAutomationAllowed(input.accountId, input.contactId))) return null;
  const listed = await withTenant({ accountId: input.accountId, role: "owner" }, async (tx) => {
    const [row] = await tx.$queryRaw<{ listed: boolean }[]>`SELECT EXISTS(SELECT 1 FROM conversations c
        JOIN instagram_accounts a ON a.account_id=c.account_id AND a.id=c.instagram_account_id
        WHERE c.account_id=${input.accountId}::uuid AND c.id=${input.conversationId}::uuid AND c.contact_id=${input.contactId}::uuid
          AND c.channel='instagram' AND ((${code.kind}::text='ice_breaker' AND jsonb_typeof(a.ice_breakers)='array'
            AND a.ice_breakers @> jsonb_build_array(jsonb_build_object('flow_id', ${code.flowId}::text)))
          OR (${code.kind}::text='menu' AND jsonb_typeof(a.persistent_menu)='array'
            AND a.persistent_menu @> jsonb_build_array(jsonb_build_object('type', 'postback', 'flow_id', ${code.flowId}::text))))) AS listed`;
    return row?.listed === true;
  }, getWorkerPrisma());
  if (!listed) return null;
  const { data, error } = await db.from("flows").select("*").eq("account_id", input.accountId).eq("id", code.flowId)
    .eq("status", "active").maybeSingle();
  if (error || !data) return null;
  const graph = await startGraph(db, data as FlowRow);
  if (!graph || !graph.flow.entry_node_id || !graph.nodes.has(graph.flow.entry_node_id)) return null;
  if (!scopeIncludes(graph.flow.channel_scope, "instagram")) return null;
  return startNewRun(db, graph.flow, input, graph.nodes);
}

/** What startCommentFlow did with a comment. */
export type CommentFlowStart =
  /** A run started (or one this comment already started was carried on). */
  | "started"
  /** Another job's run already answers this comment. */
  | "taken"
  /** A run is already active on the commenter's conversation: one run per conversation. */
  | "busy"
  /** The bot is paused on the conversation (a person took over). */
  | "paused"
  /** The flow is no longer live, not a comment flow, not on Instagram or not for this account. */
  | "unavailable"
  /** Stage 5: the commenter unsubscribed on Instagram; no automated DM goes out (no rule either). */
  | "opted_out";

/**
 * Starts an ig_comment flow for one recorded comment (private-reply.ts's
 * comment-flow job). The commenter's contact and conversation are resolved
 * (created on first contact), a run starts on the flow's published version
 * with the comment's ids as variables, and the comment event is linked to it
 * (compare-and-set, so a comment starts at most one run). The trigger's
 * rotated public reply is posted once per comment before the run advances;
 * the first step is the private reply. A retried job whose run started but
 * never advanced carries it on from its entry.
 */
export async function startCommentFlow(args: {
  accountId: string; eventId: string; flowId: string;
  /** Stage 5: the matched trigger's index in effectiveTriggers order (0, the primary, when absent). */
  trigger?: number;
}): Promise<CommentFlowStart> {
  const { accountId, eventId, flowId } = args;
  const db = databaseAdmin({ accountId, role: "owner" });
  const tenantRead = <T,>(work: (tx: TenantTransaction) => Promise<T>) =>
    withTenant({ accountId, role: "owner" }, work, getWorkerPrisma());
  const [event] = await tenantRead((tx) => tx.$queryRaw<{ comment_id: string; media_id: string | null; from_igsid: string | null;
    instagram_account_id: string; status: string; flow_run_id: string | null }[]>`
    SELECT comment_id, media_id, from_igsid, instagram_account_id::text AS instagram_account_id,
      private_reply_status AS status, flow_run_id::text AS flow_run_id
    FROM instagram_comment_events WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid`);
  if (!event) return "unavailable";
  if (event.flow_run_id) return (await resumeCommentRun(db, accountId, event.flow_run_id)) ? "started" : "taken";
  if (event.status !== "queued" || !event.from_igsid) return "unavailable";

  // An active flow, or (Stage 5) a draft being tested by its test usernames.
  const { data, error } = await db.from("flows").select("*").eq("account_id", accountId).eq("id", flowId)
    .in("status", ["active", "draft"]).maybeSingle();
  if (error) throw new Error("Comment flow lookup failed");
  const row = data as FlowRow | null;
  if (!row || (row.status === "draft" && !(row.test_usernames ?? []).length)) return "unavailable";
  const graph = await startGraph(db, row);
  if (!graph || !scopeIncludes(graph.flow.channel_scope, "instagram")
    || !graph.flow.entry_node_id || !graph.nodes.has(graph.flow.entry_node_id)) return "unavailable";
  // The comment trigger that matched: the primary or (Stage 5) one of the flow's extra triggers.
  const matched = effectiveTriggers(graph.flow)[args.trigger ?? 0];
  if (!matched || !startsFromComment(matched.trigger_type)) return "unavailable";
  // ig_comment and ig_live_comment (Stage 3) share the run: a Live comment has no public reply.
  const trigger = (matched.config ?? {}) as IgCommentTriggerConfig | IgLiveCommentTriggerConfig;
  if (trigger.instagram_account_id && trigger.instagram_account_id !== event.instagram_account_id) return "unavailable";

  const { resolveCommentThread } = await import("@/lib/instagram/process-webhook");
  const thread = await resolveCommentThread(accountId, event.instagram_account_id, event.from_igsid);
  // Stage 5: unsubscribed on Instagram (5D consent): no flow, and the job sends no rule DM either.
  if (!(await instagramAutomationAllowed(accountId, thread.contactId))) return "opted_out";
  // A draft runs only for its testers' stored usernames.
  if (row.status === "draft" && !isTestUsername(row, await storedInstagramUsername(accountId, thread.contactId, thread.conversationId))) {
    return "unavailable";
  }
  if (await botRepliesPaused(accountId, thread.conversationId)) return "paused";
  // Stage 5: "wait before replying" holds the first step on a durable flow.timer (queued before this job is done).
  const replyDelay = commentReplyDelaySeconds(trigger);

  const flow = graph.flow;
  const { data: inserted, error: insErr } = await db.from("flow_runs").insert({
    flow_id: flow.id,
    account_id: flow.account_id,
    user_id: flow.user_id,
    contact_id: thread.contactId,
    conversation_id: thread.conversationId,
    status: "active",
    current_node_key: flow.entry_node_id,
    // Ids only (no comment text): the private reply and comment reply steps answer this comment.
    vars: { ig_comment_event_id: eventId, ig_comment_id: event.comment_id, ...(event.media_id ? { ig_media_id: event.media_id } : {}),
      ...(replyDelay ? { [COMMENT_DELAY_VAR]: replyDelay } : {}) },
    ...(flow.version_id ? { flow_version_id: flow.version_id } : {}),
  }).select("*").maybeSingle();
  if (insErr) {
    const msg = insErr.message ?? "";
    if (!(msg.includes("23505") || msg.includes("duplicate key"))) throw new Error("Comment flow run insert failed");
    // A job that crashed between inserting its run and linking the comment left
    // that run active on the conversation: link it now and carry it on, instead
    // of reporting the conversation busy with this comment's own run.
    const active = await loadActiveRunForConversation(db, accountId, thread.contactId, thread.conversationId);
    if (!active || active.vars?.ig_comment_event_id !== eventId) return "busy";
    const relinked = await tenantRead((tx) => tx.$executeRaw`UPDATE instagram_comment_events SET flow_run_id=${active.id}::uuid
      WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid AND flow_run_id IS NULL AND private_reply_status='queued'`);
    if (!relinked) return "taken";
    await resumeCommentRun(db, accountId, active.id);
    return "started";
  }
  const run = inserted as FlowRunRow;
  const linked = await tenantRead((tx) => tx.$executeRaw`UPDATE instagram_comment_events SET flow_run_id=${run.id}::uuid
    WHERE account_id=${accountId}::uuid AND id=${eventId}::uuid AND flow_run_id IS NULL AND private_reply_status='queued'`);
  if (!linked) {
    await endRun(db, run.id, "cancelled", "comment_already_taken");
    return "taken";
  }
  committedRuns.add(run);
  // The trigger's public reply (0-3 variants, one picked per comment); a failure never stops the DM.
  const reply = matched.trigger_type === "ig_comment"
    ? pickPublicReply((trigger as IgCommentTriggerConfig).public_replies, event.comment_id, validCommentReply) : null;
  const input: DispatchInboundInput = {
    accountId, userId: flow.user_id, contactId: thread.contactId, conversationId: thread.conversationId,
    message: { kind: "text", text: "", meta_message_id: `igc:${event.comment_id}` },
  };
  try {
    await guardCommitted(run, async () => {
      if (reply) {
        const posted = await postCommentPublicReply(accountId, eventId, reply).catch(() => "failed");
        if (posted !== "posted") await logEvent(db, run.id, "error", flow.entry_node_id, { reason: `comment_reply_${posted}` });
      }
      return continueNewRun(db, run, flow, input, graph.nodes, replyDelay > 0);
    });
  } catch (err) {
    if (err instanceof FlowAdvanceInterrupted) await endInterruptedRun(db, err.run);
    else throw err;
  }
  return "started";
}

/** The run variable a delayed comment run carries its trigger's reply delay in (seconds). */
export const COMMENT_DELAY_VAR = "ig_reply_delay";

/** A comment trigger's "wait before replying", in whole seconds (0 when none or out of range). */
export function commentReplyDelaySeconds(trigger: { reply_delay_seconds?: unknown }): number {
  const raw = trigger.reply_delay_seconds;
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= FLOW_TRIGGER_LIMITS.replyDelaySecondsMax ? raw : 0;
}

/**
 * Parks a new comment run on its entry for the trigger's reply delay (Stage 5):
 * the flow.timer job is queued before the run moves (scheduleDelay), so the
 * comment job finishes only once the wait is durable; the timer then runs the
 * entry as a delay that has elapsed. A run already past its entry is left alone.
 */
export async function holdCommentRun(db: AdminClient, run: FlowRunRow, nodes: Map<string, FlowNodeRow>): Promise<DispatchInboundResult> {
  const seconds = typeof run.vars?.[COMMENT_DELAY_VAR] === "number" ? (run.vars[COMMENT_DELAY_VAR] as number) : 0;
  const entry = run.current_node_key ? nodes.get(run.current_node_key) : undefined;
  if (!entry || seconds <= 0) return { consumed: true, flow_run_id: run.id, outcome: "started" };
  const scheduled = await scheduleDelay(db, run, entry, seconds);
  return { consumed: true, flow_run_id: run.id, outcome: scheduled === "failed" ? "completed" : "started" };
}

/**
 * A comment run a crashed job inserted and linked but never moved past its
 * entry: carry it on (every send in it is keyed, so nothing goes twice).
 * False when the run is gone, ended or already under way.
 */
export async function resumeCommentRun(db: AdminClient, accountId: string, runId: string): Promise<boolean> {
  const { data, error } = await db.from("flow_runs").select("*").eq("account_id", accountId).eq("id", runId).maybeSingle();
  if (error) throw new Error("Comment run lookup failed");
  const run = data as FlowRunRow | null;
  if (!run || run.status !== "active" || (run.transition_seq ?? 0) !== 0 || run.delay_until || !run.current_node_key) return false;
  const { flow, nodes } = await loadRunGraph(db, run);
  if (!flow || run.current_node_key !== flow.entry_node_id) return false;
  committedRuns.add(run);
  try {
    // Stage 5: a run with a reply delay is parked on its timer, never advanced early.
    if (typeof run.vars?.[COMMENT_DELAY_VAR] === "number") await guardCommitted(run, () => holdCommentRun(db, run, nodes));
    else await guardCommitted(run, () => advanceFromNodeKey(db, run, run.current_node_key!, nodes));
  } catch (err) {
    if (err instanceof FlowAdvanceInterrupted) await endInterruptedRun(db, err.run);
    else throw err;
  }
  return true;
}
