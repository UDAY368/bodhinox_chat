// The flow engine entry: the advance loop and inbound dispatch. The step groups live in
// ./engine/* (batch 5 split, pure moves); every name callers imported from here is re-exported.
import { markRunTimedOut } from "./timeout";
import { botRepliesPaused } from "@/lib/whatsapp/bot-pause";
import { normalizeCollectedInput } from "./input-validation";
import { writeContactField } from "@/lib/contacts/field-write";
import { isTestContact, isTestUsername, phoneDigits } from "./triggers";
import { decodePostback } from "@/lib/instagram/postback-payloads";
import { postCommentPublicReply, recordCommentOptIn } from "@/lib/instagram/private-reply";
import { pickPublicReply } from "@/lib/instagram/comment-matching";
import { validCommentReply } from "@/lib/instagram/graph-limits";
import { instagramAutomatedWindowOpen } from "@/lib/channels/sender";
import { needsMessagingWindow } from "./instagram-validation";
import { sendOnChannel } from "@/lib/actions/send";
import { addTag, removeTag } from "@/lib/actions/tags";
import { CommerceSendError, commerceMessageFromNode, isCommerceNodeType, sendCommerceMessage } from "@/lib/commerce/catalog-send";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { runStorefrontLinkNode, type StorefrontNodeResult } from "./storefront-node";
import { findLinkByReference, flowOutcomeFor, flowPaymentReference } from "@/lib/payments/links";
import { versionNodeMap, type EffectiveFlow } from "./versions";
import { writeContactValue } from "./nodes/actions";
import { chooseRandomizerPath, pickVar } from "./nodes/randomizer";
import { executeSheetsNode } from "@/lib/integrations/google-sheets/node";
import { instagramAutomationAllowed } from "@/lib/contacts/channel-consent";
import { databaseAdmin } from "./admin-client";
import { flowSend, runChannel } from "./channel-send";
import { nodeAvailableOn, scopeIncludes } from "@/lib/channels/capabilities";
import { decideFallback, resolveFallbackPolicy } from "./fallback";
import { type AssignAgentNodeConfig, type SendTemplateNodeConfig, type SendFormNodeConfig, type SendStorefrontLinkNodeConfig, type AskMediaNodeConfig, type AskRetry, type CollectInputNodeConfig, type ConditionNodeConfig, type DispatchInboundInput, type SetAttributeNodeConfig, type DispatchInboundResult, type FlowNodeRow, type FlowRow, type FlowRunRow, type ParsedInbound, type SendMediaNodeConfig, type SendMessageNodeConfig, type SetTagNodeConfig, type StartNodeConfig, type IgCommentReplyNodeConfig, type IgPrivateReplyNodeConfig, type ActionsNodeConfig, type SmartDelayNodeConfig } from "./types";
import { type ActiveRunClosure, SKIP_REPLY_ID, cardWaits, closureForActiveRun, isAskNode, matchReplyId, messageText, nodeDelaySeconds, templateWaits } from "./engine/helpers";
import { type AdminClient, isDuplicateInbound, loadActiveRunForConversation, loadAllNodes, loadRunGraph, logEvent, storedInstagramUsername } from "./engine/run";
import { findEntryFlow } from "./engine/entry";
import { commentEventOf, runPrivateReplyStep, sendButtonsAndSuspend, sendCards, sendListAndSuspend, sendTemplateNode, templateSuppression } from "./engine/send";
import { evaluateConditionNode, executeApiRequest, executeAssignAgent, executeConnectFlow, executeHandoff, formAnswerVars, sendAskPrompt, sendFormForNode } from "./engine/crm";
import { errorDetail, handleAppointmentReply, paymentEnd, resumeInterruptedBooking, resumePaymentLinkRun, sendPaymentLinkText, setRunVars, startAppointmentStep, startPaymentLinkNode } from "./engine/commerce";
import { aiReplyTurn, channelFailurePort, continueAiReplyNode, endRun, goalTurn, handOffUnavailable, interpolateVars, planSmartDelayFor, runActionsNode, runConversionEvent, scheduleDelay, scheduleReplyTimeout, textValues } from "./engine/control";
import { holdCommentRun, startIceBreakerFlow } from "./engine/start";

// ============================================================
// Pure helpers — extracted so engine.test.ts can exercise them
// without a database / Meta mock.
// ============================================================

export { SKIP_REPLY_ID, cardPostbackRoutes, cardWaits, closureForActiveRun, entryTriggerTexts, evaluateConditionPredicate, isAskNode, isAutoAdvancing, isSuspending, isTerminal, matchReplyId, messageText, nodeCards, nodeDelaySeconds, nodeTimeout, staleSince, templateWaits } from "./engine/helpers";
export type { ActiveRunClosure, RunStaleFields } from "./engine/helpers";
export { flowListensOnConversation, flowListensOnNumber, loadRunGraph } from "./engine/run";
export { CONNECT_HOPS_VAR, MAX_CONNECT_HOPS, formAnswerVars, igProfileValue } from "./engine/crm";
export { errorDetail, paymentPortFor, resumePaymentLinkRun } from "./engine/commerce";
export { handleFlowTimer } from "./engine/control";
export { commentReplyDelaySeconds, handleFlowReplay, replayRun, startCommentFlow, startFlowById, startTagAddedFlows } from "./engine/start";
export type { CommentFlowStart, TagAddedFlowStart } from "./engine/start";

export async function advanceFromNodeKey(
  db: AdminClient,
  run: FlowRunRow,
  startNodeKey: string,
  nodes: Map<string, FlowNodeRow>,
  /** The node whose delay just elapsed; it runs now. */
  delayDoneFor?: string,
): Promise<{ outcome: "advanced" | "completed" | "handed_off" }> {
  let currentKey: string | null = startNodeKey;
  // Defensive cap — if a flow has a cycle (which the validator
  // SHOULD catch but doesn't yet in v1), we bail rather than loop.
  for (let safety = 0; safety < 64; safety += 1) {
    if (!currentKey) {
      await logEvent(db, run.id, "error", null, {
        reason: "next_node_key was null mid-advance",
      });
      await endRun(db, run.id, "failed", "missing_next_node");
      return { outcome: "completed" };
    }
    const node: FlowNodeRow | null = nodes.get(currentKey) ?? null;
    if (!node) {
      await logEvent(db, run.id, "error", currentKey, {
        reason: "node_not_found",
      });
      await endRun(db, run.id, "failed", "node_not_found");
      return { outcome: "completed" };
    }
    const waited = node.node_key === delayDoneFor;
    const delay = node.node_type === "start" || waited ? 0 : nodeDelaySeconds(node.config);
    delayDoneFor = undefined;
    if (delay) {
      const scheduled = await scheduleDelay(db, run, node, delay);
      return { outcome: scheduled === "failed" ? "completed" : "advanced" };
    }
    await logEvent(db, run.id, "node_entered", node.node_key, {
      node_type: node.node_type,
    });

    const channel = node.node_type === "start" ? null : await runChannel(run);
    // Each channel runs only its own steps (Stage 2: the Instagram-only steps never run on WhatsApp).
    if (channel && !nodeAvailableOn(node.node_type, channel, node.config).ok) {
      await logEvent(db, run.id, "error", node.node_key, { reason: "unavailable_on_channel", node_type: node.node_type });
      const failure = channelFailurePort(node.config);
      if (failure) {
        currentKey = failure;
        continue;
      }
      return handOffUnavailable(db, run, node);
    }
    // Instagram's 24-hour window, re-checked before every step that messages the
    // customer: a run that resumes (after a delay, a timeout or a late tap)
    // past the window ends here with window_closed instead of failing a send.
    if (channel === "instagram" && needsMessagingWindow(node.node_type) && run.conversation_id) {
      const open = await withTenant({ accountId: run.account_id, role: "owner" },
        (tx) => instagramAutomatedWindowOpen(tx, run.account_id, run.conversation_id!), getWorkerPrisma());
      if (!open) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "window_closed", node_type: node.node_type });
        await endRun(db, run.id, "cancelled", "window_closed");
        return { outcome: "completed" };
      }
    }

    if (node.node_type === "start") {
      currentKey = (node.config as unknown as StartNodeConfig).next_node_key;
      continue;
    }
    // ---- Stage 5 logic steps (send nothing themselves) ----
    if (node.node_type === "actions") {
      const result = await runActionsNode(db, run, node, (node.config as unknown as ActionsNodeConfig).actions, "");
      if (result.paused) {
        // The step paused automations on this conversation: this run sends nothing more.
        await endRun(db, run.id, "completed", "automations_paused");
        return { outcome: "completed" };
      }
      currentKey = typeof node.config.next_node_key === "string" ? node.config.next_node_key : null;
      if (!currentKey) {
        await endRun(db, run.id, "completed", "end_node");
        return { outcome: "completed" };
      }
      continue;
    }
    if (node.node_type === "randomizer") {
      const choice = chooseRandomizerPath({ config: node.config, nodeKey: node.node_key, contactId: run.contact_id, vars: run.vars });
      if (!choice || !choice.path.next_node_key) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "randomizer_no_path" });
        await endRun(db, run.id, "failed", "randomizer_no_path");
        return { outcome: "completed" };
      }
      // Written before advancing, so a retry or replay of this run follows the same path.
      if (choice.store) await setRunVars(db, run, { [pickVar(node.node_key)]: choice.path.id });
      await logEvent(db, run.id, "node_entered", node.node_key, { randomizer_path: choice.path.id, advancing_to: choice.path.next_node_key });
      currentKey = choice.path.next_node_key;
      continue;
    }
    if (node.node_type === "smart_delay") {
      const cfg = node.config as unknown as SmartDelayNodeConfig;
      const next = cfg.next_node_key || null;
      if (!waited) {
        const plan = await planSmartDelayFor(db, run, cfg);
        if (plan.kind === "invalid" || plan.kind === "date_passed") {
          const reason = plan.kind === "invalid" ? plan.reason : "smart_delay_date_passed";
          await logEvent(db, run.id, "error", node.node_key, { reason });
          await endRun(db, run.id, plan.kind === "invalid" ? "failed" : "completed", reason);
          return { outcome: "completed" };
        }
        if (plan.kind === "wait") {
          const seconds = Math.max(1, Math.ceil((plan.until.getTime() - Date.now()) / 1000));
          const scheduled = await scheduleDelay(db, run, node, seconds);
          return { outcome: scheduled === "failed" ? "completed" : "advanced" };
        }
      }
      // The wait is over (or there was none). On Instagram the next step that
      // messages re-checks the 24-hour window before sending (below).
      if (!next) {
        await endRun(db, run.id, "completed", "end_node");
        return { outcome: "completed" };
      }
      currentKey = next;
      continue;
    }
    if (node.node_type === "google_sheets") {
      let result: Awaited<ReturnType<typeof executeSheetsNode>>;
      try {
        result = await executeSheetsNode(run, node);
      } catch {
        // Never the error text: it could carry a cell value. The outcome is not retried.
        result = { port: "failure", vars: {}, reason: "sheets_outcome_unknown" };
      }
      if (Object.keys(result.vars).length) {
        try {
          await setRunVars(db, run, result.vars);
        } catch (err) {
          await logEvent(db, run.id, "error", node.node_key, { reason: "sheets_var_failed", detail: errorDetail(err) });
        }
      }
      if (result.port === "failure") await logEvent(db, run.id, "error", node.node_key, { reason: result.reason ?? "sheets_failed" });
      else await logEvent(db, run.id, "api_request", node.node_key, { node_type: "google_sheets", mapped: Object.keys(result.vars) });
      currentKey = (result.port === "next" ? node.config.next_node_key : node.config.failure_next) as string | null;
      if (!currentKey) {
        await endRun(db, run.id, result.port === "next" ? "completed" : "failed", result.port === "next" ? "end_node" : (result.reason ?? "sheets_failed"));
        return { outcome: "completed" };
      }
      continue;
    }
    if (node.node_type === "send_message") {
      const cfg = node.config as unknown as SendMessageNodeConfig;
      try {
        const ws = await textValues(run, cfg.text);
        const { whatsapp_message_id } = await sendOnChannel({ ref: run, key: `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, send: { kind: "text", args: {
          accountId: run.account_id,
          userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          text: interpolateVars(cfg.text, run.vars, ws),
        } } });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_message",
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_text_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_text_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_media") {
      const cfg = node.config as unknown as SendMediaNodeConfig;
      try {
        const ws = await textValues(run, cfg.caption ?? '');
        const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, { kind: "media", args: {
          accountId: run.account_id,
    userId: run.user_id,
          conversationId: run.conversation_id!,
          contactId: run.contact_id!,
          kind: cfg.media_type,
          link: cfg.media_url,
          caption: cfg.caption
            ? interpolateVars(cfg.caption, run.vars, ws)
            : undefined,
          filename: cfg.filename,
        } });
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: "send_media",
          media_type: cfg.media_type,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_media_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_media_failed");
        return { outcome: "completed" };
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (isCommerceNodeType(node.node_type)) {
      // Catalogue steps: one outbound intent per transition, like send_media.
      const cfg = node.config as unknown as Record<string, unknown>;
      try {
        const texts = ["header_text", "body_text", "footer_text"].map((k) => (typeof cfg[k] === "string" ? cfg[k] : "")).join("\n");
        const ws = await textValues(run, texts);
        const { whatsappMessageId } = await sendCommerceMessage({
          accountId: run.account_id, role: "owner", sender: "bot", conversationId: run.conversation_id!,
          message: commerceMessageFromNode(node.node_type, cfg, (text) => interpolateVars(text, run.vars, ws)),
          intentKey: `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`,
        });
        await logEvent(db, run.id, "message_sent", node.node_key, { node_type: node.node_type, whatsapp_message_id: whatsappMessageId });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: `${node.node_type}_failed`,
          detail: err instanceof CommerceSendError ? err.code : err instanceof Error ? err.message : String(err),
        });
        await endRun(db, run.id, "failed", `${node.node_type}_failed`);
        return { outcome: "completed" };
      }
      currentKey = typeof cfg.next_node_key === "string" ? cfg.next_node_key : "";
      continue;
    }
    if (isAskNode(node.node_type)) {
      // Send the prompt and suspend. The customer's next reply wakes us
      // up via handleReplyForActiveRun's question branch.
      try {
        const whatsapp_message_id = await sendAskPrompt(run, node, run.reprompt_count);
        await logEvent(db, run.id, "message_sent", node.node_key, {
          node_type: node.node_type,
          whatsapp_message_id,
        });
        const { data: msg } = await db
          .from("messages")
          .select("id")
          .eq("message_id", whatsapp_message_id)
          .maybeSingle();
        await db
          .from("flow_runs")
          .update({
            last_prompt_message_id: (msg as { id: string } | null)?.id ?? null,
          })
          .eq("id", run.id);
      } catch (err) {
        const reason = `${node.node_type}_prompt_failed`;
        await logEvent(db, run.id, "error", node.node_key, {
          reason,
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", reason);
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "ai_reply" && Array.isArray(node.config.goals) && node.config.goals.length > 0) {
      // Stage 5: a goal-driven step works through its goals over several messages.
      const turn = await goalTurn(db, run, node, null);
      if (turn.vars && Object.keys(turn.vars).length) await setRunVars(db, run, turn.vars).catch(() => undefined);
      if (turn.next !== null) {
        currentKey = turn.next;
        continue;
      }
      if (!(await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key))) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "ai_reply") {
      // The AI answers the customer's latest message. One answer moves on
      // through a port; with more turns the step waits for follow-ups.
      const turn = await aiReplyTurn(db, run, node, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, 1);
      if (turn.ended) return { outcome: "completed" };
      if (turn.vars) {
        try {
          await setRunVars(db, run, turn.vars);
        } catch (err) {
          // Non-fatal, like set_attribute: the answer already went out.
          await logEvent(db, run.id, "error", node.node_key, { reason: "ai_reply_var_failed", detail: errorDetail(err) });
        }
      }
      if (turn.next !== null) {
        currentKey = turn.next;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_form") {
      // Send the form and suspend; the submission wakes the run up.
      try {
        const whatsapp_message_id = await sendFormForNode(run, node, run.reprompt_count);
        await logEvent(db, run.id, "form_sent", node.node_key, {
          form_id: (node.config as unknown as SendFormNodeConfig).form_id,
          whatsapp_message_id,
        });
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_form_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_form_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "payment_link") {
      const started = await startPaymentLinkNode(db, run, node);
      if (started.kind === "next") {
        if (started.key) {
          currentKey = started.key;
          continue;
        }
        const end = paymentEnd(started.outcome);
        await endRun(db, run.id, end.status, end.reason);
        return { outcome: "completed" };
      }
      // The run is not stale while the link can still be paid (staleSince).
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key, { wait_until: started.expiresAt });
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
        return { outcome: "advanced" };
      }
      await scheduleReplyTimeout(db, run, node);
      // A payment that settled before the run started waiting found no waiting run: catch up now.
      const reference = flowPaymentReference(run.id, node.node_key, run.transition_seq ?? 0);
      const latest = await findLinkByReference(run.account_id, reference).catch(() => null);
      const outcome = latest ? flowOutcomeFor(latest.status) : null;
      if (latest && outcome) {
        await resumePaymentLinkRun({ accountId: run.account_id, runId: run.id, nodeKey: node.node_key, referenceId: reference, outcome, status: latest.status });
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "book_appointment") {
      const started = await startAppointmentStep(db, run, node);
      if (started.kind === "failed") return { outcome: "completed" };
      if (started.kind === "next") {
        if (started.key) {
          currentKey = started.key;
          continue;
        }
        await endRun(db, run.id, "completed", `appointment_${started.outcome}`);
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_template") {
      const cfg = node.config as unknown as SendTemplateNodeConfig;
      // Templates are business-initiated: an opted-out or blocked contact is skipped (lib/contacts/consent).
      const suppressed = await templateSuppression(db, run);
      if (suppressed) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "template_suppressed",
          detail: suppressed.toLowerCase(),
        });
        if (!cfg.next_node_key) {
          await endRun(db, run.id, "cancelled", "contact_opted_out");
          return { outcome: "completed" };
        }
        currentKey = cfg.next_node_key;
        continue;
      }
      try {
        await sendTemplateNode(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_template_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_template_failed");
        return { outcome: "completed" };
      }
      if (!templateWaits(node.config)) {
        currentKey = cfg.next_node_key ?? null;
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "api_request") {
      currentKey = await executeApiRequest(db, run, node);
      continue;
    }
    if (node.node_type === "conversion_event") {
      // Queued for the worker, never sent inline; a no-op while CAPI is off.
      const result = await runConversionEvent(run, node);
      if (result.queued) {
        await logEvent(db, run.id, "conversion_queued", node.node_key, { event_name: node.config.event_name });
      } else if (result.error) {
        await logEvent(db, run.id, "error", node.node_key, result.error === "invalid_event"
          ? { reason: "conversion_invalid_event" }
          : { reason: "conversion_queue_failed", detail: result.error });
      }
      currentKey = typeof node.config.next_node_key === "string" ? node.config.next_node_key : null;
      continue;
    }
    if (node.node_type === "send_storefront_link") {
      const cfg = node.config as unknown as SendStorefrontLinkNodeConfig;
      let result: StorefrontNodeResult;
      try {
        result = await runStorefrontLinkNode({
          accountId: run.account_id, runId: run.id, nodeKey: node.node_key, transitionSeq: run.transition_seq ?? 0,
          contactId: run.contact_id, conversationId: run.conversation_id, vars: run.vars, config: cfg,
        });
      } catch {
        // Never log the error itself: it could carry customer content or the link.
        result = { ok: false, reason: "failed" };
      }
      if (result.ok) {
        // The link itself is never logged or stored in run variables.
        await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "send_storefront_link", whatsapp_message_id: result.whatsappMessageId });
        currentKey = cfg.next_node_key || null;
        continue;
      }
      await logEvent(db, run.id, "error", node.node_key, { reason: `storefront_link_${result.reason}` });
      // A send whose outcome is unknown may have reached the customer: carry on rather than offer a second link.
      if (result.uncertain) {
        currentKey = cfg.next_node_key || null;
        continue;
      }
      if (cfg.failed_next) {
        currentKey = cfg.failed_next;
        continue;
      }
      await endRun(db, run.id, "failed", "storefront_link_failed");
      return { outcome: "completed" };
    }
    if (node.node_type === "assign_agent") {
      await executeAssignAgent(db, run, node);
      currentKey = (node.config as unknown as AssignAgentNodeConfig).next_node_key;
      continue;
    }
    if (node.node_type === "connect_flow") {
      await executeConnectFlow(db, run, node);
      return { outcome: "completed" };
    }
    if (node.node_type === "set_attribute") {
      const cfg = node.config as unknown as SetAttributeNodeConfig;
      try {
        const ws = await textValues(run, cfg.value ?? "");
        const value = interpolateVars(cfg.value ?? "", run.vars, ws);
        if (cfg.target === "var") {
          const vars = { ...run.vars, [cfg.key]: value };
          const { error } = await db
            .from("flow_runs")
            .update({ vars })
            .eq("id", run.id)
            .eq("status", "active");
          if (error) throw new Error("Run variable write failed");
          run.vars = vars;
        } else if (!(await writeContactField(db, run.account_id, run.contact_id!, cfg.target === "custom_field" ? `custom:${cfg.key}` : cfg.key, value))) {
          throw new Error(`field ${cfg.key} is not writable`);
        }
        // The value itself may be customer input, so only its size is logged.
        await logEvent(db, run.id, "attribute_set", node.node_key, { target: cfg.target, key: cfg.key, length: value.length });
      } catch (err) {
        // Non-fatal, like set_tag: a failed write should not strand the customer.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_attribute_failed",
          detail: errorDetail(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "condition") {
      const cfg = node.config as unknown as ConditionNodeConfig;
      let branch: "true" | "false";
      try {
        branch = (await evaluateConditionNode(db, run, cfg))
          ? "true"
          : "false";
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "condition_evaluation_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "condition_evaluation_failed");
        return { outcome: "completed" };
      }
      currentKey =
        branch === "true" ? cfg.true_next : cfg.false_next;
      await logEvent(db, run.id, "node_entered", node.node_key, {
        condition_result: branch,
        advancing_to: currentKey,
      });
      continue;
    }
    if (node.node_type === "set_tag") {
      const cfg = node.config as unknown as SetTagNodeConfig;
      try {
        if (cfg.mode === "add") {
          await addTag({
            db,
            accountId: run.account_id,
            contactId: run.contact_id!,
            tagId: cfg.tag_id,
            context: {
              conversation_id: run.conversation_id ?? undefined,
              vars: run.vars,
            },
          });
        } else if (await removeTag({ db, accountId: run.account_id, contactId: run.contact_id!, tagId: cfg.tag_id }) === "not_found") {
          throw new Error("tag not found");
        }
      } catch (err) {
        // Non-fatal — log + advance. A tag-write failure shouldn't
        // strand the customer mid-flow.
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "set_tag_failed",
          detail: errorDetail(err),
        });
      }
      currentKey = cfg.next_node_key;
      continue;
    }
    if (node.node_type === "send_buttons") {
      // Same failure contract as send_message / send_media /
      // collect_input above: log + fail the run. Previously an
      // exception here (Meta error, or meta-api's length validation —
      // now reachable via interpolation, see sendButtonsAndSuspend)
      // escaped to dispatchInboundToFlows' catch, which only
      // console.error'd and left the run active + stuck on the prior
      // node with nothing in flow_run_events.
      try {
        await sendButtonsAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_buttons_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_buttons_failed");
        return { outcome: "completed" };
      }
      // Persist the new current_node_key via optimistic UPDATE.
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "send_list") {
      try {
        await sendListAndSuspend(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "send_list_failed",
          detail: errorDetail(err),
        });
        await endRun(db, run.id, "failed", "send_list_failed");
        return { outcome: "completed" };
      }
      const advanced = await advanceCurrentNodeKey(
        db,
        run,
        run.current_node_key,
        node.node_key,
      );
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, {
          reason: "lost_race_during_advance",
        });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "ig_comment_reply") {
      // A public reply under the comment that started the run; never interpolated
      // (it is public, so no run variable may leak into it). Non-fatal.
      const cfg = node.config as unknown as IgCommentReplyNodeConfig;
      const eventId = commentEventOf(run);
      const commentId = typeof run.vars.ig_comment_id === "string" ? run.vars.ig_comment_id : "";
      const text = eventId && commentId ? pickPublicReply(cfg.replies, commentId, validCommentReply) : null;
      // Stage 5: a run that started from a message (a flow with a keyword next to its
      // comment trigger) has no comment to answer: the step is skipped with an event.
      let outcome = eventId ? "unavailable" : "skipped_not_comment";
      if (eventId && text) {
        try {
          outcome = await postCommentPublicReply(run.account_id, eventId, text);
        } catch {
          outcome = "failed";
        }
      }
      if (outcome === "posted") await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "ig_comment_reply" });
      else await logEvent(db, run.id, "error", node.node_key, { reason: `comment_reply_${outcome}` });
      currentKey = cfg.next_node_key || null;
      if (!currentKey) {
        await endRun(db, run.id, "completed", "end_node");
        return { outcome: "completed" };
      }
      continue;
    }
    if (node.node_type === "ig_private_reply") {
      const result = await runPrivateReplyStep(db, run, node);
      if (result.next === null) return { outcome: result.outcome };
      currentKey = result.next;
      continue;
    }
    if (node.node_type === "send_card" || node.node_type === "send_gallery") {
      try {
        await sendCards(db, run, node);
      } catch (err) {
        await logEvent(db, run.id, "error", node.node_key, { reason: `${node.node_type}_failed`, detail: errorDetail(err) });
        await endRun(db, run.id, "failed", `${node.node_type}_failed`);
        return { outcome: "completed" };
      }
      if (!cardWaits(node)) {
        currentKey = typeof node.config.next_node_key === "string" && node.config.next_node_key ? node.config.next_node_key : null;
        if (!currentKey) {
          await endRun(db, run.id, "completed", "end_node");
          return { outcome: "completed" };
        }
        continue;
      }
      const advanced = await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key);
      if (!advanced) {
        await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
      } else {
        await scheduleReplyTimeout(db, run, node);
      }
      return { outcome: "advanced" };
    }
    if (node.node_type === "handoff") {
      await executeHandoff(db, run, node);
      return { outcome: "handed_off" };
    }
    if (node.node_type === "end") {
      await logEvent(db, run.id, "completed", node.node_key);
      await endRun(db, run.id, "completed", "end_node");
      return { outcome: "completed" };
    }
    // Unknown node type — shouldn't happen given the CHECK constraint.
    await logEvent(db, run.id, "error", node.node_key, {
      reason: `unknown_node_type:${node.node_type}`,
    });
    await endRun(db, run.id, "failed", "unknown_node_type");
    return { outcome: "completed" };
  }
  // Safety break — log + fail.
  await logEvent(db, run.id, "error", currentKey, {
    reason: "advance_loop_safety_break",
  });
  await endRun(db, run.id, "failed", "advance_loop_overflow");
  return { outcome: "completed" };
}

/**
 * Optimistic UPDATE — only advance current_node_key when it matches
 * the value we read at the top of dispatch. If another webhook beat
 * us, the row's pointer has already moved and our UPDATE returns
 * zero rows; we treat that as a no-op and let the other run continue.
 */
export async function advanceCurrentNodeKey(
  db: AdminClient,
  run: Pick<FlowRunRow, "id" | "flow_version_id">,
  expectedOldKey: string | null,
  newKey: string,
  /** Only a payment_link step waits until a deadline; any other move clears it. */
  wait: { wait_until: string | null } = { wait_until: null },
): Promise<boolean> {
  // PostgREST: when expectedOldKey is null we can't `.eq` (would match
  // any row); use `.is('current_node_key', null)` instead.
  let q = db
    .from("flow_runs")
    .update({
      current_node_key: newKey,
      last_advanced_at: new Date().toISOString(),
      wait_until: wait.wait_until,
    })
    .eq("id", run.id)
    .eq("status", "active");
  // A run moved to another version meanwhile (Phase 12 migrate) loses the race.
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
  if (expectedOldKey === null) {
    q = q.is("current_node_key", null);
  } else {
    q = q.eq("current_node_key", expectedOldKey);
  }
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] advanceCurrentNodeKey error:", error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ============================================================
export async function claimReplyTransition(
  db: AdminClient,
  run: FlowRunRow,
  nextNodeKey: string,
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const fromKey = run.current_node_key;
  if (fromKey === null) return false;
  const nextSeq = (run.transition_seq ?? 0) + 1;
  let q = db
    .from("flow_runs")
    .update({
      ...extra,
      current_node_key: nextNodeKey,
      transition_seq: nextSeq,
      reprompt_count: 0,
      wait_until: null,
      last_advanced_at: new Date().toISOString(),
    })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", fromKey)
    .eq("transition_seq", run.transition_seq ?? 0);
  // The run's version is part of its position: a run migrated meanwhile loses the race.
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] claimReplyTransition error:", error.message);
    return false;
  }
  if (!Array.isArray(data) || data.length !== 1) return false;
  run.current_node_key = nextNodeKey;
  run.transition_seq = nextSeq;
  run.reprompt_count = 0;
  committedRuns.add(run);
  return true;
}

/**
 * Runs whose position this dispatch has committed (a reply transition or a new
 * run). An error after that point must not let automations or the AI answer
 * the same inbound, nor leave the run active on a step it never ran (audit
 * finding 48): dispatchInboundToFlows ends it as failed instead.
 */
export const committedRuns = new WeakSet<FlowRunRow>();

export class FlowAdvanceInterrupted extends Error {
  constructor(readonly run: FlowRunRow) {
    super("Flow advance interrupted after a committed transition");
    this.name = "FlowAdvanceInterrupted";
  }
}

export async function guardCommitted<T>(run: FlowRunRow, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    // A Connect Flow target interrupted inside this advance is the run left
    // active; this run already ended (connect_flow), so keep the inner one.
    if (err instanceof FlowAdvanceInterrupted) throw err;
    if (committedRuns.has(run)) {
      console.error("[flows] advance interrupted:", err instanceof Error ? err.message : err);
      throw new FlowAdvanceInterrupted(run);
    }
    throw err;
  }
}

/**
 * Ends an interrupted run as failed (advance_interrupted) and reports the
 * inbound as consumed. If even that write fails, the error propagates: the
 * inbound's flow stage is then left for reconciliation, and still nothing else
 * answers the message.
 */
export async function endInterruptedRun(db: AdminClient, run: FlowRunRow): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "error", run.current_node_key, { reason: "advance_interrupted" });
  await endRun(db, run.id, "failed", "advance_interrupted");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/**
 * Adds vars to a run that stays on its current node. Compare-and-set on the
 * run's position: if the run moved meanwhile the merge is skipped (the vars
 * are a convenience, never worth overwriting a concurrent transition).
 */
export async function mergeWaitingRunVars(db: AdminClient, run: FlowRunRow, vars: Record<string, string>): Promise<void> {
  if (run.current_node_key === null || Object.keys(vars).length === 0) return;
  const merged = { ...run.vars, ...vars };
  let q = db
    .from("flow_runs")
    .update({ vars: merged })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", run.current_node_key)
    .eq("transition_seq", run.transition_seq ?? 0);
  if (run.flow_version_id) q = q.eq("flow_version_id", run.flow_version_id);
  const { data, error } = await q.select("id");
  if (error) {
    console.error("[flows] mergeWaitingRunVars error:", error.message);
    return;
  }
  if (Array.isArray(data) && data.length === 1) run.vars = merged;
}

export async function closeActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  closure: ActiveRunClosure,
  now: Date,
): Promise<boolean> {
  if (closure.kind === "timeout") {
    return markRunTimedOut(db, run.id, closure.check, "timed_out_on_reply", now, run);
  }
  await endRun(
    db,
    run.id,
    closure.kind === "cancel" ? "cancelled" : "failed",
    closure.reason,
  );
  return true;
}

// Public entry point — the webhook calls this on every inbound.
// ============================================================

export async function dispatchInboundToFlows(
  input: DispatchInboundInput & { isFirstInboundMessage: boolean; /** This message created the contact. */ isNewContact?: boolean },
): Promise<DispatchInboundResult> {
  const db = databaseAdmin();
  // The contact's number is needed only when a draft flow is being tested; read it at most once.
  let digits: Promise<string> | undefined;
  const contactDigits = () => (digits ??= (async () => {
    const { data } = await db.from("contacts").select("phone").eq("account_id", input.accountId).eq("id", input.contactId).maybeSingle();
    return phoneDigits((data as { phone?: string | null } | null)?.phone);
  })());
  // Stage 5: the Instagram username, for drafts tested by username; read at most once.
  let username: Promise<string> | undefined;
  const contactUsername = () => (username ??= storedInstagramUsername(input.accountId, input.contactId, input.conversationId));
  try {
    if (await botRepliesPaused(input.accountId, input.conversationId)) return { consumed: true, outcome: 'no_match' };
    const activeRun = await loadActiveRunForConversation(
      db,
      input.accountId,
      input.contactId,
      input.conversationId,
    );

    // Idempotency — only matters if there's already a run on this
    // conversation. For new runs, the partial unique index catches duplicate
    // starts at INSERT time.
    if (activeRun) {
      const dupe = await isDuplicateInbound(
        db,
        input.accountId,
        input.contactId,
        input.message.meta_message_id,
      );
      if (dupe) {
        const resumed = await guardCommitted(activeRun, () => resumeInterruptedBooking(db, activeRun, input.message));
        if (resumed) return resumed;
        return {
          consumed: true,
          flow_run_id: activeRun.id,
          outcome: "duplicate_inbound_ignored",
        };
      }
      // One SELECT for the whole flow's nodes — advance loop is now
      // in-memory. See loadAllNodes.
      const { flow: runFlow, nodes } = await loadRunGraph(db, activeRun);
      const now = new Date();
      const testContact = runFlow?.status === "draft" && (isTestContact(runFlow, await contactDigits())
        || ((runFlow.test_usernames ?? []).length > 0 && isTestUsername(runFlow, await contactUsername())));
      const closure = closureForActiveRun({ run: activeRun, flow: runFlow, nodeKeys: nodes, now, testContact });
      // Stage 5: unsubscribed on Instagram, the run sends nothing more (agents can still answer by hand).
      // A WhatsApp-only flow never asks (its runs are exactly as before Stage 5).
      if (!closure && scopeIncludes(runFlow?.channel_scope, "instagram") && (await runChannel(activeRun)) === "instagram"
        && !(await instagramAutomationAllowed(input.accountId, input.contactId))) {
        await endRun(db, activeRun.id, "cancelled", "contact_opted_out");
        return { consumed: false, outcome: "no_match" };
      }
      if (!closure) return await guardCommitted(activeRun, () => handleReplyForActiveRun(db, activeRun, runFlow!, input.message, nodes));
      if (!(await closeActiveRun(db, activeRun, closure, now))) {
        return { consumed: true, flow_run_id: activeRun.id, outcome: "duplicate_inbound_ignored" };
      }
    }

    // No active run: a conversation starter tap starts its own flow.
    const starter = await startIceBreakerFlow(db, input);
    if (starter) return starter;

    // No active run → look for a flow whose entry trigger matches.
    const entry = await findEntryFlow(
      db,
      input.accountId,
      input.conversationId,
      input.contactId,
      input.message,
      input.isFirstInboundMessage,
      contactDigits,
      contactUsername,
      input.isNewContact === true,
    );
    if (!entry || !entry.flow.entry_node_id) {
      return { consumed: false, outcome: "no_match" };
    }
    const nodes = entry.version ? versionNodeMap(entry.version) : await loadAllNodes(db, entry.flow.id);
    return await startNewRun(db, entry.flow, input, nodes, entry.vars);
  } catch (err) {
    if (err instanceof FlowAdvanceInterrupted) return endInterruptedRun(db, err.run);
    console.error(
      "[flows] dispatchInboundToFlows threw:",
      err instanceof Error ? err.message : err,
    );
    return { consumed: false, outcome: "no_match" };
  }
}

async function handleReplyForActiveRun(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  message: ParsedInbound,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  // Note: we intentionally do NOT persist the raw customer text. A
  // `collect_input` prompt that asks "what's your card number?" would
  // otherwise leave the PAN sitting in flow_run_events.payload forever,
  // visible to anyone with access to the runs viewer or the events
  // table. Length is enough for "did they actually reply?" debugging;
  // for the captured value itself, the `node_entered` event already
  // records `captured_key` + `captured_length` after the var is stored.
  await logEvent(db, run.id, "reply_received", run.current_node_key, {
    meta_message_id: message.meta_message_id,
    reply_kind: message.kind,
    reply_id: message.kind === "interactive_reply" ? message.reply_id : null,
    text_length: message.kind === "text" ? message.text.length : null,
    // The transition the reply arrived at: resumeInterruptedBooking matches a retried job on it.
    transition_seq: run.transition_seq ?? 0,
  });

  if (!run.current_node_key) {
    // Defensive — a run with status='active' but no current node is
    // malformed. Fail the run rather than spin.
    await endRun(db, run.id, "failed", "active_run_missing_current_node");
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: "no_match",
    };
  }

  const currentNode = nodes.get(run.current_node_key) ?? null;
  if (!currentNode) {
    await endRun(db, run.id, "failed", "current_node_not_found");
    return { consumed: true, flow_run_id: run.id, outcome: "no_match" };
  }

  // A reply during a delay is recorded but changes nothing: the run
  // carries on when the delay ends, and no automation answers instead.
  if (run.delay_until) {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // A replayed run is active on its failed step before the flow.replay job
  // has re-sent that step's prompt. A message in that gap is recorded but
  // must not answer (or fall back on) a prompt the customer never saw; the
  // replay's node_entered event ends the gap.
  if (await awaitingReplay(db, run)) {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // Instagram postback codes (postback-payloads.ts) are claims about this run:
  // they act only when they name this run and the step it is on.
  // WhatsApp runs never read them, so a WhatsApp reply id is routed exactly as before.
  const decoded = message.kind === "interactive_reply" ? decodePostback(message.reply_id) : null;
  const code = decoded && (await runChannel(run)) === "instagram" ? decoded : null;
  if (currentNode.node_type === "ig_private_reply") {
    // Waiting for the commenter to open the conversation: the "Opening DM" tap,
    // or anything they type (which opens the 24-hour window just the same).
    const cfg = currentNode.config as unknown as IgPrivateReplyNodeConfig;
    const tapped = code?.kind === "opt_in" && code.runId === run.id && code.nodeKey === currentNode.node_key;
    const typed = message.kind === "text" && message.text.trim() !== "";
    if (!(tapped || typed) || !cfg.next_node_key) return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    if (!(await claimReplyTransition(db, run, cfg.next_node_key))) return lostReplyRace(db, run, currentNode.node_key);
    const eventId = commentEventOf(run);
    if (eventId) await recordCommentOptIn(run.account_id, eventId, run.id).catch(() => console.error("[flows] opt-in record failed", { runId: run.id }));
    await logEvent(db, run.id, "node_entered", currentNode.node_key, { opted_in: tapped ? "tap" : "reply" });
    const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }
  if (code?.kind === "opt_in") return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  if (code?.kind === "follow_check") {
    // "I followed": re-run the follow gate's condition (it re-reads the profile).
    const target = code.runId === run.id ? nodes.get(code.nodeKey) : undefined;
    if (!target || target.node_type !== "condition") return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    if (!(await claimReplyTransition(db, run, target.node_key))) return lostReplyRace(db, run, currentNode.node_key);
    const outcome = await advanceFromNodeKey(db, run, target.node_key, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }

  // Two ways a reply can advance:
  //   1. Interactive button/list tap on a send_buttons/send_list node.
  //   2. An answer on a question node — captured into vars.
  //
  // Everything else falls through to the fallback policy below.
  if (message.kind === "form") {
    // Only the submission of the form this run's current node sent (its
    // own trusted session) resumes the run. Any other submission is
    // stored with its message and changes nothing here.
    const cfg = currentNode.config as unknown as SendFormNodeConfig;
    const ours = currentNode.node_type === "send_form" && message.trusted &&
      message.flow_run_id === run.id && message.node_key === currentNode.node_key;
    if (!ours || !cfg.var_key || !cfg.next_node_key) return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    const newVars = { ...run.vars, ...formAnswerVars(cfg.var_key, message.answers) };
    if (!(await claimReplyTransition(db, run, cfg.next_node_key, { vars: newVars }))) {
      return lostReplyRace(db, run, currentNode.node_key);
    }
    run.vars = newVars;
    // Field ids only: the answers are customer content.
    await logEvent(db, run.id, "form_submitted", currentNode.node_key, {
      form_id: message.form_id,
      fields: Object.keys(message.answers).slice(0, 100),
    });
    const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }

  if (message.kind === "order") {
    // Policy: a WhatsApp cart is never an answer. While a run waits (on a
    // question, buttons, a form...), the cart leaves it waiting where it is:
    // no var is captured from the cart summary, no reprompt or fallback fires.
    // The order itself is still handled outside the run (stored with its
    // message, order confirmation, order.created webhook). Its order_* vars
    // are merged into the waiting run so a flow that sent the product list can
    // use them later. An order_received flow starts only when no run is active
    // on the conversation: one active run per conversation is a database
    // invariant, and silently ending a run the customer is in the middle of
    // would lose their place.
    await mergeWaitingRunVars(db, run, message.vars);
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // Stage 5: a goal-driven AI step takes the person's next message as its next turn.
  if (currentNode.node_type === "ai_reply" && Array.isArray(currentNode.config.goals) && currentNode.config.goals.length > 0) {
    if (message.kind !== "text" || !message.text.trim()) return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    // The turn is claimed first (transition_seq moves on), so two messages cannot both answer it.
    const seq = (run.transition_seq ?? 0) + 1;
    let claim = db.from("flow_runs").update({ transition_seq: seq, last_advanced_at: new Date().toISOString() })
      .eq("id", run.id).eq("status", "active").eq("current_node_key", currentNode.node_key).eq("transition_seq", run.transition_seq ?? 0);
    if (run.flow_version_id) claim = claim.eq("flow_version_id", run.flow_version_id);
    const claimed = await claim.select("id");
    if (claimed.error || !Array.isArray(claimed.data) || claimed.data.length !== 1) return lostReplyRace(db, run, currentNode.node_key);
    run.transition_seq = seq;
    const turn = await goalTurn(db, run, currentNode, message);
    if (turn.next === null) {
      if (turn.vars) await mergeWaitingRunVars(db, run, turn.vars);
      await scheduleReplyTimeout(db, run, currentNode);
      return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
    }
    const vars = turn.vars && Object.keys(turn.vars).length ? { ...run.vars, ...turn.vars } : null;
    if (!(await claimReplyTransition(db, run, turn.next, vars ? { vars } : {}))) return lostReplyRace(db, run, currentNode.node_key);
    if (vars) run.vars = vars;
    const outcome = await advanceFromNodeKey(db, run, turn.next, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }
  // A typed follow-up on a waiting AI reply step is answered by the AI.
  if (currentNode.node_type === "ai_reply" && message.kind === "text" && message.text.trim()) {
    return continueAiReplyNode(db, run, currentNode, nodes, message.meta_message_id);
  }
  // Anything else on a waiting AI reply step (a photo, a sticker, an old
  // button tap, empty text) is not a question: it must not use up an AI
  // turn through reprompt_count or fire the flow's fallback.
  if (currentNode.node_type === "ai_reply") {
    return { consumed: true, flow_run_id: run.id, outcome: "waiting" };
  }

  // The booking step answers every reply itself: its next question, Cancel, or a re-prompt.
  if (currentNode.node_type === "book_appointment") {
    return handleAppointmentReply(db, run, currentNode, message, nodes);
  }

  let matched: string | null = null;
  if (
    message.kind === "interactive_reply" &&
    (currentNode.node_type === "send_buttons" ||
      currentNode.node_type === "send_list" ||
      currentNode.node_type === "send_template" ||
      currentNode.node_type === "send_card" ||
      currentNode.node_type === "send_gallery")
  ) {
    // A template is never re-sent as a reprompt (it costs money), so an
    // unknown reply below only counts towards the flow's exhaust policy.
    matched = matchReplyId(currentNode, message.reply_id);
  } else if (isAskNode(currentNode.node_type)) {
    const cfg = currentNode.config as unknown as AskRetry & { skip_label?: string; skip_next?: string; next_node_key: string; var_key?: string };
    if (message.kind === "interactive_reply" && message.reply_id === SKIP_REPLY_ID && cfg.skip_label && cfg.skip_next) {
      if (!(await claimReplyTransition(db, run, cfg.skip_next))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      await logEvent(db, run.id, "node_entered", currentNode.node_key, { skipped: true });
      const outcome = await advanceFromNodeKey(db, run, cfg.skip_next, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    const captured = await captureAnswer(currentNode, message);
    if (captured && cfg.var_key) {
      const newVars = { ...run.vars, ...captured };
      if (!(await claimReplyTransition(db, run, cfg.next_node_key, { vars: newVars }))) {
        return lostReplyRace(db, run, currentNode.node_key);
      }
      run.vars = newVars;
      await logEvent(db, run.id, "node_entered", currentNode.node_key, {
        captured_key: cfg.var_key,
        captured_length: captured[cfg.var_key].length,
      });
      if (currentNode.node_type === "collect_input") {
        // Stage 5: "save answer to" a contact or custom field, then the actions on a valid answer.
        await saveAnswer(db, run, currentNode, captured[cfg.var_key]);
        const onSuccess = (currentNode.config as unknown as CollectInputNodeConfig).on_success_actions;
        if (Array.isArray(onSuccess) && onSuccess.length) {
          const result = await runActionsNode(db, run, currentNode, onSuccess, ":ok");
          if (result.paused) {
            await endRun(db, run.id, "completed", "automations_paused");
            return { consumed: true, flow_run_id: run.id, outcome: "completed" };
          }
        }
      }
      const outcome = await advanceFromNodeKey(db, run, cfg.next_node_key, nodes);
      return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
    }
    if (typeof cfg.max_attempts === "number" && cfg.max_attempts >= 1) {
      return retryQuestion(db, run, flow, currentNode, nodes);
    }
  }

  if (matched) {
    if (!(await claimReplyTransition(db, run, matched))) {
      return lostReplyRace(db, run, currentNode.node_key);
    }
    const outcome = await advanceFromNodeKey(db, run, matched, nodes);
    return {
      consumed: true,
      flow_run_id: run.id,
      outcome: outcome.outcome,
    };
  }

  // No match → fallback. Apply the policy.
  const policy = resolveFallbackPolicy(
    flow.fallback_policy,
  );
  // An opted-in menu may answer a text question while keeping the exact
  // same menu active. Reserve the inbound so automations cannot take it.
  if (policy.on_unknown_reply === "ai" && message.kind === "text" && message.text.trim() &&
      (currentNode.node_type === "send_buttons" || currentNode.node_type === "send_list")) {
    return { consumed: true, flow_run_id: run.id, outcome: "ai_fallback" };
  }
  const newReprompts = run.reprompt_count + 1;
  // Claimed like every other reply-path write: a run that advanced, was
  // re-prompted or was migrated to another version meanwhile loses the race
  // instead of getting this version's fallback prompt and count.
  let fallbackClaim = db
    .from("flow_runs")
    .update({ reprompt_count: newReprompts })
    .eq("id", run.id)
    .eq("status", "active")
    .eq("current_node_key", currentNode.node_key)
    .eq("transition_seq", run.transition_seq ?? 0)
    .eq("reprompt_count", run.reprompt_count);
  if (run.flow_version_id) fallbackClaim = fallbackClaim.eq("flow_version_id", run.flow_version_id);
  const claimed = await fallbackClaim.select("id");
  if (claimed.error || !Array.isArray(claimed.data) || claimed.data.length !== 1) {
    return lostReplyRace(db, run, currentNode.node_key);
  }

  const action = decideFallback({ policy, reprompt_count: newReprompts });
  await logEvent(db, run.id, "fallback_fired", run.current_node_key, {
    action: action.type,
    reprompt_count: newReprompts,
  });
  if (action.type === "ignore") {
    // Don't consume — let automations have a shot at it.
    return { consumed: false, flow_run_id: run.id, outcome: "no_match" };
  }
  await sendFallbackMessage(db, run, currentNode, policy, message.meta_message_id);
  if (action.type === "reprompt") {
    run.reprompt_count = newReprompts;
    // Re-send the same prompt. Same node, no current_node_key change.
    // The interactive helpers interpolate run.vars themselves, so a
    // reprompt renders the same text the original prompt did. A send
    // failure here is logged but does not end the run — the customer
    // still has the original prompt on screen and can retry.
    try {
      if (currentNode.node_type === "send_buttons") {
        await sendButtonsAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_list") {
        await sendListAndSuspend(db, run, currentNode);
      } else if (currentNode.node_type === "send_card" || currentNode.node_type === "send_gallery") {
        await sendCards(db, run, currentNode);
      } else if (isAskNode(currentNode.node_type)) {
        // The customer sent something we couldn't accept. Re-send the
        // prompt so they try again.
        await sendAskPrompt(run, currentNode, newReprompts);
      } else if (currentNode.node_type === "send_form") {
        // Each re-send issues its own session for this run and node; either submission resumes it.
        await sendFormForNode(run, currentNode, newReprompts);
      } else if (currentNode.node_type === "payment_link" && typeof run.vars.payment_link_url === "string" && run.vars.payment_link_url) {
        // The same link again; the step never creates a second one.
        await sendPaymentLinkText(run, currentNode, run.vars.payment_link_url, newReprompts);
      }
    } catch (err) {
      await logEvent(db, run.id, "error", currentNode.node_key, {
        reason: "reprompt_send_failed",
        detail: errorDetail(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (action.type === "handoff") return fallbackHandoff(db, run);
  // action.type === 'end'
  await endRun(db, run.id, "completed", "fallback_exhausted_end");
  return { consumed: true, flow_run_id: run.id, outcome: "completed" };
}

/**
 * The flow's default reply to an off-script message, sent before the
 * reprompt / handoff / end it triggers. One outbound intent per inbound
 * message, so a replayed inbound never sends it twice; a failed send is
 * logged and the fallback action still runs.
 */
async function sendFallbackMessage(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
  policy: ReturnType<typeof resolveFallbackPolicy>,
  inboundMessageId: string,
): Promise<void> {
  const message = policy.fallback_message;
  if (!message) return;
  try {
    const ws = await textValues(run, message.text);
    const text = interpolateVars(message.text, run.vars, ws);
    const base = { accountId: run.account_id, userId: run.user_id, conversationId: run.conversation_id!, contactId: run.contact_id! };
    const { whatsapp_message_id } = await flowSend(run, `flow-fallback:${run.id}:${inboundMessageId}`,
      message.media_type && message.media_url
        ? { kind: "media", args: { ...base, kind: message.media_type, link: message.media_url, caption: text || undefined } }
        : { kind: "text", args: { ...base, text } });
    await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "fallback_message", whatsapp_message_id });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, {
      reason: "fallback_message_failed",
      detail: errorDetail(err),
    });
  }
}

async function fallbackHandoff(db: AdminClient, run: FlowRunRow): Promise<DispatchInboundResult> {
  if (run.conversation_id) {
    await db
      .from("conversations")
      .update({ status: "pending", bot_paused: true, updated_at: new Date().toISOString() })
      .eq("id", run.conversation_id);
  }
  await logEvent(db, run.id, "handoff", run.current_node_key, {
    reason: "fallback_exhausted",
  });
  await endRun(db, run.id, "handed_off", "fallback_exhausted");
  return { consumed: true, flow_run_id: run.id, outcome: "handed_off" };
}

/**
 * The answer a question node stores, as run variables, or null when the
 * reply does not fit. A text question still reads a photo's caption or a
 * shared location as text, as it always has.
 */
async function captureAnswer(node: FlowNodeRow, message: ParsedInbound): Promise<Record<string, string> | null> {
  const key = (node.config as { var_key?: unknown }).var_key;
  if (typeof key !== "string" || !key) return null;
  switch (node.node_type) {
    case "collect_input": {
      // A tap, a cart or a form submission is never a typed answer.
      if (message.kind === "interactive_reply" || message.kind === "order" || message.kind === "form") return null;
      const value = await normalizeCollectedInput(messageText(message), node.config as unknown as CollectInputNodeConfig);
      return value === null ? null : { [key]: value };
    }
    case "ask_media": {
      const types = (node.config as unknown as AskMediaNodeConfig).media_types ?? [];
      if (message.kind !== "media" || (types.length > 0 && !types.includes(message.media_type))) return null;
      return { [key]: message.url, [`${key}_type`]: message.media_type };
    }
    case "ask_location": {
      if (message.kind !== "location") return null;
      const { latitude, longitude, name, address } = message;
      return {
        [key]: `${latitude},${longitude}`,
        [`${key}_latitude`]: String(latitude),
        [`${key}_longitude`]: String(longitude),
        ...(name ? { [`${key}_name`]: name } : {}),
        ...(address ? { [`${key}_address`]: address } : {}),
      };
    }
    case "ask_address": {
      if (message.kind === "address") {
        return {
          [key]: Object.values(message.values).join(", "),
          ...Object.fromEntries(Object.entries(message.values).map(([field, value]) => [`${key}_${field}`, value])),
        };
      }
      // Outside India (or when the form is ignored) the address is typed.
      const typed = message.kind === "text" ? message.text.trim() : "";
      return typed ? { [key]: typed.slice(0, 1000) } : null;
    }
    default:
      return null;
  }
}

/**
 * "Save answer to" on an Ask Question step (Stage 5): a valid answer is also
 * written to a contact field or custom field (nodes/actions.ts
 * writeContactValue). A phone or email another contact already has is not
 * written and never merges contacts: the answer stays in the run variable and
 * a `save_conflict` event is logged, without the value. Non-fatal.
 */
async function saveAnswer(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, value: string): Promise<void> {
  const saveTo = (node.config as unknown as CollectInputNodeConfig).save_to;
  if (!saveTo || !run.contact_id || (saveTo.target !== "contact_field" && saveTo.target !== "custom_field") || typeof saveTo.key !== "string") return;
  try {
    const written = await writeContactValue(db, { accountId: run.account_id, contactId: run.contact_id, target: saveTo.target, key: saveTo.key, value: value.slice(0, 1000) });
    if (written === "written") await logEvent(db, run.id, "attribute_set", node.node_key, { target: saveTo.target, key: saveTo.key, length: value.length });
    else await logEvent(db, run.id, "error", node.node_key, { reason: written === "conflict" ? "save_conflict" : "save_not_writable", target: saveTo.target, key: saveTo.key });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "save_failed", detail: errorDetail(err) });
  }
}

/**
 * Node-level retries for a question with `max_attempts`: an invalid reply
 * gets the error message until the attempts run out, then the run follows
 * `exhausted_next`, or the flow's `on_exhaust` when that port is unset.
 */
async function retryQuestion(
  db: AdminClient,
  run: FlowRunRow,
  flow: FlowRow,
  node: FlowNodeRow,
  nodes: Map<string, FlowNodeRow>,
): Promise<DispatchInboundResult> {
  const cfg = node.config as unknown as AskRetry;
  const attempt = run.reprompt_count + 1;
  await logEvent(db, run.id, "input_invalid", node.node_key, { attempt, max_attempts: cfg.max_attempts });
  if (attempt < cfg.max_attempts!) {
    let claim = db
      .from("flow_runs")
      .update({ reprompt_count: attempt })
      .eq("id", run.id)
      .eq("status", "active")
      .eq("current_node_key", node.node_key)
      .eq("transition_seq", run.transition_seq ?? 0)
      .eq("reprompt_count", run.reprompt_count);
    // A run migrated to another version meanwhile must not get this version's error text.
    if (run.flow_version_id) claim = claim.eq("flow_version_id", run.flow_version_id);
    const { data, error } = await claim.select("id");
    if (error || !Array.isArray(data) || data.length !== 1) {
      return lostReplyRace(db, run, node.node_key);
    }
    run.reprompt_count = attempt;
    try {
      await sendAskPrompt(run, node, attempt, cfg.error_text?.trim() ? cfg.error_text : undefined);
    } catch (err) {
      await logEvent(db, run.id, "error", node.node_key, {
        reason: "reprompt_send_failed",
        detail: errorDetail(err),
      });
    }
    return { consumed: true, flow_run_id: run.id, outcome: "fallback_fired" };
  }
  if (cfg.exhausted_next) {
    if (!(await claimReplyTransition(db, run, cfg.exhausted_next))) {
      return lostReplyRace(db, run, node.node_key);
    }
    const outcome = await advanceFromNodeKey(db, run, cfg.exhausted_next, nodes);
    return { consumed: true, flow_run_id: run.id, outcome: outcome.outcome };
  }
  if (resolveFallbackPolicy(flow.fallback_policy).on_exhaust === "end") {
    await endRun(db, run.id, "completed", "fallback_exhausted_end");
    return { consumed: true, flow_run_id: run.id, outcome: "completed" };
  }
  return fallbackHandoff(db, run);
}

/**
 * Whether the run was replayed onto its current step and the replay job has
 * not run that step yet: its newest event other than reply_received (logged
 * for this very inbound) is the 'replayed' event for the current node.
 */
async function awaitingReplay(db: AdminClient, run: FlowRunRow): Promise<boolean> {
  const { data, error } = await db
    .from("flow_run_events")
    .select("event_type,node_key")
    .eq("flow_run_id", run.id)
    .neq("event_type", "reply_received")
    .order("created_at", { ascending: false })
    .limit(1);
  if (error || !Array.isArray(data) || !data.length) return false;
  const latest = data[0] as { event_type: string; node_key: string | null };
  return latest.event_type === "replayed" && latest.node_key === run.current_node_key;
}

export async function lostReplyRace(
  db: AdminClient,
  run: FlowRunRow,
  nodeKey: string,
): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "error", nodeKey, {
    reason: "lost_race_during_reply",
  });
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: "duplicate_inbound_ignored",
  };
}

export async function startNewRun(
  db: AdminClient,
  /** Overlaid with the version whose trigger matched; the run is pinned to it. */
  flow: EffectiveFlow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  /** Variables carried over by Connect Flow. */
  vars: Record<string, unknown> = {},
): Promise<DispatchInboundResult> {
  // INSERT — partial unique index `idx_one_active_run_per_conversation`
  // catches concurrent inserts with 23505. We catch and return as
  // consumed:true (the parallel webhook handles it).
  const { data: inserted, error: insErr } = await db
    .from("flow_runs")
    .insert({
      flow_id: flow.id,
      // Tenancy: NOT NULL post-017. The partial unique index
      // `idx_one_active_run_per_conversation` is over (account_id,
      // contact_id, conversation_id) WHERE status='active', so two
      // accounts sharing a phone number, and two numbers of one
      // account, each run their own flows independently.
      account_id: flow.account_id,
      // Audit: preserves the flow's author on the run row for log
      // attribution.
      user_id: flow.user_id,
      contact_id: input.contactId,
      conversation_id: input.conversationId,
      status: "active",
      current_node_key: flow.entry_node_id,
      vars,
      // Pinned to the version it starts on (Phase 12); a draft test run has none.
      ...(flow.version_id ? { flow_version_id: flow.version_id } : {}),
    })
    .select("*")
    .maybeSingle();
  if (insErr) {
    // 23505 = unique_violation → another webhook is starting the run.
    const msg = insErr.message ?? "";
    if (msg.includes("23505") || msg.includes("duplicate key")) {
      return { consumed: true, outcome: "duplicate_inbound_ignored" };
    }
    console.error("[flows] startNewRun insert error:", insErr.message);
    return { consumed: false, outcome: "no_match" };
  }
  const run = inserted as FlowRunRow;
  committedRuns.add(run);
  return guardCommitted(run, () => continueNewRun(db, run, flow, input, nodes));
}

export async function continueNewRun(
  db: AdminClient,
  run: FlowRunRow,
  flow: EffectiveFlow,
  input: DispatchInboundInput,
  nodes: Map<string, FlowNodeRow>,
  /** Stage 5: a comment run with a reply delay is parked on its timer instead of advancing now. */
  hold = false,
): Promise<DispatchInboundResult> {
  await logEvent(db, run.id, "started", flow.entry_node_id, {
    flow_id: flow.id,
    ...(flow.version ? { version: flow.version } : {}),
    trigger_type: flow.trigger_type,
    meta_message_id: input.message.meta_message_id,
  });
  if (flow.trigger_type === "ad_click" && input.message.referral?.source_type === "ad") {
    // The ad id only: never the click id, and no customer content.
    await logEvent(db, run.id, "ad_click", flow.entry_node_id, { ad_id: input.message.referral.source_id });
  }
  // Bump the flow's execution counter — used by the builder UI to
  // surface "X runs since activation" on the flow card.
  //
  // Atomic RPC (migration 012) rather than read-modify-write: two
  // concurrent webhooks starting runs for different contacts on the
  // same flow would otherwise both read N and both write N+1, losing
  // a count. Mirrors the automations engine's use of
  // `increment_automation_execution_count` (migration 007).
  const { error: incErr } = await db.rpc("increment_flow_execution_count", {
    p_flow_id: flow.id,
  });
  if (incErr) {
    // Non-fatal — the run itself succeeded; only the counter is off.
    console.error("[flows] execution_count rpc error:", incErr.message);
  }

  if (hold) return holdCommentRun(db, run, nodes);
  // Run the advance loop starting from the entry node.
  const outcome = await advanceFromNodeKey(db, run, flow.entry_node_id!, nodes);
  return {
    consumed: true,
    flow_run_id: run.id,
    outcome: outcome.outcome === "advanced" ? "started" : outcome.outcome,
  };
}
