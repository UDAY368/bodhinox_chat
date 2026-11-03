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
  BookAppointmentNodeConfig,
  AskAddressNodeConfig,
  AskLocationNodeConfig,
  AskMediaNodeConfig,
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMessageNodeConfig,
  SendStorefrontLinkNodeConfig,
  SetAttributeNodeConfig,
  StartNodeConfig,
} from "./types";
import { getT } from "@/lib/i18n/translate";

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
  | "handoff"
  | "end";

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
    | Record<string, unknown>;
}

/** Gallery groups, in display order. */
export const FLOW_TEMPLATE_CATEGORIES = [
  "general",
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
] as const;
export type FlowTemplateCategory = (typeof FLOW_TEMPLATE_CATEGORIES)[number];

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  category: FlowTemplateCategory;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: string;
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  nodes: FlowTemplateNode[];
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
  return template("free_consultation", "health", "CalendarDays", "keyword", [
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
  return template("ayurvedic_store", "health", "Leaf", "keyword", [
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
    freeConsultation(),
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
  ].map((template) => [template.slug, template]),
);

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return Object.hasOwn(TEMPLATES, slug) ? TEMPLATES[slug] : null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}
