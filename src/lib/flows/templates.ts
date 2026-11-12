/**
 * Starter flow templates.
 *
 * Pre-canned flows, grouped by industry, that users can clone with one
 * click instead of building from scratch. Each template is a plain JS object describing
 * the same shape `/api/flows` PUT accepts — name, trigger config,
 * entry_node_id, fallback_policy, nodes[] — keyed by a stable
 * `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  ActionsNodeConfig,
  AiReplyNodeConfig,
  CanvasNote,
  FlowTemplateMeta,
  IgLiveCommentTriggerConfig,
  RandomizerNodeConfig,
  SmartDelayNodeConfig,
  BookAppointmentNodeConfig,
  AskAddressNodeConfig,
  AskLocationNodeConfig,
  AskMediaNodeConfig,
  CollectInputNodeConfig,
  ConditionNodeConfig,
  DefaultReplyTriggerConfig,
  FlowTriggerType,
  HandoffNodeConfig,
  IgCommentTriggerConfig,
  IgPrivateReplyNodeConfig,
  IgStoryMentionTriggerConfig,
  IgStoryReplyTriggerConfig,
  KeywordTriggerConfig,
  PaymentLinkNodeConfig,
  SendButtonsNodeConfig,
  SendCardNodeConfig,
  SendGalleryNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  SendStorefrontLinkNodeConfig,
  SetAttributeNodeConfig,
  StartNodeConfig,
} from "./types";
import { getT } from "@/lib/i18n/translate";
import { CHANNELS, nodeAvailableOn, triggerAvailableOn } from "@/lib/channels/capabilities";
import type { Channel } from "@/types";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "set_attribute"
  | "ask_media"
  | "ask_location"
  | "ask_address"
  | "book_appointment"
  | "send_storefront_link"
  | "payment_link"
  | "handoff"
  | "end"
  // Instagram-only steps (Stage 2): the Instagram starters use them.
  | "ig_private_reply"
  | "send_card"
  | "send_gallery"
  // Stage 5 (5F): the newer Instagram starters use these.
  | "ai_reply"
  | "actions"
  | "randomizer"
  | "smart_delay";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | CollectInputNodeConfig
    | ConditionNodeConfig
    | HandoffNodeConfig
    | SetAttributeNodeConfig
    | AskMediaNodeConfig
    | AskLocationNodeConfig
    | AskAddressNodeConfig
    | BookAppointmentNodeConfig
    | SendStorefrontLinkNodeConfig
    | PaymentLinkNodeConfig
    | IgPrivateReplyNodeConfig
    | SendCardNodeConfig
    | SendGalleryNodeConfig
    | AiReplyNodeConfig
    | ActionsNodeConfig
    | RandomizerNodeConfig
    | SmartDelayNodeConfig
    | Record<string, unknown>;
}

/** Gallery groups, in display order. */
export const FLOW_TEMPLATE_CATEGORIES = [
  "general",
  "journeys",
  "retail",
  "food",
  "health",
  "education",
  "real_estate",
  "travel",
  "finance",
  "beauty",
  "events",
  "services",
  // Instagram starters (Stage 2, Instagram › Quick automations).
  "instagram_comments",
  "instagram_growth",
  "instagram_stories",
  "instagram_dms",
] as const;
export type FlowTemplateCategory = (typeof FLOW_TEMPLATE_CATEGORIES)[number];

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  category: FlowTemplateCategory;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: string;
  trigger_type: FlowTriggerType;
  trigger_config:
    | KeywordTriggerConfig
    | IgCommentTriggerConfig
    | IgStoryReplyTriggerConfig
    | IgStoryMentionTriggerConfig
    | DefaultReplyTriggerConfig
    | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
  /**
   * The channel sections this template is offered in (Stage 1), first one the
   * default when a create names none. Absent: every channel whose palette
   * holds the trigger and every step (flowTemplateChannels).
   */
  channels?: readonly Channel[];
  /** Stage 5: what the gallery's filters and detail view show (Instagram starters). */
  meta?: FlowTemplateMeta;
  /** Stage 5: the detail view's "Why it helps" and "How it works" paragraphs. */
  business_value?: string;
  how_it_works?: string;
  /** Stage 5: sticky notes copied onto the new flow's canvas (never run). */
  canvas_notes?: CanvasNote[];
}

/**
 * The channels a template can be created on: its own `channels`, else every
 * channel that offers its trigger and can run each of its steps as written.
 * A WhatsApp-only step (a list, a booking) keeps a template off Instagram.
 */
export function flowTemplateChannels(template: FlowTemplate): Channel[] {
  if (template.channels) return [...template.channels];
  return CHANNELS.filter((channel) => triggerAvailableOn(template.trigger_type, channel) &&
    template.nodes.every((node) => nodeAvailableOn(node.node_type, channel, node.config as Record<string, unknown>).ok));
}

const t = getT("StarterFlows");

/** Comma-separated keyword list from the catalogue → trimmed array. */
function keywords(key: string): string[] {
  return t(key)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: t("welcome_menu.name"),
  description: t("welcome_menu.description"),
  category: "general",
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: { keywords: keywords("welcome_menu.keywords"), match_type: "contains" },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: t("welcome_menu.text"),
        footer_text: t("welcome_menu.footer"),
        buttons: [
          {
            reply_id: "existing",
            title: t("welcome_menu.existingButton"),
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: t("welcome_menu.newButton"),
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        note: t("welcome_menu.existingNote"),
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        note: t("welcome_menu.newNote"),
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: t("faq_bot.name"),
  description: t("faq_bot.description"),
  category: "general",
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: keywords("faq_bot.keywords"),
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: t("faq_bot.text"),
        button_label: t("faq_bot.buttonLabel"),
        sections: [
          {
            title: t("faq_bot.commonSection"),
            rows: [
              {
                reply_id: "hours",
                title: t("faq_bot.hoursRow"),
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: t("faq_bot.pricingRow"),
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: t("faq_bot.refundsRow"),
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: t("faq_bot.otherSection"),
            rows: [
              {
                reply_id: "human",
                title: t("faq_bot.humanRow"),
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: t("faq_bot.hoursAnswer"),
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: t("faq_bot.pricingAnswer"),
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: t("faq_bot.refundsAnswer"),
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: t("faq_bot.humanNote"),
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: t("lead_capture.name"),
  description: t("lead_capture.description"),
  category: "general",
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: t("lead_capture.intro"),
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: t("lead_capture.askName"),
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: t("lead_capture.askEmail", { name: "{{vars.name}}" }),
        var_key: "email",
        validation: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: t("lead_capture.askCompany"),
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: t("lead_capture.handoffNote", {
          name: "{{vars.name}}",
          email: "{{vars.email}}",
          company: "{{vars.company}}",
        }),
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// Industry gallery — built from small node helpers. Each template
// uses only node types that need no workspace data (no tags,
// templates, agents, other flows or API endpoints), so a clone passes
// activation validation as-is.
// ============================================================

type Option = [reply_id: string, title: string, next_node_key: string];
type Row = [reply_id: string, title: string, next_node_key: string, description?: string];

const node = (
  node_key: string,
  node_type: FlowTemplateNodeType,
  config: FlowTemplateNode["config"],
): FlowTemplateNode => ({ node_key, node_type, config });
const startAt = (next: string) => node("start", "start", { next_node_key: next });
const say = (key: string, text: string, next: string) =>
  node(key, "send_message", { text, next_node_key: next } as SendMessageNodeConfig);
const buttons = (key: string, text: string, options: Option[]) =>
  node(key, "send_buttons", {
    text,
    buttons: options.map(([reply_id, title, next_node_key]) => ({ reply_id, title, next_node_key })),
  } as SendButtonsNodeConfig);
const list = (key: string, text: string, button_label: string, rows: Row[]) =>
  node(key, "send_list", {
    text,
    button_label,
    sections: [
      {
        rows: rows.map(([reply_id, title, next_node_key, description]) => ({
          reply_id,
          title,
          next_node_key,
          ...(description ? { description } : {}),
        })),
      },
    ],
  } as SendListNodeConfig);
const ask = (
  key: string,
  prompt_text: string,
  var_key: string,
  next_node_key: string,
  extra: Partial<CollectInputNodeConfig> = {},
) => node(key, "collect_input", { prompt_text, var_key, next_node_key, ...extra } as CollectInputNodeConfig);
const askOther = (
  type: "ask_media" | "ask_location" | "ask_address",
  key: string,
  prompt_text: string,
  var_key: string,
  next_node_key: string,
  extra: Partial<AskMediaNodeConfig> = {},
) => node(key, type, { prompt_text, var_key, next_node_key, ...extra });
const setVar = (key: string, varKey: string, value: string, next: string) =>
  node(key, "set_attribute", { target: "var", key: varKey, value, next_node_key: next } as SetAttributeNodeConfig);
const setContact = (key: string, field: "name" | "email", value: string, next: string) =>
  node(key, "set_attribute", { target: "contact_field", key: field, value, next_node_key: next } as SetAttributeNodeConfig);
const handoff = (key: string, note: string) => node(key, "handoff", { note } as HandoffNodeConfig);
/**
 * Offers the workspace's free times and books one. No service ids, so the
 * template works in any workspace: every bookable service is offered, and
 * with appointments not set up the step takes its unavailable port.
 */
const book = (key: string, ports: { success: string; unavailable: string; cancelled: string }, extra: Partial<BookAppointmentNodeConfig> = {}) =>
  node(key, "book_appointment", {
    staff_mode: "any",
    ...extra,
    success_next: ports.success,
    unavailable_next: ports.unavailable,
    cancelled_next: ports.cancelled,
  } as BookAppointmentNodeConfig);
const END = node("end", "end", {});
const v = (key: string) => `{{vars.${key}}}`;

/**
 * Buttons / list rows that record which option was tapped: each option
 * routes through a set_attribute node that stores its own title in
 * `varKey`, then continues to `next`.
 */
function choices(varKey: string, next: string, items: Array<[id: string, title: string, description?: string]>) {
  return {
    options: items.map(([id, title]): Option => [id, title, `${varKey}_${id}`]),
    rows: items.map(([id, title, description]): Row => [id, title, `${varKey}_${id}`, description]),
    nodes: items.map(([id, title]) => setVar(`${varKey}_${id}`, varKey, title, next)),
  };
}

function template(
  slug: string,
  category: FlowTemplateCategory,
  icon: string,
  trigger: "keyword" | "first_inbound_message" | "manual",
  nodes: FlowTemplateNode[],
): FlowTemplate {
  return {
    slug,
    name: t(`${slug}.name`),
    description: t(`${slug}.description`),
    category,
    icon,
    trigger_type: trigger,
    trigger_config:
      trigger === "keyword" ? { keywords: keywords(`${slug}.keywords`), match_type: "contains" } : {},
    entry_node_id: "start",
    nodes,
  };
}

/** `t` scoped to one template's keys. */
const scoped = (slug: string) => (key: string, values?: Record<string, string>) => t(`${slug}.${key}`, values);

// ---- general ----

// The answer only lives in a run variable: no standard contact field holds
// consent, and contact_field cannot set opted_out_at. Marketing consent is
// the built-in STOP/START keyword handling (src/lib/contacts/consent.ts), so
// the copy points customers there and the trigger keywords avoid those words.
function optIn(): FlowTemplate {
  const s = scoped("opt_in_confirmation");
  return template("opt_in_confirmation", "general", "BellRing", "keyword", [
    startAt("ask"),
    buttons("ask", s("text"), [
      ["yes", s("yesButton"), "consent"],
      ["no", s("noButton"), "declined"],
    ]),
    setVar("consent", "whatsapp_opt_in", "yes", "confirmed"),
    say("confirmed", s("confirmed"), "end"),
    say("declined", s("declined"), "end"),
    END,
  ]);
}

// ---- retail ----

function orderStatus(): FlowTemplate {
  const s = scoped("order_status");
  const request = choices("request", "ask_order", [
    ["track", s("trackButton")],
    ["address", s("addressButton")],
    ["cancel", s("cancelButton")],
  ]);
  return template("order_status", "retail", "Package", "keyword", [
    startAt("menu"),
    buttons("menu", s("text"), request.options),
    ...request.nodes,
    ask("ask_order", s("askOrder"), "order_number", "ack", {
      validation: "regex",
      regex: "#?[A-Za-z0-9-]{3,24}",
      max_attempts: 3,
      error_text: s("orderError"),
      exhausted_next: "agent",
    }),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", { order: v("order_number"), request: v("request") })),
  ]);
}

function cartRecovery(): FlowTemplate {
  const s = scoped("cart_recovery");
  return template("cart_recovery", "retail", "ShoppingCart", "keyword", [
    startAt("menu"),
    buttons("menu", s("text"), [
      ["complete", s("completeButton"), "complete"],
      ["question", s("questionButton"), "ask_question"],
      ["payment", s("paymentButton"), "payment_agent"],
    ]),
    say("complete", s("completeReply"), "end"),
    ask("ask_question", s("askQuestion"), "question", "question_agent"),
    handoff("question_agent", s("questionNote", { question: v("question") })),
    handoff("payment_agent", s("paymentNote")),
    END,
  ]);
}

function returnRequest(): FlowTemplate {
  const s = scoped("return_request");
  const reason = choices("reason", "ask_photo", [
    ["damaged", s("damagedButton")],
    ["wrong", s("wrongButton")],
    ["other", s("otherButton")],
  ]);
  return template("return_request", "retail", "RotateCcw", "keyword", [
    startAt("ask_order"),
    ask("ask_order", s("askOrder"), "order_number", "reason", {
      validation: "regex",
      regex: "#?[A-Za-z0-9-]{3,24}",
      max_attempts: 3,
      error_text: s("orderError"),
    }),
    buttons("reason", s("reasonText"), reason.options),
    ...reason.nodes,
    askOther("ask_media", "ask_photo", s("askPhoto"), "photo", "ack", {
      media_types: ["image", "video"],
      skip_label: s("skipPhoto"),
      skip_next: "ack",
      max_attempts: 2,
      exhausted_next: "ack",
    }),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", { order: v("order_number"), reason: v("reason"), photo: v("photo") })),
  ]);
}

function storeLocator(): FlowTemplate {
  const s = scoped("store_locator");
  return template("store_locator", "retail", "MapPin", "keyword", [
    startAt("ask_location"),
    askOther("ask_location", "ask_location", s("askLocation"), "location", "ack", {
      max_attempts: 2,
      exhausted_next: "ask_city",
    }),
    ask("ask_city", s("askCity"), "city", "ack"),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", { location: v("location"), city: v("city") })),
  ]);
}

// ---- food ----

function tableBooking(): FlowTemplate {
  const s = scoped("table_booking");
  const slot = choices("slot", "ask_name", [
    ["lunch", s("lunchRow")],
    ["early", s("earlyRow")],
    ["late", s("lateRow")],
  ]);
  const details = { guests: v("guests"), date: v("date"), slot: v("slot"), name: v("guest_name") };
  return template("table_booking", "food", "UtensilsCrossed", "keyword", [
    startAt("ask_guests"),
    ask("ask_guests", s("askGuests"), "guests", "ask_date", {
      validation: "number", min: 1, max: 20, max_attempts: 3, error_text: s("guestsError"),
    }),
    ask("ask_date", s("askDate"), "date", "slot", { validation: "date", max_attempts: 3, error_text: s("dateError") }),
    list("slot", s("slotText"), s("slotButton"), slot.rows),
    ...slot.nodes,
    ask("ask_name", s("askName"), "guest_name", "save_name"),
    setContact("save_name", "name", v("guest_name"), "confirm"),
    say("confirm", s("confirm", details), "agent"),
    handoff("agent", s("handoffNote", details)),
  ]);
}

function foodOrder(): FlowTemplate {
  const s = scoped("food_order");
  return template("food_order", "food", "ChefHat", "keyword", [
    startAt("topics"),
    list("topics", s("text"), s("buttonLabel"), [
      ["menu", s("menuRow"), "answer_menu"],
      ["hours", s("hoursRow"), "answer_hours"],
      ["order", s("orderRow"), "ask_address", s("orderDesc")],
      ["human", s("humanRow"), "human_agent"],
    ]),
    say("answer_menu", s("menuAnswer"), "end"),
    say("answer_hours", s("hoursAnswer"), "end"),
    askOther("ask_address", "ask_address", s("askAddress"), "address", "ask_items"),
    ask("ask_items", s("askItems"), "items", "ack"),
    say("ack", s("ack"), "order_agent"),
    handoff("order_agent", s("orderNote", { address: v("address"), items: v("items") })),
    handoff("human_agent", s("humanNote")),
    END,
  ]);
}

// ---- health ----

function clinicAppointment(): FlowTemplate {
  const s = scoped("clinic_appointment");
  const department = choices("department", "ask_name", [
    ["general", s("generalRow")],
    ["children", s("childrenRow")],
    ["dental", s("dentalRow")],
    ["skin", s("skinRow")],
  ]);
  const time = choices("time", "ack", [
    ["morning", s("morningButton")],
    ["afternoon", s("afternoonButton")],
    ["evening", s("eveningButton")],
  ]);
  // Books a real time when the workspace has appointments set up; otherwise
  // (or when nothing is free) the request goes to the front desk as before.
  return template("clinic_appointment", "health", "CalendarCheck", "keyword", [
    startAt("book"),
    book("book", { success: "end", unavailable: "department", cancelled: "end" }),
    list("department", s("text"), s("buttonLabel"), department.rows),
    ...department.nodes,
    ask("ask_name", s("askName"), "patient_name", "save_name"),
    setContact("save_name", "name", v("patient_name"), "ask_date"),
    ask("ask_date", s("askDate"), "date", "time", { validation: "date", max_attempts: 3, error_text: s("dateError") }),
    buttons("time", s("timeText"), time.options),
    ...time.nodes,
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", {
      department: v("department"), name: v("patient_name"), date: v("date"), time: v("time"),
    })),
    END,
  ]);
}

/**
 * Journey J2: online or in-person free consultation. The customer picks the
 * mode and registers (name, city, state); the booking step then offers only
 * services of that mode. A Monday-only rule is the service's own setting.
 */
function freeConsultation(): FlowTemplate {
  const s = scoped("free_consultation");
  const ports = { success: "end", unavailable: "agent", cancelled: "end" };
  return template("free_consultation", "journeys", "CalendarDays", "keyword", [
    startAt("mode"),
    buttons("mode", s("text"), [
      ["online", s("onlineButton"), "set_online"],
      ["offline", s("offlineButton"), "set_offline"],
    ]),
    setVar("set_online", "consult_mode", "online", "ask_name"),
    setVar("set_offline", "consult_mode", "offline", "ask_name"),
    ask("ask_name", s("askName"), "client_name", "save_name"),
    setContact("save_name", "name", v("client_name"), "ask_city"),
    ask("ask_city", s("askCity"), "city", "ask_state"),
    ask("ask_state", s("askState"), "state", "which_mode"),
    node("which_mode", "condition", {
      subject: "var", subject_key: "consult_mode", operator: "equals", value: "online", true_next: "book_online", false_next: "book_offline",
    } as ConditionNodeConfig),
    book("book_online", ports, { service_mode: "online" }),
    book("book_offline", ports, { service_mode: "offline" }),
    handoff("agent", s("handoffNote", { name: v("client_name"), city: v("city"), state: v("state"), mode: v("consult_mode") })),
    END,
  ]);
}

/**
 * J4 Ayurvedic store (Phase 8): a four-row menu. Shop and My orders send a
 * secure storefront link bound to this contact (send_storefront_link; the
 * store or status page, never a saved profile); when the store is off or
 * the contact has no order the step takes its failed port. Consult books a
 * free service (flow bookings never take paid services). Talk to us hands
 * over. A WA-02 welcome menu reaches it through its Ayurvedic option (a
 * connect_flow step in the workspace's own menu), so it never replaces those
 * journeys.
 */
function ayurvedicStore(): FlowTemplate {
  const s = scoped("ayurvedic_store");
  const link = (key: string, purpose: "shop" | "status", message: string, failed: string) =>
    node(key, "send_storefront_link", {
      message, purpose, ttl_hours: 24, next_node_key: "end", failed_next: failed,
    } as SendStorefrontLinkNodeConfig);
  return template("ayurvedic_store", "journeys", "Leaf", "keyword", [
    startAt("menu"),
    list("menu", s("text"), s("buttonLabel"), [
      ["shop", s("shopRow"), "shop", s("shopDescription")],
      ["consult", s("consultRow"), "consult", s("consultDescription")],
      ["orders", s("ordersRow"), "orders", s("ordersDescription")],
      ["talk", s("talkRow"), "agent", s("talkDescription")],
    ]),
    link("shop", "shop", s("shopMessage"), "shop_offline"),
    say("shop_offline", s("shopOffline"), "agent"),
    book("consult", { success: "end", unavailable: "agent", cancelled: "end" }),
    link("orders", "status", s("ordersMessage"), "no_orders"),
    say("no_orders", s("noOrders"), "end"),
    handoff("agent", s("handoffNote")),
    END,
  ]);
}

function clinicTriage(): FlowTemplate {
  const s = scoped("clinic_triage");
  return template("clinic_triage", "health", "Stethoscope", "keyword", [
    startAt("disclaimer"),
    say("disclaimer", s("disclaimer"), "menu"),
    buttons("menu", s("text"), [
      ["urgent", s("urgentButton"), "urgent_agent"],
      ["routine", s("routineButton"), "ask_symptoms"],
      ["refill", s("refillButton"), "ask_prescription"],
    ]),
    handoff("urgent_agent", s("urgentNote")),
    ask("ask_symptoms", s("askSymptoms"), "symptoms", "ask_days"),
    ask("ask_days", s("askDays"), "days", "routine_ack", {
      validation: "number", min: 0, max: 365, max_attempts: 3, error_text: s("daysError"),
    }),
    say("routine_ack", s("routineAck"), "routine_agent"),
    handoff("routine_agent", s("routineNote", { symptoms: v("symptoms"), days: v("days") })),
    askOther("ask_media", "ask_prescription", s("askPrescription"), "prescription", "refill_ack", {
      media_types: ["image", "document"],
      skip_label: s("skipPrescription"),
      skip_next: "refill_ack",
    }),
    say("refill_ack", s("refillAck"), "refill_agent"),
    handoff("refill_agent", s("refillNote", { file: v("prescription") })),
  ]);
}

// ---- education ----

function courseEnquiry(): FlowTemplate {
  const s = scoped("course_enquiry");
  const course = choices("course", "ask_name", [
    ["tech", s("techRow")],
    ["design", s("designRow")],
    ["data", s("dataRow")],
    ["languages", s("languagesRow")],
    ["business", s("businessRow")],
  ]);
  const mode = choices("mode", "ack", [
    ["online", s("onlineButton")],
    ["campus", s("campusButton")],
    ["either", s("eitherButton")],
  ]);
  return template("course_enquiry", "education", "GraduationCap", "keyword", [
    startAt("course"),
    list("course", s("text"), s("buttonLabel"), course.rows),
    ...course.nodes,
    ask("ask_name", s("askName"), "student_name", "save_name"),
    setContact("save_name", "name", v("student_name"), "ask_email"),
    ask("ask_email", s("askEmail"), "email", "save_email", {
      validation: "email", max_attempts: 3, error_text: s("emailError"), skip_label: s("skipEmail"), skip_next: "mode",
    }),
    setContact("save_email", "email", v("email"), "mode"),
    buttons("mode", s("modeText"), mode.options),
    ...mode.nodes,
    say("ack", s("ack", { name: v("student_name") }), "agent"),
    handoff("agent", s("handoffNote", {
      course: v("course"), mode: v("mode"), name: v("student_name"), email: v("email"),
    })),
  ]);
}

function admissionEnquiry(): FlowTemplate {
  const s = scoped("admission_enquiry");
  const details = { student: v("student"), programme: v("programme"), age: v("age"), phone: v("guardian_phone") };
  return template("admission_enquiry", "education", "School", "keyword", [
    startAt("intro"),
    say("intro", s("intro"), "ask_student"),
    ask("ask_student", s("askStudent"), "student", "ask_programme"),
    ask("ask_programme", s("askProgramme"), "programme", "ask_age"),
    ask("ask_age", s("askAge"), "age", "ask_phone", {
      validation: "number", min: 2, max: 60, max_attempts: 3, error_text: s("ageError"),
    }),
    ask("ask_phone", s("askPhone"), "guardian_phone", "tour", {
      validation: "phone", max_attempts: 3, error_text: s("phoneError"),
    }),
    buttons("tour", s("tourText"), [
      ["tour_yes", s("tourYes"), "tour_ack"],
      ["tour_no", s("tourNo"), "info_ack"],
    ]),
    say("tour_ack", s("tourAck"), "tour_agent"),
    say("info_ack", s("infoAck"), "info_agent"),
    handoff("tour_agent", s("tourNote", details)),
    handoff("info_agent", s("infoNote", details)),
  ]);
}

// ---- real estate ----

function propertyEnquiry(): FlowTemplate {
  const s = scoped("property_enquiry");
  const intent = choices("intent", "ask_area", [
    ["buy", s("buyButton")],
    ["rent", s("rentButton")],
    ["sell", s("sellButton")],
  ]);
  return template("property_enquiry", "real_estate", "Home", "keyword", [
    startAt("intent"),
    buttons("intent", s("text"), intent.options),
    ...intent.nodes,
    ask("ask_area", s("askArea"), "area", "ask_budget"),
    ask("ask_budget", s("askBudget"), "budget", "ask_bedrooms", {
      validation: "number", min: 1, max_attempts: 3, error_text: s("budgetError"),
    }),
    ask("ask_bedrooms", s("askBedrooms"), "bedrooms", "ack", {
      validation: "number", min: 0, max: 10, max_attempts: 3, error_text: s("bedroomsError"),
    }),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", {
      intent: v("intent"), area: v("area"), budget: v("budget"), bedrooms: v("bedrooms"),
    })),
  ]);
}

function siteVisit(): FlowTemplate {
  const s = scoped("site_visit");
  const slot = choices("slot", "ask_phone", [
    ["morning", s("morningButton")],
    ["afternoon", s("afternoonButton")],
    ["evening", s("eveningButton")],
  ]);
  return template("site_visit", "real_estate", "CalendarDays", "keyword", [
    startAt("ask_property"),
    ask("ask_property", s("askProperty"), "property", "ask_date"),
    ask("ask_date", s("askDate"), "date", "slot", { validation: "date", max_attempts: 3, error_text: s("dateError") }),
    buttons("slot", s("slotText"), slot.options),
    ...slot.nodes,
    ask("ask_phone", s("askPhone"), "phone", "ack", { validation: "phone", max_attempts: 3, error_text: s("phoneError") }),
    say("ack", s("ack", { date: v("date"), slot: v("slot") }), "agent"),
    handoff("agent", s("handoffNote", {
      property: v("property"), date: v("date"), slot: v("slot"), phone: v("phone"),
    })),
  ]);
}

// ---- travel ----

function tourPackage(): FlowTemplate {
  const s = scoped("tour_package");
  const destination = choices("destination", "ask_date", [
    ["beach", s("beachRow")],
    ["mountains", s("mountainsRow")],
    ["city", s("cityRow")],
    ["wildlife", s("wildlifeRow")],
    ["unsure", s("unsureRow")],
  ]);
  return template("tour_package", "travel", "Plane", "keyword", [
    startAt("destination"),
    list("destination", s("text"), s("buttonLabel"), destination.rows),
    ...destination.nodes,
    ask("ask_date", s("askDate"), "date", "ask_travellers", {
      validation: "date", max_attempts: 3, error_text: s("dateError"),
    }),
    ask("ask_travellers", s("askTravellers"), "travellers", "ask_budget", {
      validation: "number", min: 1, max: 30, max_attempts: 3, error_text: s("travellersError"),
    }),
    ask("ask_budget", s("askBudget"), "budget", "ask_email", {
      validation: "number", min: 1, max_attempts: 3, error_text: s("budgetError"), skip_label: s("skipBudget"), skip_next: "ask_email",
    }),
    ask("ask_email", s("askEmail"), "email", "ack", { validation: "email", max_attempts: 3, error_text: s("emailError") }),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", {
      destination: v("destination"), date: v("date"), travellers: v("travellers"), budget: v("budget"), email: v("email"),
    })),
  ]);
}

function tripSupport(): FlowTemplate {
  const s = scoped("trip_support");
  const request = choices("request", "ask_details", [
    ["change", s("changeButton")],
    ["cancel", s("cancelButton")],
    ["other", s("otherButton")],
  ]);
  return template("trip_support", "travel", "Luggage", "keyword", [
    startAt("ask_reference"),
    ask("ask_reference", s("askReference"), "reference", "request", {
      validation: "regex", regex: "[A-Za-z0-9]{5,12}", max_attempts: 3, error_text: s("referenceError"),
    }),
    buttons("request", s("text"), request.options),
    ...request.nodes,
    ask("ask_details", s("askDetails"), "details", "ack"),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", { reference: v("reference"), request: v("request"), details: v("details") })),
  ]);
}

// ---- journeys (WA-02 router, J1, J3; J2 and J4 are above) ----

const JOURNEYS = [
  ["wfh", "1"],
  ["consult", "2"],
  ["chiro", "3"],
  ["ayurveda", "4"],
] as const;

/**
 * WA-02 journey router: the four-option menu (Work From Home, Free
 * Consultation, Chiropractic, Ayurvedic Products) as a list, with a typed
 * fallback for phones that do not show lists: an Ask Question that accepts
 * 1-4. Each option ends at a hand-off placeholder named after its journey;
 * the author replaces it with a Connect flow step to that journey's flow
 * (cloned from the templates below). The placeholders keep the clone
 * publishable as-is, since a Connect flow step needs a real flow.
 */
function journeyRouter(): FlowTemplate {
  const s = scoped("journey_router");
  return template("journey_router", "journeys", "Signpost", "first_inbound_message", [
    startAt("welcome"),
    buttons("welcome", s("text"), [
      ["menu", s("menuButton"), "menu"],
      ["type", s("typeButton"), "ask_number"],
    ]),
    list("menu", s("menuText"), s("buttonLabel"), JOURNEYS.map(([id]) => [id, s(`${id}Row`), `go_${id}`, s(`${id}Description`)] as Row)),
    ask("ask_number", s("askNumber"), "journey_number", "is_1", {
      validation: "regex", regex: "[1-4]", max_attempts: 3, error_text: s("numberError"), exhausted_next: "agent",
    }),
    ...JOURNEYS.map(([id, number], i) =>
      node(`is_${number}`, "condition", {
        subject: "var", subject_key: "journey_number", operator: "equals", value: number,
        true_next: `go_${id}`, false_next: i < JOURNEYS.length - 1 ? `is_${JOURNEYS[i + 1][1]}` : "agent",
      } as ConditionNodeConfig)),
    ...JOURNEYS.map(([id]) => handoff(`go_${id}`, s("placeholderNote", { journey: s(`${id}Row`) }))),
    handoff("agent", s("handoffNote")),
  ]);
}

/**
 * Journey J1 (PRD L131-141): Work From Home registration. Name, the WhatsApp
 * number (confirmed rather than retyped), city, state and preference, then a
 * link from the workspace value `wfh_link`, the wfh_registered tag (the author
 * binds the tag before publishing) and a hand-off. The copy makes no
 * earnings or income claims. Reached through the router (Connect flow), so it
 * has no keywords of its own.
 */
function workFromHome(): FlowTemplate {
  const s = scoped("work_from_home");
  const preference = choices("preference", "send_link", [
    ["part_time", s("partTimeButton")],
    ["full_time", s("fullTimeButton")],
    ["weekends", s("weekendsButton")],
  ]);
  const details = { name: v("applicant_name"), city: v("city"), state: v("state"), preference: v("preference"), phone: v("alt_phone") };
  return template("work_from_home", "journeys", "Laptop", "manual", [
    startAt("intro"),
    say("intro", s("intro"), "ask_name"),
    ask("ask_name", s("askName"), "applicant_name", "save_name"),
    setContact("save_name", "name", v("applicant_name"), "confirm_phone"),
    buttons("confirm_phone", s("confirmPhone"), [
      ["same", s("samePhoneButton"), "ask_city"],
      ["other", s("otherPhoneButton"), "ask_phone"],
    ]),
    ask("ask_phone", s("askPhone"), "alt_phone", "ask_city", { validation: "phone", max_attempts: 3, error_text: s("phoneError") }),
    ask("ask_city", s("askCity"), "city", "ask_state"),
    ask("ask_state", s("askState"), "state", "preference"),
    buttons("preference", s("askPreference"), preference.options),
    ...preference.nodes,
    say("send_link", s("linkMessage", { link: "{{workspace.wfh_link}}" }), "registered"),
    // Tags the contact as registered, so segments and automations (a
    // follow-up drip) can find applicants. The author binds the workspace's
    // wfh_registered tag; publishing reports setTagNeedsTag until then.
    node("registered", "set_tag", { mode: "add", tag_id: "", next_node_key: "agent" }),
    handoff("agent", s("handoffNote", details)),
  ]);
}

/**
 * Journey J3: a chiropractic visit. Books a time (every bookable service, any
 * practitioner); with a fee in the workspace value `chiropractic_fee` it then
 * sends a payment link, otherwise it skips payment. It ends with a line asking
 * for minimal clinical detail and hands over. Until appointments (and payments,
 * for the fee) are set up, publishing reports the missing capability.
 */
function chiropracticVisit(): FlowTemplate {
  const s = scoped("chiropractic_visit");
  return template("chiropractic_visit", "journeys", "Stethoscope", "manual", [
    startAt("intro"),
    say("intro", s("intro"), "book"),
    book("book", { success: "fee", unavailable: "agent", cancelled: "end" }),
    setVar("fee", "visit_fee", "{{workspace.chiropractic_fee}}", "has_fee"),
    node("has_fee", "condition", {
      subject: "var", subject_key: "visit_fee", operator: "present", true_next: "pay", false_next: "consent",
    } as ConditionNodeConfig),
    node("pay", "payment_link", {
      amount: v("visit_fee"), currency: "INR", message: s("payMessage"), description: s("payDescription"),
      expire_minutes: 1440, paid_next: "consent", expired_next: "consent", failed_next: "consent",
    } as PaymentLinkNodeConfig),
    say("consent", s("consent"), "agent"),
    handoff("agent", s("handoffNote")),
    END,
  ]);
}

// ---- finance ----

function loanEligibility(): FlowTemplate {
  const s = scoped("loan_eligibility");
  const answers = { income: v("income"), amount: v("amount"), age: v("age") };
  return template("loan_eligibility", "finance", "Landmark", "keyword", [
    startAt("intro"),
    say("intro", s("intro"), "ask_income"),
    ask("ask_income", s("askIncome"), "income", "ask_amount", {
      validation: "number", min: 0, max_attempts: 3, error_text: s("incomeError"),
    }),
    ask("ask_amount", s("askAmount"), "amount", "ask_age", {
      validation: "number", min: 1, max: 100000000, max_attempts: 3, error_text: s("amountError"),
    }),
    ask("ask_age", s("askAge"), "age", "check_age", {
      validation: "number", min: 18, max: 100, max_attempts: 3, error_text: s("ageError"),
    }),
    node("check_age", "condition", {
      subject: "var", subject_key: "age", operator: "between", value: "21", value2: "60",
      true_next: "eligible", false_next: "review",
    } as ConditionNodeConfig),
    say("eligible", s("eligible"), "eligible_agent"),
    say("review", s("review"), "review_agent"),
    handoff("eligible_agent", s("eligibleNote", answers)),
    handoff("review_agent", s("reviewNote", answers)),
  ]);
}

function insuranceRenewal(): FlowTemplate {
  const s = scoped("insurance_renewal");
  return template("insurance_renewal", "finance", "ShieldCheck", "keyword", [
    startAt("menu"),
    buttons("menu", s("text"), [
      ["renew", s("renewButton"), "ask_policy"],
      ["quote", s("quoteButton"), "ask_document"],
      ["advisor", s("advisorButton"), "advisor_agent"],
    ]),
    ask("ask_policy", s("askPolicy"), "policy", "renew_ack", {
      validation: "regex", regex: "[A-Za-z0-9/-]{4,30}", max_attempts: 3, error_text: s("policyError"),
    }),
    say("renew_ack", s("renewAck"), "renew_agent"),
    handoff("renew_agent", s("renewNote", { policy: v("policy") })),
    askOther("ask_media", "ask_document", s("askDocument"), "document", "quote_ack", {
      media_types: ["document", "image"],
      skip_label: s("skipDocument"),
      skip_next: "quote_ack",
    }),
    say("quote_ack", s("quoteAck"), "quote_agent"),
    handoff("quote_agent", s("quoteNote", { document: v("document") })),
    handoff("advisor_agent", s("advisorNote")),
  ]);
}

// ---- beauty ----

function salonAppointment(): FlowTemplate {
  const s = scoped("salon_appointment");
  const service = choices("service", "ask_date", [
    ["haircut", s("haircutRow")],
    ["colour", s("colourRow")],
    ["nails", s("nailsRow")],
    ["facial", s("facialRow")],
    ["bridal", s("bridalRow")],
  ]);
  // Books a real time when the workspace has appointments set up; otherwise
  // (or when nothing is free) the team confirms the slot as before.
  return template("salon_appointment", "beauty", "Scissors", "keyword", [
    startAt("book"),
    book("book", { success: "end", unavailable: "service", cancelled: "end" }),
    list("service", s("text"), s("buttonLabel"), service.rows),
    ...service.nodes,
    ask("ask_date", s("askDate"), "date", "ask_time", { validation: "date", max_attempts: 3, error_text: s("dateError") }),
    ask("ask_time", s("askTime"), "time", "ask_name"),
    ask("ask_name", s("askName"), "client_name", "save_name"),
    setContact("save_name", "name", v("client_name"), "ack"),
    say("ack", s("ack", { service: v("service"), date: v("date") }), "agent"),
    handoff("agent", s("handoffNote", {
      service: v("service"), date: v("date"), time: v("time"), name: v("client_name"),
    })),
    END,
  ]);
}

function spaPackages(): FlowTemplate {
  const s = scoped("spa_packages");
  const pkg = choices("package", "next", [
    ["relax", s("relaxRow"), s("relaxDesc")],
    ["deep", s("deepRow"), s("deepDesc")],
    ["couples", s("couplesRow"), s("couplesDesc")],
    ["voucher", s("voucherRow"), s("voucherDesc")],
  ]);
  return template("spa_packages", "beauty", "Sparkles", "keyword", [
    startAt("packages"),
    list("packages", s("text"), s("buttonLabel"), pkg.rows),
    ...pkg.nodes,
    buttons("next", s("nextText"), [
      ["book", s("bookButton"), "ask_date"],
      ["question", s("questionButton"), "question_agent"],
    ]),
    ask("ask_date", s("askDate"), "date", "book_ack", { validation: "date", max_attempts: 3, error_text: s("dateError") }),
    say("book_ack", s("bookAck"), "book_agent"),
    handoff("book_agent", s("bookNote", { package: v("package"), date: v("date") })),
    handoff("question_agent", s("questionNote", { package: v("package") })),
  ]);
}

// ---- events ----

function eventRsvp(): FlowTemplate {
  const s = scoped("event_rsvp");
  return template("event_rsvp", "events", "PartyPopper", "keyword", [
    startAt("rsvp"),
    buttons("rsvp", s("text"), [
      ["yes", s("yesButton"), "ask_guests"],
      ["no", s("noButton"), "no_ack"],
      ["maybe", s("maybeButton"), "maybe_ack"],
    ]),
    ask("ask_guests", s("askGuests"), "guests", "ask_diet", {
      validation: "number", min: 0, max: 5, max_attempts: 3, error_text: s("guestsError"),
    }),
    ask("ask_diet", s("askDiet"), "dietary", "yes_ack", { skip_label: s("skipDiet"), skip_next: "yes_ack" }),
    say("yes_ack", s("yesAck"), "end"),
    say("no_ack", s("noAck"), "end"),
    say("maybe_ack", s("maybeAck"), "end"),
    END,
  ]);
}

function webinarRegistration(): FlowTemplate {
  const s = scoped("webinar_registration");
  return template("webinar_registration", "events", "Video", "keyword", [
    startAt("intro"),
    say("intro", s("intro"), "ask_name"),
    ask("ask_name", s("askName"), "attendee_name", "save_name"),
    setContact("save_name", "name", v("attendee_name"), "ask_email"),
    ask("ask_email", s("askEmail"), "email", "save_email", { validation: "email", max_attempts: 3, error_text: s("emailError") }),
    setContact("save_email", "email", v("email"), "ack"),
    say("ack", s("ack", { name: v("attendee_name"), email: v("email") }), "end"),
    END,
  ]);
}

// ---- services ----

function supportTriage(): FlowTemplate {
  const s = scoped("support_triage");
  const topic = choices("topic", "ask_details", [
    ["billing", s("billingRow")],
    ["technical", s("technicalRow")],
    ["delivery", s("deliveryRow")],
    ["account", s("accountRow")],
    ["other", s("otherRow")],
  ]);
  return template("support_triage", "services", "LifeBuoy", "keyword", [
    startAt("topic"),
    list("topic", s("text"), s("buttonLabel"), topic.rows),
    ...topic.nodes,
    ask("ask_details", s("askDetails"), "details", "ask_screenshot"),
    askOther("ask_media", "ask_screenshot", s("askScreenshot"), "screenshot", "ack", {
      media_types: ["image", "video", "document"],
      skip_label: s("skipScreenshot"),
      skip_next: "ack",
    }),
    say("ack", s("ack"), "agent"),
    handoff("agent", s("handoffNote", { topic: v("topic"), details: v("details"), screenshot: v("screenshot") })),
  ]);
}

function feedbackNps(): FlowTemplate {
  const s = scoped("feedback_nps");
  return template("feedback_nps", "services", "Star", "keyword", [
    startAt("ask_score"),
    ask("ask_score", s("askScore"), "score", "is_promoter", {
      validation: "number", min: 0, max: 10, max_attempts: 3, error_text: s("scoreError"),
    }),
    node("is_promoter", "condition", {
      subject: "var", subject_key: "score", operator: "gte", value: "9", true_next: "promoter", false_next: "is_detractor",
    } as ConditionNodeConfig),
    node("is_detractor", "condition", {
      subject: "var", subject_key: "score", operator: "lte", value: "6", true_next: "ask_detractor", false_next: "ask_passive",
    } as ConditionNodeConfig),
    say("promoter", s("promoterReply"), "end"),
    ask("ask_detractor", s("askDetractor"), "reason", "detractor_ack"),
    say("detractor_ack", s("detractorAck"), "detractor_agent"),
    handoff("detractor_agent", s("detractorNote", { score: v("score"), reason: v("reason") })),
    ask("ask_passive", s("askPassive"), "suggestion", "passive_reply", { skip_label: s("skipPassive"), skip_next: "passive_reply" }),
    say("passive_reply", s("passiveReply"), "end"),
    END,
  ]);
}

// ============================================================
// Instagram starters (Stage 2, plan item 10)
//
// Instagram-only flows for Instagram › Quick automations and the Instagram
// flows gallery. Their copy lives in Instagram.quickAutomations.flows.<slug>.
// A comment-started run's first message is a private reply with an "opening
// DM" button: the tap opens the 24-hour window, and only then does the flow
// send links, ask questions or check the follow gate. Links the author must
// supply (their own page, reward or wa.me link) are left empty, so publishing
// reports them until they are filled in (INSTAGRAM_TEMPLATE_LINKS_TO_BIND).
// The comment-to-DM, follow-gate and email-lead graphs are shared with the
// guided setups (src/lib/instagram/wizards.ts), so a wizard's flow and its
// template have the same shape.
// ============================================================

const tIg = getT("Instagram.quickAutomations.flows");
const igScoped = (slug: string) => (key: string, values?: Record<string, string>) => tIg(`${slug}.${key}`, values);
const igKeywords = (slug: string): string[] =>
  tIg(`${slug}.keywords`).split(",").map((k) => k.trim()).filter(Boolean);

/** A private reply (the first message of a comment-started run) whose button opens the window. */
const privateReply = (key: string, text: string, optInLabel: string, next: string) =>
  node(key, "ig_private_reply", { text, opt_in_label: optInLabel, next_node_key: next } as IgPrivateReplyNodeConfig);
/** One card whose button opens a link (a link tap does not open the window). */
const linkCard = (key: string, card: { title: string; subtitle?: string; button: string; url: string }, next: string) =>
  node(key, "send_card", {
    card: {
      title: card.title,
      ...(card.subtitle ? { subtitle: card.subtitle } : {}),
      buttons: [{ type: "web_url", title: card.button, url: card.url }],
    },
    next_node_key: next,
  } as SendCardNodeConfig);
/** The follow gate: re-reads the profile when the run reaches it (needs live capture of the follow fields). */
const followCheck = (key: string, follows: string, notYet: string) =>
  node(key, "condition", {
    subject: "ig_profile", subject_key: "follows_business", operator: "equals", value: "true",
    true_next: follows, false_next: notYet,
  } as ConditionNodeConfig);

/** Copy for the comment-to-DM link graph. */
export interface CommentLinkCopy {
  opening: string;
  optInLabel: string;
  cardTitle: string;
  buttonLabel: string;
  url: string;
  /** More link buttons on the same card (Instagram allows 3 buttons per card in all). */
  moreLinks?: { label: string; url: string }[];
  /** Ask for an email before the link; it is saved on the contact. */
  email?: { prompt: string; error: string };
  /** Ask the person to follow before the link; the profile is re-read on each "I followed" tap. */
  follow?: { prompt: string; followedLabel: string };
}

/**
 * Comment → private reply with an opening-DM button → (email) → (follow gate)
 * → the link card. The opening button opens the messaging window, so the
 * optional steps run inside it.
 */
export function commentLinkNodes(copy: CommentLinkCopy): FlowTemplateNode[] {
  const afterEmail = copy.follow ? "check_follow" : "link";
  const first = copy.email ? "ask_email" : afterEmail;
  return [
    startAt("opening"),
    privateReply("opening", copy.opening, copy.optInLabel, first),
    ...(copy.email ? [
      ask("ask_email", copy.email.prompt, "email", "save_email", { validation: "email", max_attempts: 3, error_text: copy.email.error }),
      setContact("save_email", "email", v("email"), afterEmail),
    ] : []),
    ...(copy.follow ? [
      followCheck("check_follow", "link", "ask_follow"),
      buttons("ask_follow", copy.follow.prompt, [["followed", copy.follow.followedLabel, "check_follow"]]),
    ] : []),
    node("link", "send_card", {
      card: {
        title: copy.cardTitle,
        buttons: [{ label: copy.buttonLabel, url: copy.url }, ...(copy.moreLinks ?? [])]
          .map((b) => ({ type: "web_url", title: b.label, url: b.url })),
      },
      next_node_key: "end",
    } as SendCardNodeConfig),
    END,
  ];
}

/** Copy for the follow-gate graph. */
export interface FollowGateCopy {
  opening: string;
  optInLabel: string;
  followPrompt: string;
  followedLabel: string;
  rewardTitle: string;
  rewardButton: string;
  rewardUrl: string;
}

/**
 * Comment → private reply → "follows you?" → the reward. Someone not yet
 * following is asked to follow, and their "I followed" tap loops back to the
 * check, which re-reads the profile before releasing the reward.
 */
export function followGateNodes(copy: FollowGateCopy): FlowTemplateNode[] {
  return [
    startAt("opening"),
    privateReply("opening", copy.opening, copy.optInLabel, "check_follow"),
    followCheck("check_follow", "reward", "ask_follow"),
    buttons("ask_follow", copy.followPrompt, [["followed", copy.followedLabel, "check_follow"]]),
    linkCard("reward", { title: copy.rewardTitle, button: copy.rewardButton, url: copy.rewardUrl }, "end"),
    END,
  ];
}

/** Copy for the email-capture graph. */
export interface EmailLeadCopy {
  askEmail: string;
  emailError: string;
  thanks: string;
}

/** Asks for an email (3 tries), saves it on the contact and thanks them. The customer wrote first, so the window is open. */
export function emailLeadNodes(copy: EmailLeadCopy): FlowTemplateNode[] {
  return [
    startAt("ask_email"),
    ask("ask_email", copy.askEmail, "email", "save_email", { validation: "email", max_attempts: 3, error_text: copy.emailError }),
    setContact("save_email", "email", v("email"), "thanks"),
    say("thanks", copy.thanks, "end"),
    END,
  ];
}

/** An `ig_comment` trigger on any post, matching the template's keywords, with one public reply. */
function commentTrigger(keywordList: string[], publicReply: string): IgCommentTriggerConfig {
  return { post_scope: "any", include_keywords: keywordList, include_mode: "contains", public_replies: [publicReply] };
}

function igTemplate(
  slug: string,
  category: FlowTemplateCategory,
  icon: string,
  trigger_type: FlowTriggerType,
  trigger_config: FlowTemplate["trigger_config"],
  nodes: FlowTemplateNode[],
): FlowTemplate {
  return {
    slug,
    name: tIg(`${slug}.name`),
    description: tIg(`${slug}.description`),
    category,
    icon,
    trigger_type,
    trigger_config,
    entry_node_id: "start",
    nodes,
    channels: ["instagram"],
  };
}

/** Steps of the Instagram starters that hold a link the author fills in before publishing. */
export const INSTAGRAM_TEMPLATE_LINKS_TO_BIND: ReadonlySet<string> = new Set([
  "ig_link_drop.link",
  "ig_follow_gate.reward",
  "ig_to_whatsapp.wa_link",
  // Stage 5 starters.
  "ig_giveaway_draw.rules",
  "ig_giveaway_draw.winner",
  "ig_video_channel.channel",
  "ig_comment_rsvp.details",
  "ig_reel_product.product",
  "ig_live_prizes.prize_a",
  "ig_live_prizes.prize_b",
  "ig_live_prizes.prize_c",
  "ig_live_offer.offer",
  "ig_live_link.link",
  "ig_story_collab.kit",
  "ig_dm_link.link",
  "ig_ab_opening.link",
  "ig_ai_question.answer",
  "ig_link_follow_up.link",
  "ig_link_follow_up.reminder",
  "ig_solo_dm.link",
  "ig_opening_dm.link",
]);

// ---- comments ----

function igLinkDrop(): FlowTemplate {
  const s = igScoped("ig_link_drop");
  return igTemplate("ig_link_drop", "instagram_comments", "Link", "ig_comment",
    commentTrigger(igKeywords("ig_link_drop"), s("publicReply")),
    commentLinkNodes({ opening: s("opening"), optInLabel: s("optIn"), cardTitle: s("cardTitle"), buttonLabel: s("linkButton"), url: "" }));
}

function igProductLineup(): FlowTemplate {
  const s = igScoped("ig_product_lineup");
  const product = (n: number) => ({ title: s(`product${n}Title`), subtitle: s(`product${n}Subtitle`) });
  const pick = choices("product", "agent", [1, 2, 3].map((n): [string, string] => [`p${n}`, s(`product${n}Title`)]));
  return igTemplate("ig_product_lineup", "instagram_comments", "ShoppingBag", "ig_comment",
    commentTrigger(igKeywords("ig_product_lineup"), s("publicReply")), [
      startAt("opening"),
      privateReply("opening", s("opening"), s("optIn"), "lineup"),
      node("lineup", "send_gallery", { cards: [product(1), product(2), product(3)], next_node_key: "pick" } as SendGalleryNodeConfig),
      buttons("pick", s("pickText"), pick.options),
      ...pick.nodes,
      handoff("agent", s("handoffNote", { product: v("product") })),
    ]);
}

// ---- growth ----

function igGiveaway(): FlowTemplate {
  const s = igScoped("ig_giveaway");
  return igTemplate("ig_giveaway", "instagram_growth", "Gift", "ig_comment",
    commentTrigger(igKeywords("ig_giveaway"), s("publicReply")), [
      startAt("opening"),
      privateReply("opening", s("opening"), s("optIn"), "check_follow"),
      followCheck("check_follow", "ask_email", "ask_follow"),
      buttons("ask_follow", s("followPrompt"), [["followed", s("followedButton"), "check_follow"]]),
      ask("ask_email", s("askEmail"), "email", "save_email", { validation: "email", max_attempts: 3, error_text: s("emailError") }),
      setContact("save_email", "email", v("email"), "entered"),
      say("entered", s("entered"), "end"),
      END,
    ]);
}

function igFollowGate(): FlowTemplate {
  const s = igScoped("ig_follow_gate");
  return igTemplate("ig_follow_gate", "instagram_growth", "UserPlus", "ig_comment",
    commentTrigger(igKeywords("ig_follow_gate"), s("publicReply")),
    followGateNodes({
      opening: s("opening"), optInLabel: s("optIn"), followPrompt: s("followPrompt"), followedLabel: s("followedButton"),
      rewardTitle: s("rewardTitle"), rewardButton: s("rewardButton"), rewardUrl: "",
    }));
}

/** Bodhinox runs both channels, so a DM can move to the workspace's WhatsApp number (the author adds its wa.me link). */
function igToWhatsApp(): FlowTemplate {
  const s = igScoped("ig_to_whatsapp");
  return igTemplate("ig_to_whatsapp", "instagram_growth", "MessageCircle", "keyword",
    { keywords: igKeywords("ig_to_whatsapp"), match_type: "contains" }, [
      startAt("ask"),
      buttons("ask", s("ask"), [["yes", s("yesButton"), "wa_link"], ["no", s("noButton"), "stay"]]),
      linkCard("wa_link", { title: s("cardTitle"), subtitle: s("cardSubtitle"), button: s("openButton"), url: "" }, "end"),
      say("stay", s("stay"), "agent"),
      handoff("agent", s("handoffNote")),
      END,
    ]);
}

function igEmailList(): FlowTemplate {
  const s = igScoped("ig_email_list");
  return igTemplate("ig_email_list", "instagram_growth", "Mail", "keyword",
    { keywords: igKeywords("ig_email_list"), match_type: "contains" },
    emailLeadNodes({ askEmail: s("askEmail"), emailError: s("emailError"), thanks: s("thanks") }));
}

// ---- stories ----

function igStoryLeads(): FlowTemplate {
  const s = igScoped("ig_story_leads");
  return igTemplate("ig_story_leads", "instagram_stories", "Sparkles", "ig_story_reply",
    { match_mode: "contains", reactions: false } satisfies IgStoryReplyTriggerConfig,
    emailLeadNodes({ askEmail: s("askEmail"), emailError: s("emailError"), thanks: s("thanks") }));
}

function igStoryCoupon(): FlowTemplate {
  const s = igScoped("ig_story_coupon");
  return igTemplate("ig_story_coupon", "instagram_stories", "Ticket", "ig_story_reply",
    { match_mode: "contains", reactions: true } satisfies IgStoryReplyTriggerConfig,
    [startAt("coupon"), say("coupon", s("text"), "end"), END]);
}

function igStoryFaq(): FlowTemplate {
  const s = igScoped("ig_story_faq");
  return igTemplate("ig_story_faq", "instagram_stories", "HelpCircle", "ig_story_reply",
    { match_mode: "contains", reactions: false } satisfies IgStoryReplyTriggerConfig, [
      startAt("topics"),
      buttons("topics", s("ask"), [
        ["hours", s("hoursButton"), "answer_hours"],
        ["prices", s("pricesButton"), "answer_prices"],
        ["human", s("humanButton"), "agent"],
      ]),
      say("answer_hours", s("hoursAnswer"), "end"),
      say("answer_prices", s("pricesAnswer"), "end"),
      handoff("agent", s("handoffNote")),
      END,
    ]);
}

/** Story mentions (needs live capture: the story_mention payload), at most once a day per person. */
function igStoryMentionThanks(): FlowTemplate {
  const s = igScoped("ig_story_mention_thanks");
  return igTemplate("ig_story_mention_thanks", "instagram_stories", "AtSign", "ig_story_mention",
    { frequency: "once_per_24h" } satisfies IgStoryMentionTriggerConfig,
    [startAt("thanks"), say("thanks", s("text"), "end"), END]);
}

// ---- DMs ----

function igQuizQualifier(): FlowTemplate {
  const s = igScoped("ig_quiz_qualifier");
  return igTemplate("ig_quiz_qualifier", "instagram_dms", "ListChecks", "keyword",
    { keywords: igKeywords("ig_quiz_qualifier"), match_type: "contains" }, [
      startAt("q_budget"),
      buttons("q_budget", s("budgetQuestion"), [["low", s("budgetLow"), "budget_low"], ["high", s("budgetHigh"), "budget_high"]]),
      setVar("budget_low", "budget", "low", "q_timeline"),
      setVar("budget_high", "budget", "high", "q_timeline"),
      buttons("q_timeline", s("timelineQuestion"), [["now", s("timelineNow"), "timeline_now"], ["later", s("timelineLater"), "timeline_later"]]),
      setVar("timeline_now", "timeline", "now", "is_hot"),
      setVar("timeline_later", "timeline", "later", "is_hot"),
      node("is_hot", "condition", {
        match: "all",
        rules: [
          { subject: "var", subject_key: "budget", operator: "equals", value: "high" },
          { subject: "var", subject_key: "timeline", operator: "equals", value: "now" },
        ],
        true_next: "hot",
        false_next: "nurture",
      } as ConditionNodeConfig),
      say("hot", s("hotReply"), "agent"),
      handoff("agent", s("handoffNote")),
      say("nurture", s("nurtureReply"), "end"),
      END,
    ]);
}

/** The Instagram default reply, at most once a day per person. */
function igDefaultReply(): FlowTemplate {
  const s = igScoped("ig_default_reply");
  return igTemplate("ig_default_reply", "instagram_dms", "MessageSquare", "default_reply",
    { frequency: "once_per_24h" } satisfies DefaultReplyTriggerConfig, [
      startAt("menu"),
      buttons("menu", s("text"), [["info", s("infoButton"), "info"], ["human", s("humanButton"), "agent"]]),
      say("info", s("info"), "end"),
      handoff("agent", s("handoffNote")),
      END,
    ]);
}

// ============================================================
// Instagram starters (Stage 5, 5F: template parity)
//
// More Instagram starters built from the Stage 5 steps (Actions, Randomizer,
// Smart delay, the link-click condition) and the older ones. Copy, notes and
// the gallery's detail text live in StarterFlows.instagram5.templates.<slug>.
// The same rules as the Stage 2 starters hold: a comment-started run opens
// with one private reply whose button opens the 24-hour window; links, tags
// and the prize are left for the author to fill in, so publishing reports
// them until then (INSTAGRAM_TEMPLATE_LINKS_TO_BIND, TEMPLATE_TAGS_TO_BIND).
// Waits stay under 24 hours, and the engine re-checks the window before every
// automated send. Three starters ship without a trigger: the author attaches
// one in the builder.
// ============================================================

const t5 = getT("StarterFlows.instagram5.templates");
const s5 = (slug: string) => (key: string, values?: Record<string, string>) => t5(`${slug}.${key}`, values);
const keywords5 = (slug: string): string[] => t5(`${slug}.keywords`).split(",").map((k) => k.trim()).filter(Boolean);

/** A two-button card: a link (filled in by the author) and a reply that continues. */
const linkAndReplyCard = (key: string, card: { title: string; link: string; reply: string }, next: string) =>
  node(key, "send_card", {
    card: {
      title: card.title,
      buttons: [
        { type: "web_url", title: card.link, url: "" },
        { type: "postback", title: card.reply, reply_id: "done", next_node_key: next },
      ],
    },
    // A card with a reply button waits for the tap, so it has no Next link of its own.
    next_node_key: "",
  } as SendCardNodeConfig);
/** A tracked link card: clicks are counted for CTR and the "link clicked" condition. */
const trackedLinkCard = (key: string, card: { title: string; subtitle?: string; button: string }, next: string) => {
  const built = linkCard(key, { ...card, url: "" }, next);
  return { ...built, config: { ...(built.config as SendCardNodeConfig), track_clicks: true } };
};
const actions = (key: string, list: ActionsNodeConfig["actions"], next: string) =>
  node(key, "actions", { actions: list, next_node_key: next } as ActionsNodeConfig);
const randomizer = (key: string, paths: Array<[id: string, weight: number, next: string]>, sticky: boolean) =>
  node(key, "randomizer", {
    paths: paths.map(([id, weight, next_node_key]) => ({ id, weight, next_node_key })),
    sticky,
  } as RandomizerNodeConfig);
/** A wait of `hours` (under 24, so the send after it can still be inside the window). */
const waitHours = (key: string, hours: number, next: string) =>
  node(key, "smart_delay", { mode: "duration", amount: hours, unit: "hours", next_node_key: next } as SmartDelayNodeConfig);
const notes = (slug: string, count: number): CanvasNote[] =>
  Array.from({ length: count }, (_, i) => ({ id: `note_${i + 1}`, text: t5(`${slug}.note${i + 1}`), x: 360, y: 40 + i * 220 }));

function ig5Template(
  slug: string,
  category: FlowTemplateCategory,
  icon: string,
  trigger_type: FlowTriggerType,
  trigger_config: FlowTemplate["trigger_config"],
  nodes: FlowTemplateNode[],
  meta: FlowTemplateMeta,
  noteCount: number,
): FlowTemplate {
  const s = s5(slug);
  return {
    slug,
    name: s("name"),
    description: s("description"),
    category,
    icon,
    trigger_type,
    trigger_config,
    entry_node_id: "start",
    nodes,
    channels: ["instagram"],
    meta,
    business_value: s("businessValue"),
    how_it_works: s("howItWorks"),
    canvas_notes: notes(slug, noteCount),
  };
}

const flowMeta = (goals: FlowTemplateMeta["goals"], trigger: FlowTemplateMeta["trigger"],
  extra: Partial<FlowTemplateMeta> = {}): FlowTemplateMeta =>
  ({ goals, trigger, kind: "flow", level: "beginner", uses_ai: false, needs_payments: false, ...extra });

/** A comment trigger on any post with the template's keywords and public reply. */
const comment5 = (slug: string): IgCommentTriggerConfig => commentTrigger(keywords5(slug), s5(slug)("publicReply"));
const live5 = (slug: string): IgLiveCommentTriggerConfig => ({ keywords: keywords5(slug), match_mode: "contains" });

/** Tags a template leaves for the author to pick (the step and the condition that reads it). */
export const TEMPLATE_TAGS_TO_BIND: ReadonlySet<string> = new Set([
  "ig_giveaway_draw.check_entered",
  "ig_giveaway_draw.enter",
]);

// ---- comments ----

/** Comment to enter; a tag stops a second entry; one in twenty entrants (same person, same result) wins. */
function igGiveawayDraw(): FlowTemplate {
  const s = s5("ig_giveaway_draw");
  return ig5Template("ig_giveaway_draw", "instagram_growth", "Gift", "ig_comment", comment5("ig_giveaway_draw"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "check_entered"),
    node("check_entered", "condition", { subject: "tag", subject_key: "", operator: "present", true_next: "already", false_next: "rules" } as ConditionNodeConfig),
    say("already", s("already"), "end"),
    linkCard("rules", { title: s("rulesTitle"), button: s("rulesButton"), url: "" }, "enter"),
    actions("enter", [{ type: "add_tag", tag_id: "" }], "draw"),
    randomizer("draw", [["A", 95, "entered"], ["B", 5, "winner"]], true),
    say("entered", s("entered"), "end"),
    linkCard("winner", { title: s("winnerTitle"), button: s("winnerButton"), url: "" }, "end"),
    END,
  ], flowMeta(["grow_followers", "engage_audience"], "post_comment", { level: "advanced", recommended: true }), 3);
}

/** Comment on a video post, get the channel link, and say thanks after subscribing. */
function igVideoChannel(): FlowTemplate {
  const s = s5("ig_video_channel");
  return ig5Template("ig_video_channel", "instagram_growth", "Video", "ig_comment", comment5("ig_video_channel"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "channel"),
    linkAndReplyCard("channel", { title: s("cardTitle"), link: s("linkButton"), reply: s("doneButton") }, "thanks"),
    say("thanks", s("thanks"), "end"),
    END,
  ], flowMeta(["engage_audience", "drive_traffic"], "post_comment"), 2);
}

/** Comment to register: phone (optional), email, then the event details. */
function igCommentRsvp(): FlowTemplate {
  const s = s5("ig_comment_rsvp");
  return ig5Template("ig_comment_rsvp", "instagram_comments", "CalendarCheck", "ig_comment", comment5("ig_comment_rsvp"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "ask_phone"),
    ask("ask_phone", s("askPhone"), "phone", "ask_email", {
      validation: "phone", max_attempts: 3, error_text: s("phoneError"), skip_label: s("skipButton"), skip_next: "ask_email",
    }),
    ask("ask_email", s("askEmail"), "email", "save_email", { validation: "email", max_attempts: 3, error_text: s("emailError") }),
    setContact("save_email", "email", v("email"), "details"),
    linkCard("details", { title: s("cardTitle"), button: s("detailsButton"), url: "" }, "end"),
    END,
  ], flowMeta(["drive_traffic"], "post_comment"), 3);
}

/** Comment on a reel, get the product link, and a reminder 22 hours later if it was not opened. */
function igReelProduct(): FlowTemplate {
  const s = s5("ig_reel_product");
  return ig5Template("ig_reel_product", "instagram_comments", "ShoppingBag", "ig_comment", comment5("ig_reel_product"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "product"),
    trackedLinkCard("product", { title: s("cardTitle"), subtitle: s("cardSubtitle"), button: s("linkButton") }, "wait"),
    waitHours("wait", 22, "clicked"),
    node("clicked", "condition", { subject: "link_click", subject_key: "product", operator: "equals", value: "true", true_next: "end", false_next: "reminder" } as ConditionNodeConfig),
    say("reminder", s("reminder"), "end"),
    END,
  ], flowMeta(["drive_traffic"], "post_comment", { recommended: true }), 3);
}

// ---- live ----

/** A Live comment gets one of three prizes, drawn fresh every time. */
function igLivePrizes(): FlowTemplate {
  const s = s5("ig_live_prizes");
  return ig5Template("ig_live_prizes", "instagram_comments", "PartyPopper", "ig_live_comment", live5("ig_live_prizes"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "spin"),
    randomizer("spin", [["A", 33, "prize_a"], ["B", 33, "prize_b"], ["C", 34, "prize_c"]], false),
    linkCard("prize_a", { title: s("prizeATitle"), button: s("claimButton"), url: "" }, "end"),
    linkCard("prize_b", { title: s("prizeBTitle"), button: s("claimButton"), url: "" }, "end"),
    linkCard("prize_c", { title: s("prizeCTitle"), button: s("claimButton"), url: "" }, "end"),
    END,
  ], flowMeta(["engage_audience"], "live_comment"), 3);
}

/** A Live comment with the offer word gets the offer in DMs. */
function igLiveOffer(): FlowTemplate {
  const s = s5("ig_live_offer");
  return ig5Template("ig_live_offer", "instagram_comments", "Ticket", "ig_live_comment", live5("ig_live_offer"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "offer"),
    linkCard("offer", { title: s("cardTitle"), subtitle: s("cardSubtitle"), button: s("offerButton"), url: "" }, "end"),
    END,
  ], flowMeta(["drive_traffic"], "live_comment"), 2);
}

/** A Live comment gets the link, then an optional email for updates. */
function igLiveLink(): FlowTemplate {
  const s = s5("ig_live_link");
  return ig5Template("ig_live_link", "instagram_comments", "Link", "ig_live_comment", live5("ig_live_link"), [
    startAt("opening"),
    privateReply("opening", s("opening"), s("optIn"), "link"),
    linkCard("link", { title: s("cardTitle"), button: s("linkButton"), url: "" }, "ask_email"),
    ask("ask_email", s("askEmail"), "email", "save_email", {
      validation: "email", max_attempts: 3, error_text: s("emailError"), skip_label: s("skipButton"), skip_next: "end",
    }),
    setContact("save_email", "email", v("email"), "thanks"),
    say("thanks", s("thanks"), "end"),
    END,
  ], flowMeta(["drive_traffic"], "live_comment"), 2);
}

// ---- stories ----

/** A story reply about working together: the media kit for a known email, otherwise ask for one first. */
function igStoryCollab(): FlowTemplate {
  const s = s5("ig_story_collab");
  return ig5Template("ig_story_collab", "instagram_stories", "Star", "ig_story_reply",
    { keywords: keywords5("ig_story_collab"), match_mode: "contains", reactions: false } satisfies IgStoryReplyTriggerConfig, [
      startAt("known"),
      node("known", "condition", { subject: "contact_field", subject_key: "email", operator: "present", true_next: "kit", false_next: "ask_email" } as ConditionNodeConfig),
      ask("ask_email", s("askEmail"), "email", "save_email", { validation: "email", max_attempts: 3, error_text: s("emailError") }),
      setContact("save_email", "email", v("email"), "kit"),
      linkCard("kit", { title: s("cardTitle"), button: s("kitButton"), url: "" }, "end"),
      END,
    ], flowMeta(["engage_audience", "drive_traffic"], "story_reply"), 3);
}

// ---- DMs ----

/** A keyword DM joins the VIP text list: a checked phone number, saved to the contact. */
function igSmsList(): FlowTemplate {
  const s = s5("ig_sms_list");
  return ig5Template("ig_sms_list", "instagram_dms", "BellRing", "keyword",
    { keywords: keywords5("ig_sms_list"), match_type: "contains" }, [
      startAt("ask_phone"),
      ask("ask_phone", s("askPhone"), "phone", "joined", {
        validation: "phone", max_attempts: 3, error_text: s("phoneError"), skip_label: s("skipButton"), skip_next: "later",
        save_to: { target: "contact_field", key: "phone" },
      }),
      say("joined", s("joined"), "end"),
      say("later", s("later"), "end"),
      END,
    ], flowMeta(["drive_traffic"], "dm"), 2);
}

/** A keyword DM gets a short intro with a button, then the link. */
function igDmLink(): FlowTemplate {
  const s = s5("ig_dm_link");
  return ig5Template("ig_dm_link", "instagram_dms", "Link", "keyword",
    { keywords: keywords5("ig_dm_link"), match_type: "contains" }, [
      startAt("intro"),
      buttons("intro", s("intro"), [["send", s("sendButton"), "link"]]),
      trackedLinkCard("link", { title: s("cardTitle"), button: s("linkButton") }, "end"),
      END,
    ], flowMeta(["engage_audience", "drive_traffic"], "dm"), 2);
}

/** Half the people get opening A, half get B (same person, same opening): compare in Insights. */
function igAbOpening(): FlowTemplate {
  const s = s5("ig_ab_opening");
  return ig5Template("ig_ab_opening", "instagram_dms", "Split", "keyword",
    { keywords: keywords5("ig_ab_opening"), match_type: "contains" }, [
      startAt("split"),
      randomizer("split", [["A", 50, "opening_a"], ["B", 50, "opening_b"]], true),
      buttons("opening_a", s("openingA"), [["more", s("moreButton"), "link"]]),
      buttons("opening_b", s("openingB"), [["more", s("moreButton"), "link"]]),
      trackedLinkCard("link", { title: s("cardTitle"), button: s("linkButton") }, "end"),
      END,
    ], flowMeta(["engage_audience"], "dm", { level: "advanced" }), 2);
}

/** Recognises a question by meaning (AI) and answers it. */
function igAiQuestion(): FlowTemplate {
  const s = s5("ig_ai_question");
  return ig5Template("ig_ai_question", "instagram_dms", "Sparkles", "keyword",
    { keywords: [], match_type: "intent", intent: s("intent") }, [
      startAt("answer"),
      trackedLinkCard("answer", { title: s("answer"), button: s("linkButton") }, "end"),
      END,
    ], flowMeta(["engage_audience", "drive_traffic"], "dm", { uses_ai: true, recommended: true }), 2);
}

/** A keyword DM starts a short AI conversation grounded in the knowledge base, with a hand-off to the team. */
function igAiConversation(): FlowTemplate {
  const s = s5("ig_ai_conversation");
  return ig5Template("ig_ai_conversation", "instagram_dms", "MessageCircle", "keyword",
    { keywords: keywords5("ig_ai_conversation"), match_type: "contains" }, [
      startAt("chat"),
      node("chat", "ai_reply", {
        instructions: s("instructions"), use_knowledge: true, max_turns: 5, next_node_key: "wrap_up", handoff_next: "agent",
      } as AiReplyNodeConfig),
      say("wrap_up", s("wrapUp"), "end"),
      handoff("agent", s("handoffNote")),
      END,
    ], flowMeta(["engage_audience"], "dm", { uses_ai: true }), 2);
}

// ---- no trigger (the author attaches one) ----

/** The link, then a reminder 22 hours later only if it was not opened. */
function igLinkFollowUp(): FlowTemplate {
  const s = s5("ig_link_follow_up");
  return ig5Template("ig_link_follow_up", "instagram_dms", "RotateCcw", "manual", {}, [
    startAt("link"),
    trackedLinkCard("link", { title: s("cardTitle"), button: s("linkButton") }, "wait"),
    waitHours("wait", 22, "clicked"),
    node("clicked", "condition", { subject: "link_click", subject_key: "link", operator: "equals", value: "true", true_next: "end", false_next: "reminder" } as ConditionNodeConfig),
    linkCard("reminder", { title: s("reminderTitle"), button: s("linkButton"), url: "" }, "end"),
    END,
  ], flowMeta(["drive_traffic"], null), 3);
}

/** One DM with the link, nothing else. */
function igSoloDm(): FlowTemplate {
  const s = s5("ig_solo_dm");
  return ig5Template("ig_solo_dm", "instagram_dms", "Mail", "manual", {}, [
    startAt("link"),
    trackedLinkCard("link", { title: s("cardTitle"), button: s("linkButton") }, "end"),
    END,
  ], flowMeta(["drive_traffic"], null), 1);
}

/** Starts the conversation first and sends the link once they tap. */
function igOpeningDm(): FlowTemplate {
  const s = s5("ig_opening_dm");
  return ig5Template("ig_opening_dm", "instagram_dms", "MessageSquare", "manual", {}, [
    startAt("opening"),
    buttons("opening", s("opening"), [["yes", s("yesButton"), "link"]]),
    trackedLinkCard("link", { title: s("cardTitle"), button: s("linkButton") }, "end"),
    END,
  ], flowMeta(["engage_audience", "drive_traffic"], null), 1);
}

/** Gallery metadata of the Stage 2 starters (the Stage 5 ones carry their own). */
const STAGE2_META: Record<string, FlowTemplateMeta> = {
  ig_link_drop: flowMeta(["drive_traffic"], "post_comment", { kind: "quick", recommended: true }),
  ig_product_lineup: flowMeta(["drive_traffic", "engage_audience"], "post_comment"),
  ig_giveaway: flowMeta(["grow_followers", "engage_audience"], "post_comment"),
  ig_follow_gate: flowMeta(["grow_followers"], "post_comment", { kind: "quick" }),
  ig_to_whatsapp: flowMeta(["drive_traffic"], "dm"),
  ig_email_list: flowMeta(["drive_traffic"], "dm"),
  ig_story_leads: flowMeta(["drive_traffic"], "story_reply", { kind: "quick" }),
  ig_story_coupon: flowMeta(["drive_traffic"], "story_reply"),
  ig_story_faq: flowMeta(["engage_audience", "drive_traffic"], "story_reply"),
  ig_story_mention_thanks: flowMeta(["engage_audience"], null),
  ig_quiz_qualifier: flowMeta(["engage_audience", "drive_traffic"], "dm", { level: "advanced" }),
  ig_default_reply: flowMeta(["engage_audience"], "dm", { kind: "quick" }),
};

const withStage2Meta = (template: FlowTemplate): FlowTemplate =>
  Object.hasOwn(STAGE2_META, template.slug) ? { ...template, meta: STAGE2_META[template.slug] } : template;

// ============================================================
// WhatsApp starters (UI redesign, phase 3)
//
// The ManyChat-style WhatsApp gallery: six starters with gallery metadata
// (goal, trigger, AI), "Why it helps" / "How it works" text and canvas notes,
// in Bodhinox's own words. Copy lives in
// StarterFlows.whatsapp5.templates.<slug>. Every step needs no workspace
// record: the booking step offers any bookable service (and takes its
// unavailable port without one), AI steps need AI on for the workspace, and
// the website starter carries a reserved .example address the author
// replaces (a canvas note says so).
// ============================================================

const tw = getT("StarterFlows.whatsapp5.templates");
const sw = (slug: string) => (key: string, values?: Record<string, string>) => tw(`${slug}.${key}`, values);
const keywordsW = (slug: string): string[] => tw(`${slug}.keywords`).split(",").map((k) => k.trim()).filter(Boolean);
const notesW = (slug: string, count: number): CanvasNote[] =>
  Array.from({ length: count }, (_, i) => ({ id: `note_${i + 1}`, text: tw(`${slug}.note${i + 1}`), x: 360, y: 40 + i * 220 }));

function wa5Template(slug: string, icon: string, nodes: FlowTemplateNode[], meta: FlowTemplateMeta, noteCount: number): FlowTemplate {
  const s = sw(slug);
  return {
    slug,
    name: s("name"),
    description: s("description"),
    category: "general",
    icon,
    trigger_type: "keyword",
    trigger_config: { keywords: keywordsW(slug), match_type: "contains" },
    entry_node_id: "start",
    nodes,
    channels: ["whatsapp"],
    meta,
    business_value: s("businessValue"),
    how_it_works: s("howItWorks"),
    canvas_notes: notesW(slug, noteCount),
  };
}

/** A short AI conversation that answers, qualifies and hands over when unsure. */
function waAiChat(): FlowTemplate {
  const s = sw("wa_ai_chat");
  return wa5Template("wa_ai_chat", "Sparkles", [
    startAt("chat"),
    node("chat", "ai_reply", {
      instructions: s("instructions"), use_knowledge: true, max_turns: 6, next_node_key: "wrap_up", handoff_next: "agent",
    } as AiReplyNodeConfig),
    say("wrap_up", s("wrapUp"), "end"),
    handoff("agent", s("handoffNote")),
    END,
  ], flowMeta(["engage_audience"], "dm", { uses_ai: true, recommended: true }), 2);
}

/** Offers a meeting, books a free time, and checks back if no time suits. */
function waBookMeeting(): FlowTemplate {
  const s = sw("wa_book_meeting");
  return wa5Template("wa_book_meeting", "CalendarCheck", [
    startAt("offer"),
    buttons("offer", s("offer"), [["yes", s("yesButton"), "book"], ["no", s("noButton"), "not_now"]]),
    book("book", { success: "booked", unavailable: "no_times", cancelled: "not_now" }),
    say("booked", s("booked"), "end"),
    handoff("no_times", s("noTimesNote")),
    say("not_now", s("notNow"), "end"),
    END,
  ], flowMeta(["engage_audience"], "dm"), 2);
}

/** One AI answer from the knowledge base, then "Did that help?". */
function waAiAnswers(): FlowTemplate {
  const s = sw("wa_ai_answers");
  return wa5Template("wa_ai_answers", "MessageCircleQuestion", [
    startAt("answer"),
    node("answer", "ai_reply", {
      instructions: s("instructions"), use_knowledge: true, max_turns: 1, next_node_key: "helped", handoff_next: "agent",
    } as AiReplyNodeConfig),
    buttons("helped", s("helped"), [["yes", s("yesButton"), "thanks"], ["human", s("humanButton"), "agent"]]),
    say("thanks", s("thanks"), "end"),
    handoff("agent", s("handoffNote")),
    END,
  ], flowMeta(["engage_audience", "drive_traffic"], "dm", { uses_ai: true }), 2);
}

/** Asks for name and email and saves them on the contact. */
function waSaveDetails(): FlowTemplate {
  const s = sw("wa_save_details");
  return wa5Template("wa_save_details", "ClipboardList", [
    startAt("intro"),
    say("intro", s("intro"), "ask_name"),
    ask("ask_name", s("askName"), "name", "save_name"),
    setContact("save_name", "name", v("name"), "ask_email"),
    ask("ask_email", s("askEmail", { name: v("name") }), "email", "save_email", { validation: "email" }),
    setContact("save_email", "email", v("email"), "ask_interest"),
    ask("ask_interest", s("askInterest"), "interest", "thanks"),
    say("thanks", s("thanks", { name: v("name") }), "end"),
    END,
  ], flowMeta(["engage_audience"], "dm"), 2);
}

/** Sends the website link, then offers the team. */
function waWebsite(): FlowTemplate {
  const s = sw("wa_website");
  return wa5Template("wa_website", "Globe", [
    startAt("link"),
    say("link", s("link"), "more"),
    buttons("more", s("more"), [["done", s("doneButton"), "bye"], ["human", s("humanButton"), "agent"]]),
    say("bye", s("bye"), "end"),
    handoff("agent", s("handoffNote")),
    END,
  ], flowMeta(["drive_traffic"], "dm"), 1);
}

/** Three tap-to-answer questions; ready buyers go to the team, the rest get a friendly follow-up. */
function waLeadQuiz(): FlowTemplate {
  const s = sw("wa_lead_quiz");
  const when = choices("timeline", "q_budget", [["now", s("timelineNow")], ["month", s("timelineMonth")], ["later", s("timelineLater")]]);
  const budget = choices("budget", "q_help", [["small", s("budgetSmall")], ["medium", s("budgetMedium")], ["large", s("budgetLarge")]]);
  const help = choices("needs_help", "score", [["yes", s("helpYes")], ["no", s("helpNo")]]);
  return wa5Template("wa_lead_quiz", "ListChecks", [
    startAt("intro"),
    buttons("intro", s("intro"), [["start", s("startButton"), "q_timeline"]]),
    buttons("q_timeline", s("qTimeline"), when.options),
    ...when.nodes,
    buttons("q_budget", s("qBudget"), budget.options),
    ...budget.nodes,
    buttons("q_help", s("qHelp"), help.options),
    ...help.nodes,
    // A ready buyer: anyone not "just looking".
    node("score", "condition", {
      subject: "var", subject_key: "timeline", operator: "not_equals", value: s("timelineLater"), true_next: "hot", false_next: "nurture",
    } as ConditionNodeConfig),
    say("hot", s("hot"), "agent"),
    handoff("agent", s("handoffNote", { timeline: v("timeline"), budget: v("budget"), help: v("needs_help") })),
    say("nurture", s("nurture"), "end"),
    END,
  ], flowMeta(["engage_audience"], "dm", { level: "advanced" }), 2);
}

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = Object.fromEntries(
  [
    WELCOME_MENU,
    FAQ_BOT,
    LEAD_CAPTURE,
    optIn(),
    orderStatus(),
    cartRecovery(),
    returnRequest(),
    storeLocator(),
    tableBooking(),
    foodOrder(),
    clinicAppointment(),
    journeyRouter(),
    workFromHome(),
    freeConsultation(),
    chiropracticVisit(),
    ayurvedicStore(),
    clinicTriage(),
    courseEnquiry(),
    admissionEnquiry(),
    propertyEnquiry(),
    siteVisit(),
    tourPackage(),
    tripSupport(),
    loanEligibility(),
    insuranceRenewal(),
    salonAppointment(),
    spaPackages(),
    eventRsvp(),
    webinarRegistration(),
    supportTriage(),
    feedbackNps(),
    // Instagram starters (Stage 2), with their Stage 5 gallery metadata.
    ...[
      igLinkDrop(),
      igProductLineup(),
      igGiveaway(),
      igFollowGate(),
      igToWhatsApp(),
      igEmailList(),
      igStoryLeads(),
      igStoryCoupon(),
      igStoryFaq(),
      igStoryMentionThanks(),
      igQuizQualifier(),
      igDefaultReply(),
    ].map(withStage2Meta),
    // Instagram starters (Stage 5).
    igGiveawayDraw(),
    igVideoChannel(),
    igCommentRsvp(),
    igReelProduct(),
    igLivePrizes(),
    igLiveOffer(),
    igLiveLink(),
    igStoryCollab(),
    igSmsList(),
    igDmLink(),
    igAbOpening(),
    igAiQuestion(),
    igAiConversation(),
    igLinkFollowUp(),
    igSoloDm(),
    igOpeningDm(),
    waAiChat(),
    waBookMeeting(),
    waAiAnswers(),
    waSaveDetails(),
    waWebsite(),
    waLeadQuiz(),
  ].map((template) => [template.slug, template]),
);

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return Object.hasOwn(TEMPLATES, slug) ? TEMPLATES[slug] : null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}
