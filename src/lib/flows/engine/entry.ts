// Flow engine, entry group: moved out of engine.ts (batch 5) without changes; engine.ts re-exports the public names.
import { adClickMatch, byPrecedence, defaultReplyApplies, igAdClickMatch, isTestContact, isTestUsername, keywordTriggerMatches, orderReceivedMatch, outsideHoursApplies, refTriggerMatch, shareToStoryMatches, storyReplyMatches, templateReplyMatch, type InstagramInboundFacts } from "../triggers";
import { instagramConfig } from "@/lib/instagram/config";
import { decodePostback } from "@/lib/instagram/postback-payloads";
import { getWorkerPrisma } from "@/lib/db/prisma";
import { withTenant } from "@/lib/db/tenant";
import { readInboxSettings } from "@/lib/inbox/inbox-settings";
import { DEFAULT_INBOX_SETTINGS, type InboxSettings } from "@/lib/inbox/working-hours";
import { effectiveFlow, loadPublishedVersions, type EffectiveFlow, type FlowVersionRow } from "../versions";
import { effectiveTriggers } from "../flow-triggers";
import { intentMatches, type IntentCandidate } from "@/lib/ai/intent-match";
import { instagramAutomationAllowed } from "@/lib/contacts/channel-consent";
import { triggerAvailableOn, type Channel } from "@/lib/channels/capabilities";
import { type FlowRow, type ParsedInbound, type KeywordTriggerConfig, type TemplateReplyTriggerConfig, type AdClickTriggerConfig, type DefaultReplyTriggerConfig, type OutsideHoursTriggerConfig, type IgShareToStoryTriggerConfig, type IgStoryMentionTriggerConfig, type IgRefTriggerConfig, type IgStoryReplyTriggerConfig } from "../types";
import { entryTriggerTexts, messageText } from "./helpers";
import { type AdminClient, flowListensOnConversation, frequencyAllows, storedInstagramFacts } from "./run";

export async function findEntryFlow(
  db: AdminClient,
  accountId: string,
  conversationId: string,
  contactId: string,
  message: ParsedInbound,
  isFirstInbound: boolean,
  contactDigits: () => Promise<string>,
  /** Stage 5: the contact's stored Instagram username on this conversation (lowercase), for test-username drafts. */
  contactUsername: () => Promise<string> = async () => "",
  /** This message created the contact (contact_created triggers). */
  isNewContact = false,
): Promise<{ flow: EffectiveFlow; vars: Record<string, string>; version?: FlowVersionRow } | null> {
  // A tap used to be rejected outright here, on the reasoning that
  // interactive replies are responses to existing prompts. That holds
  // only while a prompt is outstanding — and this function runs solely
  // when the conversation has NO active run, so there is nothing the tap
  // could be answering. What it actually blocked was issue #490: an
  // *automation* sends the buttons, the customer taps one, and the flow
  // whose keyword matches that button never starts. Retyping the label
  // by hand worked, which is the tell — same words, different envelope.

  // The inbound's channel and number are its conversation's (one conversation
  // per contact and number, or per contact and Instagram account). Always read:
  // an Instagram conversation must never start a WhatsApp-only flow.
  const { data, error } = await db.from("conversations").select("channel, whatsapp_config_id, instagram_account_id")
    .eq("account_id", accountId).eq("id", conversationId).maybeSingle();
  if (error) return null;
  const row = data as { channel?: string | null; whatsapp_config_id?: string | null; instagram_account_id?: string | null } | null;
  const conversation = {
    channel: (row?.channel === "instagram" ? "instagram" : "whatsapp") as Channel,
    whatsappConfigId: row?.whatsapp_config_id ?? null,
  };
  const instagramAccountId = row?.instagram_account_id ?? null;
  // Stage 5: a contact unsubscribed on Instagram starts no flow there (5D's consent; the START keyword runs before this).
  if (conversation.channel === "instagram" && !(await instagramAutomationAllowed(accountId, contactId))) return null;

  // Instagram: one of our own postback codes (a conversation starter, opt-in
  // or follow-check tap that found no run to answer) offers only its title;
  // the code itself is not something the customer said. WhatsApp is unchanged.
  const ourPostback = conversation.channel === "instagram" && message.kind === "interactive_reply"
    && decodePostback(message.reply_id) !== null;
  const candidates = ourPostback && message.kind === "interactive_reply"
    ? [message.reply_title].filter((v) => Boolean(v && v.trim()))
    : entryTriggerTexts(message);

  // Active flows, plus drafts being tested (only those with test numbers, or
  // on Instagram test usernames, are fetched); both sets are small. A testing
  // draft runs its own row, so only the conversation channel's drafts and
  // legacy 'any' ones are read (Stage 1). An active flow runs its published
  // version, whose scope can differ from the row's (a draft moved before
  // Stage 1 locked published scopes), so the active query is not narrowed by
  // the row's scope: flowListensOnConversation below decides on the scope each
  // flow runs on.
  const scopes = [conversation.channel, "any"];
  const instagram = conversation.channel === "instagram";
  const [active, drafts, usernameDrafts] = await Promise.all([
    db.from("flows").select("*").eq("account_id", accountId).eq("status", "active").order("created_at", { ascending: true }),
    db.from("flows").select("*").eq("account_id", accountId).eq("status", "draft").neq("test_numbers", []).in("channel_scope", scopes).order("created_at", { ascending: true }),
    // Stage 5: an Instagram draft runs for its test usernames.
    instagram
      ? db.from("flows").select("*").eq("account_id", accountId).eq("status", "draft").neq("test_usernames", []).in("channel_scope", scopes).order("created_at", { ascending: true })
      : Promise.resolve({ data: [] as FlowRow[], error: null }),
  ]);
  if (active.error || drafts.error || usernameDrafts.error) return null;
  const draftRows = new Map<string, FlowRow>();
  for (const f of [...((drafts.data ?? []) as FlowRow[]), ...((usernameDrafts.data ?? []) as FlowRow[])]) draftRows.set(f.id, f);
  const testing = [...draftRows.values()].filter((f) => f.status === "draft"
    && ((f.test_numbers ?? []).length > 0 || (instagram && (f.test_usernames ?? []).length > 0)));
  const digits = testing.some((f) => (f.test_numbers ?? []).length > 0) ? await contactDigits() : "";
  const username = instagram && testing.some((f) => (f.test_usernames ?? []).length > 0) ? await contactUsername() : "";
  // An active flow matches on its published version (Phase 12); one not yet
  // versioned (deploy-window straggler) matches on its draft, as before.
  const live = ((active.data ?? []) as FlowRow[]).filter((f) => f.status === "active");
  const versionIds = live.map((f) => f.published_version_id).filter((id): id is string => Boolean(id));
  const versions = versionIds.length ? await loadPublishedVersions(accountId, versionIds) : new Map<string, FlowVersionRow>();
  const versionOf = new Map<string, FlowVersionRow>();
  const liveFlows: EffectiveFlow[] = [];
  for (const f of live) {
    if (!f.published_version_id) {
      console.warn("[flows] unversioned active flow", { flowId: f.id });
      liveFlows.push(f);
      continue;
    }
    const version = versions.get(f.published_version_id);
    if (!version || version.flow_id !== f.id) continue;
    versionOf.set(f.id, version);
    liveFlows.push(effectiveFlow(f, version));
  }
  const candidatesByStatus: EffectiveFlow[] = [
    ...liveFlows,
    ...testing.filter((f) => isTestContact(f, digits) || isTestUsername(f, username)),
  ];
  if (!candidatesByStatus.length) return null;
  // Stage 5: a flow listens on its primary trigger and each of its extra
  // triggers (effectiveTriggers; Instagram flows only). Every trigger is
  // ordered by its own tier, so a flow's story-reply trigger still outranks
  // another flow's keyword. Without extra triggers this is exactly the
  // per-flow order of byPrecedence, as before.
  const typed = byPrecedence(candidatesByStatus.filter((f) => flowListensOnConversation(f, conversation)).flatMap((flow) =>
    effectiveTriggers(flow)
      .filter((trigger, i) => i === 0 || triggerAvailableOn(trigger.trigger_type, conversation.channel))
      .map((trigger) => ({ flow, trigger, trigger_type: trigger.trigger_type, created_at: flow.created_at, status: flow.status }))));
  const found = (flow: EffectiveFlow, vars: Record<string, string>) => ({ flow, vars, version: versionOf.get(flow.id) });
  // Story replies and mentions, and (Stage 3) the ref link or ad a chat was opened from, are read from the stored message (Instagram only).
  const needsFacts = instagram &&
    typed.some((p) => p.trigger_type === "ig_story_reply" || p.trigger_type === "ig_story_mention" || p.trigger_type === "default_reply"
      || p.trigger_type === "ig_ref" || p.trigger_type === "ad_click" || p.trigger_type === "ig_share_to_story");
  const storedFacts: InstagramInboundFacts = needsFacts ? await storedInstagramFacts(db, accountId, conversationId, message.meta_message_id) : {};
  // Flag off: a share to story is treated as any other unrecognised attachment (the default reply still applies), exactly as before Stage 4.
  const igFacts: InstagramInboundFacts = storedFacts.shareToStory && !instagramConfig()?.shareToStoryEnabled
    ? { ...storedFacts, shareToStory: undefined } : storedFacts;
  // The workspace's working hours, read at most once and only for an outside_hours trigger.
  // A failed read counts as open: an away flow then stays quiet rather than firing by mistake.
  let hours: Promise<Pick<InboxSettings, "timezone" | "working_hours">> | undefined;
  const workingHours = () => (hours ??= withTenant({ accountId, role: "owner" }, (tx) => readInboxSettings(tx, accountId), getWorkerPrisma())
    .catch(() => {
      console.error("[flows] working hours lookup failed", { accountId });
      return DEFAULT_INBOX_SETTINGS;
    }));
  // Stage 5: keyword triggers matched by meaning wait until every exact trigger
  // failed, and are asked once (one AI call for all of them) before default_reply.
  const intents: Array<{ flow: EffectiveFlow; candidate: IntentCandidate }> = [];
  let intentsAsked = false;
  const askIntents = async (): Promise<{ flow: EffectiveFlow; vars: Record<string, string>; version?: FlowVersionRow } | null> => {
    if (intentsAsked || !intents.length) return null;
    intentsAsked = true;
    const text = message.kind === "text" && !ourPostback ? message.text.trim() : "";
    if (!text) return null;
    let flowId: string | null = null;
    try {
      flowId = await intentMatches(accountId, message.meta_message_id, text, intents.map((i) => i.candidate));
    } catch {
      // No match on any failure: the default reply still applies. Never the text.
      console.error("[flows] intent match failed", { accountId });
    }
    const hit = flowId ? intents.find((i) => i.flow.id === flowId) : undefined;
    return hit ? found(hit.flow, {}) : null;
  };
  for (const { flow, trigger } of typed) {
    const config = trigger.config as unknown;
    if (trigger.trigger_type === "ig_story_reply") {
      if (storyReplyMatches(igFacts, messageText(message), config as IgStoryReplyTriggerConfig)) return found(flow, {});
    } else if (trigger.trigger_type === "ig_story_mention") {
      const cfg = config as IgStoryMentionTriggerConfig;
      if (igFacts.storyMention && await frequencyAllows(db, accountId, flow.id, contactId, cfg?.frequency)) return found(flow, {});
    } else if (trigger.trigger_type === "ig_share_to_story") {
      // Stage 4: dark until a live capture shows Meta delivers the event (the flag; a flow stored while it is off never fires).
      const cfg = config as IgShareToStoryTriggerConfig;
      if (instagramConfig()?.shareToStoryEnabled && shareToStoryMatches(igFacts, cfg, instagramAccountId)
        && await frequencyAllows(db, accountId, flow.id, contactId, cfg?.frequency)) return found(flow, {});
    } else if (trigger.trigger_type === "default_reply") {
      // Lowest tier (triggers.ts): reached only when no other flow matched (and no intent).
      const meant = await askIntents();
      if (meant) return meant;
      const cfg = config as DefaultReplyTriggerConfig;
      if (defaultReplyApplies(message, igFacts, ourPostback) && await frequencyAllows(db, accountId, flow.id, contactId, cfg?.frequency)) {
        return found(flow, {});
      }
    } else if (trigger.trigger_type === "contact_created") {
      // The message that created the contact (above first_inbound_message, triggers.ts).
      if (isNewContact) return found(flow, {});
    } else if (trigger.trigger_type === "outside_hours") {
      // Between first_inbound_message and default_reply: a keyword meant by intent still wins.
      const meant = await askIntents();
      if (meant) return meant;
      const cfg = config as OutsideHoursTriggerConfig;
      if (outsideHoursApplies(message, await workingHours(), ourPostback)
        && await frequencyAllows(db, accountId, flow.id, contactId, cfg?.frequency)) return found(flow, {});
    } else if (trigger.trigger_type === "order_received") {
      const vars = orderReceivedMatch(message);
      if (vars) return found(flow, vars);
    } else if (trigger.trigger_type === "ig_ref") {
      // A chat opened from a ref link (Instagram only: flowListensOnConversation keeps it off WhatsApp).
      const vars = refTriggerMatch(igFacts, config as IgRefTriggerConfig, instagramAccountId);
      if (vars) return found(flow, vars);
    } else if (trigger.trigger_type === "ad_click") {
      // Only a click-to-WhatsApp ad (not a boosted post), or on Instagram a
      // click-to-Direct ad; an active run already took the message before
      // this point (no preemption).
      const cfg = config as AdClickTriggerConfig;
      const vars = instagram ? igAdClickMatch(igFacts, cfg) : adClickMatch(message, cfg);
      if (vars) return found(flow, vars);
    } else if (trigger.trigger_type === "template_reply") {
      const vars = templateReplyMatch(message, config as TemplateReplyTriggerConfig);
      if (vars) return found(flow, vars);
    } else if (trigger.trigger_type === "keyword") {
      const cfg = config as KeywordTriggerConfig;
      if (cfg?.match_type === "intent") {
        if (typeof cfg.intent === "string" && cfg.intent.trim()) intents.push({ flow, candidate: { flowId: flow.id, intent: cfg.intent.trim() } });
        continue;
      }
      for (const text of candidates) {
        if (await keywordTriggerMatches(text, cfg)) return found(flow, {});
      }
    } else if (trigger.trigger_type === "first_inbound_message" && isFirstInbound) {
      // Also reachable by a tap now: a broadcast template with a
      // quick-reply button can genuinely be what prompts a contact's
      // first-ever inbound. The automations dispatcher has always
      // treated a tap that way (the webhook pushes
      // `first_inbound_message` regardless of envelope) — flows were
      // the inconsistent half.
      return found(flow, {});
    }
    // 'manual' triggers do not auto-start from inbound messages; comment triggers start from comments;
    // tag_added starts from the tag writer (startTagAddedFlows).
  }
  return askIntents();
}

// ============================================================
// Node executors — each handles ONE node type. send_buttons and
// send_list also persist `last_prompt_message_id` so the inbox
// thread can quote the prompt the customer is replying to.
// ============================================================
