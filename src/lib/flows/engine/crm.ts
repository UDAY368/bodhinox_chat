// Flow engine, crm group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { clockTimezone, conditionRules, ruleHolds } from "../conditions";
import { igProfileSubject as igProfileSubjectOf, igProfileValue } from "../conditions/ig-profile";
import { callApiOnce } from "@/lib/actions/webhook";
import { assignConversations, resolveAssignee } from "@/lib/actions/assign";
import { canOwnConversations } from "@/lib/automations/round-robin";
import { sendForm } from "@/lib/whatsapp/forms/send";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { systemSubject } from "../conditions/system";
import { segmentSubject } from "../conditions/segment";
import { workspaceFieldSubject } from "../conditions/workspace-field";
import { linkClicked } from "../link-tracking";
import { flowSend, runChannel } from "../channel-send";
import { scopeIncludes } from "@/lib/channels/capabilities";
import { workspaceValuesFor } from "@/lib/workspace/attributes";
import { type ApiRequestNodeConfig, type AssignAgentNodeConfig, type ConnectFlowNodeConfig, type SendFormNodeConfig, type AskMediaNodeConfig, type CollectInputNodeConfig, type ConditionNodeConfig, type ConditionRule, type FlowNodeRow, type FlowRow, type FlowRunRow } from "../types";
import { SKIP_REPLY_ID } from "./helpers";
import { type AdminClient, logEvent, startGraph } from "./run";
import { errorDetail } from "./commerce";
import { endRun, interpolateOptionalVars, interpolateVars, textValues } from "./control";
import { startNewRun } from "../engine";

/**
 * Calls the configured API, stores mapped values in the run's variables
 * and returns the port to follow. Only the status, timing and mapped
 * variable names are logged: never the URL, headers, body or reply.
 */
export async function executeApiRequest(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<string> {
  const cfg = node.config as unknown as ApiRequestNodeConfig;
  try {
    const { data: contact } = await db
      .from("contacts")
      .select("name,email,phone,company")
      .eq("account_id", run.account_id)
      .eq("id", run.contact_id!)
      .maybeSingle();
    const contactValues = Object.fromEntries(
      Object.entries((contact ?? {}) as Record<string, unknown>).filter(([, v]) => typeof v === "string"),
    ) as Record<string, string>;
    // Secret workspace attributes (API keys) resolve only into headers and the body.
    const [workspace, publicWorkspace] = await Promise.all([
      workspaceValuesFor(run.account_id, JSON.stringify([cfg.headers, cfg.body]), { secrets: true }),
      workspaceValuesFor(run.account_id, JSON.stringify([cfg.url, cfg.params])),
    ]);
    // Recorded like a send, so a replayed step (worker restart) reuses this
    // outcome instead of repeating a POST; an unknown outcome is never retried.
    const outcome = await callApiOnce({
      accountId: run.account_id,
      key: `flow-api:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`,
      config: cfg,
      values: { vars: run.vars, contact: contactValues, workspace, publicWorkspace },
    });
    if (Object.keys(outcome.mapped).length) {
      const vars = { ...run.vars, ...outcome.mapped };
      const { error } = await db.from("flow_runs").update({ vars }).eq("id", run.id).eq("status", "active");
      if (error) throw new Error("Run variable write failed");
      run.vars = vars;
    }
    await logEvent(db, run.id, "api_request", node.node_key, {
      status: outcome.status,
      error: outcome.error,
      duration_ms: outcome.durationMs,
      mapped: Object.keys(outcome.mapped),
      route: outcome.next === cfg.fallback_next ? "fallback" : "status",
    });
    return outcome.next;
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "api_request_failed",
      detail: errorDetail(err),
    });
    return cfg.fallback_next;
  }
}

/** Assigns the conversation (a specific member or the next in the round-robin) and carries on. */
export async function executeAssignAgent(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as AssignAgentNodeConfig;
  try {
    // A replayed step (worker restart) keeps the agent it already picked
    // rather than moving the shared round-robin cursor again.
    const seq = String(run.transition_seq ?? 0);
    const { data: prior } = await db
      .from("flow_run_events")
      .select("payload")
      .eq("flow_run_id", run.id)
      .eq("event_type", "agent_assigned")
      .eq("node_key", node.node_key)
      .filter("payload->>seq", "eq", seq)
      .limit(1);
    const already = (prior as Array<{ payload: { agent_id?: string } }> | null)?.[0]?.payload.agent_id;
    if (!run.conversation_id) throw new Error("no agent to assign");
    // A pinned member removed or demoted to viewer since the flow was built is skipped (shared assign action).
    const assignee = already ? { agentId: already } : await resolveAssignee(run.account_id, cfg.mode, cfg.agent_id);
    if ("refused" in assignee) {
      throw new Error(assignee.refused === "no_agent" ? "no agent to assign" : "pinned member can no longer own conversations");
    }
    const agentId = assignee.agentId;
    const { error } = await assignConversations(db, {
      accountId: run.account_id, agentId, touch: true, scope: { conversationId: run.conversation_id },
    });
    if (error) throw new Error("conversation assignment failed");
    if (!already) await logEvent(db, run.id, "agent_assigned", node.node_key, { agent_id: agentId, mode: cfg.mode, seq });
  } catch (err) {
    // Non-fatal, like set_tag: the conversation simply stays unassigned.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "assign_agent_failed",
      detail: errorDetail(err),
    });
  }
}

/** Connect Flow hops in a row without a customer reply before a loop is assumed. */
export const MAX_CONNECT_HOPS = 5;
/** Run variable counting those hops; carried to the next flow, reset by any reply. */
export const CONNECT_HOPS_VAR = "_connect_hops";

/**
 * Ends this run and starts the target flow for the same contact with the
 * run's variables. The run must end first: a contact has one active run.
 */
export async function executeConnectFlow(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  const cfg = node.config as unknown as ConnectFlowNodeConfig;
  const { data } = await db
    .from("flows")
    .select("*")
    .eq("account_id", run.account_id)
    .eq("id", cfg.flow_id)
    .maybeSingle();
  const targetRow = data as FlowRow | null;
  // The target starts on its published version (or its draft, if not yet versioned).
  const graph = targetRow && targetRow.status === "active" ? await startGraph(db, targetRow) : null;
  const target = graph?.flow ?? null;
  // Counted in hops rather than time, so a loop slowed by delays still stops.
  const { count: replies } = await db
    .from("flow_run_events")
    .select("id", { count: "exact", head: true })
    .eq("flow_run_id", run.id)
    .eq("event_type", "reply_received");
  const hops = (replies ?? 0) > 0 ? 1 : (Number(run.vars[CONNECT_HOPS_VAR]) || 0) + 1;
  const reason = !target || target.status !== "active" || !target.entry_node_id
    ? "connect_flow_unavailable"
    : !scopeIncludes(target.channel_scope, await runChannel(run)) ? "unavailable_on_channel"
    : hops > MAX_CONNECT_HOPS ? "connect_flow_loop" : null;
  if (reason || !target || !run.contact_id || !run.conversation_id) {
    await logEvent(db, run.id, "error", node.node_key, { reason: reason ?? "connect_flow_unavailable" });
    await endRun(db, run.id, "failed", reason ?? "connect_flow_unavailable");
    return;
  }
  await logEvent(db, run.id, "flow_connected", node.node_key, { flow_id: target.id });
  // Paused by an agent (or timed out) meanwhile: the contact gets no new flow.
  if (!(await endRun(db, run.id, "completed", "connect_flow"))) return;
  await startNewRun(db, target, {
    accountId: run.account_id,
    userId: run.user_id,
    contactId: run.contact_id,
    conversationId: run.conversation_id,
    message: { kind: "text", text: "", meta_message_id: `connect:${run.id}` },
  }, graph!.nodes, { ...run.vars, [CONNECT_HOPS_VAR]: hops });
}

export async function executeHandoff(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<void> {
  const cfg = node.config as { assign_to?: string; note?: string };
  const convUpdate: Record<string, unknown> = {
    status: "pending",
    bot_paused: true,
    ai_autoreply_disabled: true,
    updated_at: new Date().toISOString(),
  };
  // A pinned member removed or demoted to viewer is not assigned: the handoff
  // still pauses the bot and the conversation goes to normal routing (audit #51).
  let assignee = cfg.assign_to && (await canOwnConversations(run.account_id, cfg.assign_to)) ? cfg.assign_to : null;
  if (cfg.assign_to && !assignee) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "handoff_assignee_unavailable" });
    console.warn("[flows] handoff assignee unavailable; left to routing", { runId: run.id });
  }
  if (run.conversation_id) {
    const update = (row: Record<string, unknown>) => db
      .from("conversations")
      .update(row)
      .eq("account_id", run.account_id)
      .eq("id", run.conversation_id!);
    let { error } = await update(assignee ? { ...convUpdate, assigned_agent_id: assignee } : convUpdate);
    // Removed between the check and the write (the membership key refuses it): hand off unassigned.
    if (error && assignee) {
      await logEvent(db, run.id, "error", node.node_key, { reason: "handoff_assignee_unavailable" });
      assignee = null;
      ({ error } = await update(convUpdate));
    }
    if (error) throw new Error("Handoff conversation update failed");
  }
  await logEvent(db, run.id, "handoff", node.node_key, {
    note: cfg.note ?? null,
    assigned_to: assignee,
  });
  await endRun(db, run.id, "handed_off", "handoff_node");
}

/**
 * Resolve a condition node's subject value from DB / run state, then
 * call the pure `evaluateConditionPredicate`. Splits out so the
 * predicate itself stays unit-testable without a database mock.
 *
 * Subject sources:
 *   - `var` → `flow_runs.vars[subject_key]` (captured by collect_input
 *     or http_fetch in v2).
 *   - `tag` → present iff `contact_tags(contact_id, tag_id)` exists.
 *     `subject_key` IS the tag UUID; the SELECT returns 1 row or 0.
 *   - `contact_field` → one of name/email/phone/company on `contacts`.
 */
export async function evaluateConditionNode(
  db: AdminClient,
  run: FlowRunRow,
  cfg: ConditionNodeConfig,
): Promise<boolean> {
  const clock = { now: new Date(), timezone: clockTimezone(cfg) };
  const rules = conditionRules(cfg);
  // Evaluated in order and stopped early, so a later rule's lookup is skipped once the answer is known.
  for (const rule of rules) {
    const holds = ruleHolds(rule, await conditionSubject(db, run, rule), clock);
    if (cfg.match === "any" ? holds : !holds) return holds;
  }
  return cfg.match !== "any";
}

/** The `ig_profile` subjects (follow gate, verified, in window) are resolved in ./conditions/ig-profile. */
export { igProfileValue };

export async function igProfileSubject(run: FlowRunRow, key: string): Promise<string | undefined> {
  return igProfileSubjectOf(run, key, (await runChannel(run)) === "instagram");
}

export async function conditionSubject(
  db: AdminClient,
  run: FlowRunRow,
  rule: ConditionRule,
): Promise<string | undefined> {
  if (rule.subject === "time" || rule.subject === "date") return undefined;
  if (rule.subject === "ig_profile") return igProfileSubject(run, rule.subject_key);
  // Stage 5 subjects; each read is scoped to the run's workspace.
  if (rule.subject === "system") return systemSubject(run, rule.subject_key, await runChannel(run));
  if (rule.subject === "segment") return segmentSubject(run, rule.subject_key);
  if (rule.subject === "workspace_field") return workspaceFieldSubject(run.account_id, rule.subject_key);
  if (rule.subject === "link_click") {
    // A step of this run sent a tracked link and the contact opened it.
    return typeof rule.subject_key === "string" && rule.subject_key
      ? String(await linkClicked(run.account_id, run.id, rule.subject_key)) : undefined;
  }
  if (rule.subject === "sequence") {
    if (!run.contact_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rule.subject_key)) return undefined;
    const [row] = await withTenant({ accountId: run.account_id, role: "owner" }, (tx) => tx.$queryRaw<{ subscribed: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM sequence_subscriptions WHERE account_id=${run.account_id}::uuid AND contact_id=${run.contact_id}::uuid
        AND sequence_id=${rule.subject_key}::uuid AND status IN ('active','sending')) AS subscribed`, getWorkerPrisma());
    return String(row?.subscribed === true);
  }
  if (rule.subject === "var") {
    const v = run.vars[rule.subject_key];
    return typeof v === "string" ? v : v === undefined || v === null ? undefined : String(v);
  }
  if (rule.subject === "tag") {
    const { count } = await db
      .from("contact_tags")
      .select("contact_id", { count: "exact", head: true })
      .eq("contact_id", run.contact_id!)
      .eq("tag_id", rule.subject_key);
    // For tags, "present" really is the only meaningful test — the
    // `present`/`absent` operators are the natural fit. equals/contains
    // against a tag UUID would still work mechanically (compare its
    // existence to the value).
    return (count ?? 0) > 0 ? rule.subject_key : undefined;
  }
  if (rule.subject === "custom_field") {
    const { data } = await db
      .from("contact_custom_values")
      .select("value")
      .eq("account_id", run.account_id)
      .eq("contact_id", run.contact_id!)
      .eq("custom_field_id", rule.subject_key)
      .maybeSingle();
    const raw = (data as { value?: unknown } | null)?.value;
    return typeof raw === "string" && raw.length > 0 ? raw : undefined;
  }
  const ALLOWED = ["name", "email", "phone", "company"] as const;
  type AllowedField = (typeof ALLOWED)[number];
  if (!ALLOWED.includes(rule.subject_key as AllowedField)) {
    throw new Error(`unsupported contact_field: ${rule.subject_key}`);
  }
  const { data } = await db
    .from("contacts")
    .select(rule.subject_key)
    .eq("id", run.contact_id!)
    .maybeSingle();
  const raw = (data as Record<string, unknown> | null)?.[rule.subject_key];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Sends a question node's prompt. `attempt` keeps each re-send a
 * distinct outbound intent; `text` replaces the prompt (error message).
 * A Skip button turns the prompt into a one-button message.
 */
export async function sendAskPrompt(
  run: FlowRunRow,
  node: FlowNodeRow,
  attempt: number,
  text?: string,
): Promise<string> {
  const cfg = node.config as unknown as CollectInputNodeConfig & AskMediaNodeConfig;
  const body = text ?? cfg.prompt_text;
  const ws = await textValues(run, `${body} ${cfg.skip_label ?? ""}`);
  const base = {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
  };
  const key = `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`;
  const skip = (node.node_type === "collect_input" || node.node_type === "ask_media") && cfg.skip_label && cfg.skip_next;
  const { whatsapp_message_id } = await flowSend(run, key,
    skip
      ? { kind: "buttons", args: {
          ...base,
          bodyText: interpolateVars(body, run.vars, ws),
          buttons: [{ id: SKIP_REPLY_ID, title: interpolateVars(cfg.skip_label!, run.vars, ws) }],
        } }
      : { kind: "text", args: {
          ...base,
          text: interpolateVars(body, run.vars, ws),
          // An error message is plain text; only the prompt itself carries the request.
          request: text === undefined && node.node_type === "ask_location" ? "location"
            : text === undefined && node.node_type === "ask_address" ? "address" : undefined,
        } },
  );
  return whatsapp_message_id;
}

/**
 * Sends a send_form node's form. `attempt` keeps a re-send (reprompt) a
 * distinct outbound intent; each send issues a new one-time session tied to
 * this run and node, so only a submission of a form this node sent resumes it.
 */
export async function sendFormForNode(run: FlowRunRow, node: FlowNodeRow, attempt: number): Promise<string> {
  const cfg = node.config as unknown as SendFormNodeConfig;
  const ws = await textValues(run, `${cfg.body} ${cfg.header ?? ""} ${cfg.footer ?? ""} ${cfg.cta}`);
  const { whatsappMessageId } = await sendForm({
    accountId: run.account_id,
    userId: run.user_id,
    sender: "bot",
    role: "owner",
    conversationId: run.conversation_id!,
    formId: cfg.form_id,
    cta: interpolateVars(cfg.cta, run.vars, ws),
    body: interpolateVars(cfg.body, run.vars, ws),
    header: interpolateOptionalVars(cfg.header, run.vars, ws),
    footer: interpolateOptionalVars(cfg.footer, run.vars, ws),
    intentKey: `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${attempt}`,
    flowRunId: run.id,
    nodeKey: node.node_key,
  });
  return whatsappMessageId;
}

/**
 * A submission as run variables: the answers object under `var_key`, and
 * each answer as `<var_key>_<field_id>` text so `{{vars.x}}` and
 * conditions can read it (choices keep their option ids).
 */
export function formAnswerVars(key: string, answers: Record<string, string | number | boolean | string[]>): Record<string, unknown> {
  return {
    [key]: answers,
    ...Object.fromEntries(Object.entries(answers).map(([field, value]) => [`${key}_${field}`, Array.isArray(value) ? value.join(", ") : String(value)])),
  };
}

// ============================================================
// Payment link step. The link's reference is derived from the run, node
// and transition, so a replayed step finds the link it already created
// (lib/payments/links) instead of creating a second one. A verified
// Razorpay webhook or fetch resumes the run (resumePaymentLinkRun).
// ============================================================
