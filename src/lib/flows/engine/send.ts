// Flow engine, send group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { NoNumberError } from "@/lib/whatsapp/numbers";
import { encodePostback } from "@/lib/instagram/postback-payloads";
import { PRIVATE_REPLY_RETRY_MS, sendCommentPrivateReply } from "@/lib/instagram/private-reply";
import { type IgGenericCard, type IgTemplateButton, type QuickReply } from "@/lib/instagram/graph-limits";
import { instagramAutomatedWindowOpen } from "@/lib/channels/sender";
import { sendTemplateOnce, templateConsentRefusal } from "@/lib/actions/send";
import { templateFlowTokens } from "@/lib/whatsapp/forms/send";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { trackedUrl } from "../link-tracking";
import { buyButtonUrl } from "../buy-button";
import { flowSend, runChannel } from "../channel-send";
import { flowTemplateSendExtras } from "@/lib/whatsapp/template-send-params";
import { type SendTemplateNodeConfig, type FlowNodeRow, type FlowRunRow, type SendButtonsNodeConfig, type SendListNodeConfig, type IgCard, type IgPrivateReplyNodeConfig } from "../types";
import { cardWaits, nodeCards, templateWaits } from "./helpers";
import { type AdminClient, logEvent } from "./run";
import { UUID_RE, errorDetail } from "./commerce";
import { endRun, interpolateOptionalVars, interpolateVars, scheduleDelay, scheduleReplyTimeout, textValues } from "./control";
import { advanceCurrentNodeKey } from "../engine";

export async function sendButtonsAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendButtonsNodeConfig;
  // Every customer-visible string is interpolated against run.vars —
  // same treatment send_message / collect_input already get (#553).
  // `reply_id` is deliberately NOT interpolated: it is the routing key
  // matchReplyId compares the tapped button against, so it must reach
  // Meta byte-for-byte as authored. Interpolation can push a title past
  // Meta's 20-char cap; meta-api's validator throws a descriptive error
  // and the caller logs it — we never truncate silently.
  const ws = await textValues(run, JSON.stringify(cfg));
  const intentKey = `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`;
  // Instagram with link buttons: a button template (real buttons; a link tap does not continue the run).
  const links = Array.isArray(cfg.link_buttons) ? cfg.link_buttons : [];
  if (links.length && (await runChannel(run)) === "instagram") {
    const text = [cfg.header_text, cfg.text, cfg.footer_text].map((part) => (part ? interpolateVars(part, run.vars, ws).trim() : ""))
      .filter(Boolean).join("\n\n");
    // Stage 5: with track_clicks, each link goes out as its own /r/<token> (one per run, step and slot).
    const urls = await Promise.all(links.map((b, i) => (cfg.track_clicks ? trackedUrl(run, node.node_key, `link:${i}`, b.url) : b.url)));
    const buttons: IgTemplateButton[] = [
      ...cfg.buttons.map((b) => ({ type: "postback" as const, title: interpolateVars(b.title, run.vars, ws), payload: b.reply_id })),
      ...links.map((b, i) => ({ type: "web_url" as const, title: interpolateVars(b.title, run.vars, ws), url: urls[i] })),
    ];
    const sent = await flowSend(run, intentKey, { kind: "button_template", args: {
      accountId: run.account_id, conversationId: run.conversation_id!, text, buttons,
    } });
    await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "send_buttons", whatsapp_message_id: sent.whatsapp_message_id });
    await rememberPrompt(db, run, sent.whatsapp_message_id);
    return { outcome: "advanced", node_key: node.node_key };
  }
  const { whatsapp_message_id } = await flowSend(run, intentKey, { kind: "buttons", args: {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, ws),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars, ws),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars, ws),
    buttons: cfg.buttons.map((b) => ({
      id: b.reply_id,
      title: interpolateVars(b.title, run.vars, ws),
    })),
  } });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_buttons",
    whatsapp_message_id,
  });
  // Look up our internal message id so we can stash it on the run.
  // Cheap — indexed on `messages.message_id`.
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
  return { outcome: "advanced", node_key: node.node_key };
}

export async function sendListAndSuspend(
  db: AdminClient,
  run: FlowRunRow,
  node: FlowNodeRow,
): Promise<{ outcome: "advanced"; node_key: string }> {
  const cfg = node.config as unknown as SendListNodeConfig;
  // See sendButtonsAndSuspend — interpolate every visible string,
  // never the row `reply_id`.
  const ws = await textValues(run, JSON.stringify(cfg));
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, { kind: "list", args: {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    bodyText: interpolateVars(cfg.text, run.vars, ws),
    buttonLabel: interpolateVars(cfg.button_label, run.vars, ws),
    headerText: interpolateOptionalVars(cfg.header_text, run.vars, ws),
    footerText: interpolateOptionalVars(cfg.footer_text, run.vars, ws),
    sections: cfg.sections.map((s) => ({
      title: interpolateOptionalVars(s.title, run.vars, ws),
      rows: s.rows.map((r) => ({
        id: r.reply_id,
        title: interpolateVars(r.title, run.vars, ws),
        description: interpolateOptionalVars(r.description, run.vars, ws),
      })),
    })),
  } });
  await logEvent(db, run.id, "message_sent", node.node_key, {
    node_type: "send_list",
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
  return { outcome: "advanced", node_key: node.node_key };
}

/** Stashes the prompt's message row on the run so the inbox can quote what the customer answers. */
export async function rememberPrompt(db: AdminClient, run: FlowRunRow, providerMessageId: string): Promise<void> {
  const { data: msg } = await db.from("messages").select("id").eq("message_id", providerMessageId).maybeSingle();
  await db.from("flow_runs").update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null }).eq("id", run.id);
}

/**
 * A node's cards as Graph cards. Visible text is interpolated like every other
 * step; links and postback ids go out exactly as authored (a postback carries
 * its reply_id, which routes the tap).
 */
export function graphCards(cards: IgCard[], vars: Record<string, unknown>, ws: Record<string, string>,
  /** The URL each link or buy button goes out with, by `<card>:<button>`; null drops the button. Absent: as authored. */
  urls: ReadonlyMap<string, string | null> = new Map()): IgGenericCard[] {
  return cards.map((card, ci) => ({
    title: interpolateVars(card.title, vars, ws),
    ...(card.subtitle ? { subtitle: interpolateVars(card.subtitle, vars, ws) } : {}),
    ...(card.image_url ? { imageUrl: card.image_url } : {}),
    ...(card.default_url ? { defaultUrl: card.default_url } : {}),
    ...(card.buttons?.length ? {
      buttons: card.buttons.flatMap((b, bi): IgTemplateButton[] => {
        const url = urls.get(`${ci}:${bi}`);
        if (b.type === "buy") return url ? [{ type: "web_url", title: interpolateVars(b.title, vars, ws), url }] : [];
        if (b.type === "web_url") return url === null ? [] : [{ type: "web_url", title: interpolateVars(b.title, vars, ws), url: url ?? b.url }];
        return [{ type: "postback", title: interpolateVars(b.title, vars, ws), payload: b.reply_id }];
      }),
    } : {}),
  }));
}

/**
 * The URL each card button goes out with (Stage 5): a buy button gets its
 * checkout link (lib/flows/buy-button.ts; none: the button is dropped and an
 * event logged), and with track_clicks a link button gets its /r/<token>
 * (lib/flows/link-tracking.ts). Slots are `card:<i>:button:<j>`, stable per
 * run and step, so a re-send reuses the same link.
 */
export async function cardButtonUrls(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, cards: IgCard[]): Promise<Map<string, string | null>> {
  const urls = new Map<string, string | null>();
  const track = node.config.track_clicks === true;
  for (const [ci, card] of cards.entries()) {
    for (const [bi, button] of (card.buttons ?? []).entries()) {
      const slot = `card:${ci}:button:${bi}`;
      if (button.type === "buy") {
        const url = await buyButtonUrl(run, node.node_key, slot, button);
        if (!url) await logEvent(db, run.id, "error", node.node_key, { reason: "buy_button_unavailable", slot });
        urls.set(`${ci}:${bi}`, url);
      } else if (button.type === "web_url" && track) {
        urls.set(`${ci}:${bi}`, await trackedUrl(run, node.node_key, slot, button.url));
      }
    }
  }
  return urls;
}

/** Sends a send_card / send_gallery step (Instagram only) under the step's intent key. */
export async function sendCards(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<string> {
  const cards = nodeCards(node);
  const ws = await textValues(run, JSON.stringify(cards));
  const urls = await cardButtonUrls(db, run, node, cards);
  const { whatsapp_message_id } = await flowSend(run, `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, {
    kind: "cards", args: { accountId: run.account_id, conversationId: run.conversation_id!, cards: graphCards(cards, run.vars, ws, urls) },
  });
  await logEvent(db, run.id, "message_sent", node.node_key, { node_type: node.node_type, cards: cards.length, whatsapp_message_id });
  if (cardWaits(node)) await rememberPrompt(db, run, whatsapp_message_id);
  return whatsapp_message_id;
}

/**
 * An ig_private_reply step: the first message to the commenter, sent as the
 * comment's one private reply (private-reply.ts: 7-day window, hourly guard,
 * intent ig_private_reply:<comment id>). With an opt-in label the message
 * carries one quick reply whose payload names this run and step, and the run
 * waits for it (handleReplyForActiveRun); without one it moves on at once.
 * Held back by the hourly guard or a Meta throttle, the step waits
 * PRIVATE_REPLY_RETRY_MS and runs again (the intent key makes that safe). Any
 * other outcome ends the run with a reason; nothing here logs text.
 */
export async function runPrivateReplyStep(db: AdminClient, run: FlowRunRow, node: FlowNodeRow):
  Promise<{ next: string; outcome?: undefined } | { next: null; outcome: "advanced" | "completed" }> {
  const cfg = node.config as unknown as IgPrivateReplyNodeConfig;
  const eventId = commentEventOf(run);
  const fail = async (reason: string) => {
    await logEvent(db, run.id, "error", node.node_key, { reason });
    await endRun(db, run.id, "failed", reason);
    return { next: null, outcome: "completed" as const };
  };
  const ws = await textValues(run, JSON.stringify([cfg.text, cfg.opt_in_label ?? ""]));
  const label = cfg.opt_in_label?.trim() ? interpolateVars(cfg.opt_in_label, run.vars, ws).trim() : "";
  // Stage 5: a flow that also starts from a message (a keyword next to a comment
  // trigger) reaches this step without a comment. It then goes out as an
  // ordinary message through flowSend (the 24-hour window is re-checked there),
  // with the opening button as a quick reply, and waits for it the same way.
  if (!eventId) return sendPrivateReplyAsMessage(db, run, node, interpolateVars(cfg.text, run.vars, ws), label);
  let quickReplies: QuickReply[] | undefined;
  try {
    quickReplies = label ? [{ title: label, payload: encodePostback({ kind: "opt_in", runId: run.id, nodeKey: node.node_key }) }] : undefined;
  } catch {
    return fail("private_reply_invalid");
  }
  let outcome: string;
  try {
    outcome = await sendCommentPrivateReply({ accountId: run.account_id, eventId, runId: run.id, text: interpolateVars(cfg.text, run.vars, ws), quickReplies });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "private_reply_failed", detail: errorDetail(err) });
    await endRun(db, run.id, "failed", "private_reply_failed");
    return { next: null, outcome: "completed" };
  }
  if (outcome === "rate_limited" || outcome === "throttled") {
    await logEvent(db, run.id, "error", node.node_key, { reason: `private_reply_${outcome}` });
    const scheduled = await scheduleDelay(db, run, node, Math.round(PRIVATE_REPLY_RETRY_MS / 1000));
    return { next: null, outcome: scheduled === "failed" ? "completed" : "advanced" };
  }
  if (outcome !== "sent" && outcome !== "unknown") return fail(`private_reply_${outcome}`);
  // 'unknown' may have reached the commenter: never re-sent, and the run carries on as if it had.
  await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "ig_private_reply", outcome });
  if (!label) {
    if (cfg.next_node_key) return { next: cfg.next_node_key };
    await endRun(db, run.id, "completed", "end_node");
    return { next: null, outcome: "completed" };
  }
  if (!(await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key))) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
  } else {
    await scheduleReplyTimeout(db, run, node);
  }
  return { next: null, outcome: "advanced" };
}

/** An ig_private_reply step in a run that did not start from a comment (Stage 5): an ordinary message. */
export async function sendPrivateReplyAsMessage(db: AdminClient, run: FlowRunRow, node: FlowNodeRow, text: string, label: string):
  Promise<{ next: string; outcome?: undefined } | { next: null; outcome: "advanced" | "completed" }> {
  const cfg = node.config as unknown as IgPrivateReplyNodeConfig;
  const key = `flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`;
  const base = { accountId: run.account_id, userId: run.user_id, conversationId: run.conversation_id!, contactId: run.contact_id! };
  // An ordinary DM needs the 24-hour window (the advance loop does not check it for this step type).
  const open = run.conversation_id ? await withTenant({ accountId: run.account_id, role: "owner" },
    (tx) => instagramAutomatedWindowOpen(tx, run.account_id, run.conversation_id!), getWorkerPrisma()) : false;
  if (!open) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "window_closed", node_type: node.node_type });
    await endRun(db, run.id, "cancelled", "window_closed");
    return { next: null, outcome: "completed" };
  }
  try {
    const payload = label ? encodePostback({ kind: "opt_in", runId: run.id, nodeKey: node.node_key }) : "";
    const sent = label
      ? await flowSend(run, key, { kind: "buttons", args: { ...base, bodyText: text, buttons: [{ id: payload, title: label }] } })
      : await flowSend(run, key, { kind: "text", args: { ...base, text } });
    await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "ig_private_reply", as_message: true, whatsapp_message_id: sent.whatsapp_message_id });
  } catch (err) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "private_reply_message_failed", detail: errorDetail(err) });
    await endRun(db, run.id, "failed", "private_reply_message_failed");
    return { next: null, outcome: "completed" };
  }
  if (!label) {
    if (cfg.next_node_key) return { next: cfg.next_node_key };
    await endRun(db, run.id, "completed", "end_node");
    return { next: null, outcome: "completed" };
  }
  if (!(await advanceCurrentNodeKey(db, run, run.current_node_key, node.node_key))) {
    await logEvent(db, run.id, "error", node.node_key, { reason: "lost_race_during_advance" });
  } else {
    await scheduleReplyTimeout(db, run, node);
  }
  return { next: null, outcome: "advanced" };
}

/** The comment event a comment-started run answers (set by startCommentFlow), or null. */
export function commentEventOf(run: Pick<FlowRunRow, "vars">): string | null {
  const id = run.vars?.ig_comment_event_id;
  return typeof id === "string" && UUID_RE.test(id) ? id : null;
}

/**
 * Sends the node's template. Each quick reply carries its reply_id as
 * payload so the tap routes reliably. Meta rejects empty parameters, so
 * a value that interpolates to nothing is sent as "-".
 */
/**
 * WhatsApp-only sends (templates, appointment lists) refuse an Instagram run
 * BEFORE dispatchOnce, so no outbound intent is ever claimed for them. The main
 * loop already routes these node types away on Instagram; this also covers the
 * resume paths (a waiting appointment step answered later) that skip it.
 */
export async function assertWhatsAppRun(run: FlowRunRow): Promise<void> {
  if ((await runChannel(run)) === "instagram") throw new NoNumberError("other_channel");
}

export async function sendTemplateNode(db: AdminClient, run: FlowRunRow, node: FlowNodeRow): Promise<void> {
  await assertWhatsAppRun(run);
  const cfg = node.config as unknown as SendTemplateNodeConfig;
  const raw = cfg.body_params ?? [];
  const ws = await textValues(run, JSON.stringify([raw, cfg.card_params ?? [], cfg.coupon_code ?? ""]));
  const params = raw.map((p) => interpolateVars(p, run.vars, ws).trim() || "-");
  const buttonParams = Object.fromEntries((cfg.buttons ?? []).map((b) => [b.index, b.reply_id]));
  const { whatsapp_message_id } = await sendTemplateOnce(`flow:${run.id}:${node.node_key}:${run.transition_seq ?? 0}:${run.reprompt_count}`, {
    accountId: run.account_id,
    userId: run.user_id,
    conversationId: run.conversation_id!,
    contactId: run.contact_id!,
    templateName: cfg.template_name,
    language: cfg.language,
    params,
    messageParams: {
      body: params,
      buttonParams,
      ...flowTemplateSendExtras(cfg, (s) => interpolateVars(s, run.vars, ws)),
      flowTokens: await templateFormTokens(db, run, cfg),
    },
  });
  await logEvent(db, run.id, "message_sent", node.node_key, { node_type: "send_template", whatsapp_message_id });
  if (!templateWaits(node.config)) return;
  const { data: msg } = await db.from("messages").select("id").eq("message_id", whatsapp_message_id).maybeSingle();
  await db
    .from("flow_runs")
    .update({ last_prompt_message_id: (msg as { id: string } | null)?.id ?? null })
    .eq("id", run.id);
}

/**
 * Why the run's contact must not get a template (opted out or blocked), or
 * null. Read fresh each time: a STOP can arrive while the run waits.
 */
export function templateSuppression(db: AdminClient, run: FlowRunRow): Promise<string | null> {
  return templateConsentRefusal(db, run.account_id, run.contact_id);
}

/** Form sessions for the template's FLOW buttons, if it has any (see templateFlowTokens). */
export async function templateFormTokens(db: AdminClient, run: FlowRunRow, cfg: SendTemplateNodeConfig): Promise<Record<number, string> | undefined> {
  let query = db.from("message_templates").select("buttons").eq("account_id", run.account_id).eq("name", cfg.template_name);
  if (cfg.language) query = query.eq("language", cfg.language);
  const { data } = await query.limit(1);
  const buttons = (data as Array<{ buttons: Array<{ type: string; flow_id?: string }> | null }> | null)?.[0]?.buttons;
  return templateFlowTokens({ accountId: run.account_id, buttons, contactId: run.contact_id, conversationId: run.conversation_id, flowRunId: run.id });
}
