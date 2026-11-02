/**
 * Type definitions for the Flows runtime.
 *
 * These mirror the Supabase schema added in migration 010 (`flows`,
 * `flow_nodes`, `flow_runs`, `flow_run_events`) plus the discriminated
 * unions the engine uses to typecheck node configs.
 *
 * Schema invariants enforced here that the DB CHECK constraints don't:
 *   - Each node_type maps to one config shape — adding a new node_type
 *     requires adding the matching config interface AND extending
 *     `FlowNodeConfig` so the engine's exhaustiveness checks light up.
 *   - Edges live INSIDE the config (each button row / list row carries
 *     `next_node_key`). The DB schema doesn't model this — the
 *     validator (PR #3) catches missing or orphan edges at save time.
 *
 * `next_node_key` is the stable string id stored in `flow_nodes.node_key`,
 * not a UUID, so flows can be cloned / templated without rewriting
 * references in JSONB.
 */

// ============================================================
// Node configs (discriminated union by node_type)
// ============================================================

export interface StartNodeConfig {
  /** Stable node_key of the first real node to advance to. */
  next_node_key: string;
}

export interface SendMessageNodeConfig {
  /** Plain text sent to the customer; can interpolate {{vars.X}}. */
  text: string;
  /** Auto-advance target after the message lands at Meta. */
  next_node_key: string;
}

export interface SendButtonsNodeConfig {
  text: string;
  /** Optional header / footer lines around the buttons. */
  header_text?: string;
  footer_text?: string;
  /** 1-3 buttons; Meta cap enforced in meta-api validation. */
  buttons: Array<{
    /** Stable id sent back by Meta when this button is tapped. */
    reply_id: string;
    /** Visible label (≤ 20 chars per Meta). */
    title: string;
    /** node_key the runner advances to when this button is tapped. */
    next_node_key: string;
  }>;
}

export interface SendListNodeConfig {
  text: string;
  /** Label of the tap-to-expand button on the message bubble. */
  button_label: string;
  header_text?: string;
  footer_text?: string;
  /** 1-10 rows TOTAL across sections; cap enforced in meta-api. */
  sections: Array<{
    title?: string;
    rows: Array<{
      reply_id: string;
      title: string;
      description?: string;
      next_node_key: string;
    }>;
  }>;
}

/**
 * Sends a single image / video / document via WhatsApp, then
 * auto-advances. The media file is uploaded to the `flow-media`
 * Supabase Storage bucket by the builder; `media_url` is the public
 * URL Meta fetches at send time.
 *
 * Why one node with a `media_type` discriminator (rather than three
 * separate node types): Meta's send-side payload differs only in the
 * top-level key (`image` / `video` / `document`) and the
 * filename-on-document quirk. Modeling three node types would triple
 * the builder forms, engine cases, and add-menu entries for no
 * meaningful behavioural difference.
 */
export interface SendMediaNodeConfig {
  media_type: "image" | "video" | "document";
  /** Public URL Meta will fetch. Uploaded via the builder's file picker. */
  media_url: string;
  /** Optional caption shown under the media (Meta caps at 1024 chars). */
  caption?: string;
  /**
   * Filename shown in the recipient's chat. Documents only — Meta
   * ignores it for image/video. Defaults to the file's original name
   * at upload time; the user can edit it.
   */
  filename?: string;
  /** Auto-advance target after the send lands at Meta. */
  next_node_key: string;
}

export interface HandoffNodeConfig {
  /** Optional internal note written to flow_run_events.payload.note. */
  note?: string;
  /**
   * Optional agent user_id to assign on the conversation when this
   * node fires. Leave unset to flip the status without assignment.
   */
  assign_to?: string;
}

/**
 * Timing any node may carry. Both run through the durable `flow.timer`
 * job, so they survive worker restarts.
 */
export interface NodeTiming {
  /** Wait this long (1 s – 24 h) before running the node. */
  delay_seconds?: number;
  /** Waiting nodes only: stop waiting for a reply after this many minutes… */
  timeout_minutes?: number;
  /** …and continue here. Required when `timeout_minutes` is set. */
  after_timeout?: string;
}

/**
 * Per-node handling of invalid replies on the nodes that ask for input.
 * When `max_attempts` is unset, invalid replies use the flow's fallback
 * policy exactly as before.
 */
export interface AskRetry {
  /** Replies allowed (1–10) before the node gives up. */
  max_attempts?: number;
  /** Sent after an invalid reply; defaults to the prompt itself. */
  error_text?: string;
  /** Where to go once `max_attempts` invalid replies arrive; unset follows the flow's `on_exhaust`. */
  exhausted_next?: string;
}

export type InputFormat = "any" | "email" | "phone" | "regex" | "number" | "date" | "boolean";

/**
 * Ask Question: captures the customer's next reply into
 * `flow_runs.vars[var_key]`, then advances. The node type keeps its
 * original name so stored flows run unchanged.
 */
export interface CollectInputNodeConfig extends AskRetry {
  /** Prompt text sent to the customer before they reply. */
  prompt_text: string;
  /**
   * Key under which to store the captured text in
   * `flow_runs.vars`. Stable identifier — used by downstream
   * `condition` nodes and `handoff` notes via interpolation.
   */
  var_key: string;
  /**
   * Defaults to any non-empty text. `number` stores the parsed number,
   * `date` stores YYYY-MM-DD and `boolean` stores "true"/"false".
   */
  validation?: InputFormat;
  /** Used only when `validation === 'regex'`. */
  regex?: string;
  /** Inclusive bounds when `validation === 'number'`. */
  min?: number;
  max?: number;
  /** Adds a Skip button to the prompt; tapping it goes to `skip_next` without capturing. */
  skip_label?: string;
  skip_next?: string;
  /** Node to advance to after capture. */
  next_node_key: string;
}

export type MediaReplyType = "image" | "video" | "document" | "audio";

/** Ask Media: waits for a photo, video, document or voice note and stores its link. */
export interface AskMediaNodeConfig extends AskRetry {
  prompt_text: string;
  /** Accepted kinds; empty accepts any. */
  media_types?: MediaReplyType[];
  var_key: string;
  skip_label?: string;
  skip_next?: string;
  next_node_key: string;
}

/**
 * Ask Location: sends a share-location request. Stores "lat,lng" in
 * `var_key` plus `<var_key>_latitude`, `_longitude`, `_name`, `_address`.
 */
export interface AskLocationNodeConfig extends AskRetry {
  prompt_text: string;
  var_key: string;
  next_node_key: string;
}

/**
 * Ask Address: Meta's address form for Indian numbers, a typed address
 * elsewhere. Stores the full address in `var_key` and each form field
 * as `<var_key>_<field>` (city, state, in_pin_code, …).
 */
export interface AskAddressNodeConfig extends AskRetry {
  prompt_text: string;
  var_key: string;
  next_node_key: string;
}

/**
 * Send Form: sends a published WhatsApp form (Meta Flow) and waits for the
 * submission. The answers are stored as an object in `vars[var_key]` and
 * each one as `<var_key>_<field_id>` so prompts can use `{{vars.x}}`.
 * Like the ask nodes it may carry a reply timeout (`after_timeout` port).
 */
export interface SendFormNodeConfig {
  /** whatsapp_forms.id; the form must be published when the flow is activated. */
  form_id: string;
  /** Button that opens the form (≤ 30 chars). */
  cta: string;
  /** Message body (≤ 1024 chars); can interpolate {{vars.X}}. */
  body: string;
  header?: string;
  footer?: string;
  var_key: string;
  next_node_key: string;
}

/**
 * Payment link: creates a Razorpay payment link for the run (one per run,
 * node and transition, so a replay never creates a second), sends it as a
 * text message and waits for the payment. A verified webhook or a verified
 * fetch resumes the run on `paid_next`; an expired or cancelled link on
 * `expired_next`; a link that could not be created or sent on `failed_next`.
 * An unwired expired/failed port ends the run. Stores `payment_link_url`,
 * `payment_status` and `payment_link_id` in vars. May carry a reply timeout
 * (`after_timeout` port) like the other waiting steps.
 */
export interface PaymentLinkNodeConfig {
  /** Amount in major units ("499", "1,250.50"); may use {{vars.x}}. */
  amount: string;
  /** ISO 4217 code, e.g. INR. */
  currency: string;
  /** Shown on the Razorpay payment page (≤ 2048 chars); may use {{vars.x}}. */
  description?: string;
  /** Text sent above the link (≤ 900 chars); may use {{vars.x}}. */
  message: string;
  /** Minutes until the link expires (16 – 259200); unset means it does not expire. */
  expire_minutes?: number;
  paid_next: string;
  expired_next?: string;
  failed_next?: string;
}

/**
 * Sends an approved WhatsApp template. A template with quick-reply
 * buttons waits for a tap and routes per button (same `buttons` shape
 * as send_buttons, plus the template button `index`); one without
 * advances to `next_node_key`. Templates may be sent outside the 24-hour
 * window, so this is the step to re-engage after a long wait.
 */
export interface SendTemplateNodeConfig {
  template_name: string;
  language?: string;
  /** One value per {{n}} in the body; each may use {{vars.x}} / {{workspace.x}}. */
  body_params?: string[];
  buttons?: Array<{ index: number; reply_id: string; title: string; next_node_key: string }>;
  next_node_key?: string;
  /** Location-header templates: the place shown above the body (numeric text from the form is accepted). */
  location?: { latitude: number | string; longitude: number | string; name?: string; address?: string };
  /** Limited-time offers with an end: the offer ends this many minutes after the send. */
  offer_expires_in_minutes?: number;
  /** Copy-code button value; may use {{vars.x}}. The button's stored example otherwise. */
  coupon_code?: string;
  /** Carousel templates: one list of body values per card, like body_params. */
  card_params?: string[][];
}

/** Calls an external HTTP API, maps the JSON reply into run variables and routes on the status. */
export interface ApiRequestNodeConfig {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  url: string;
  params?: Array<{ key: string; value: string }>;
  headers?: Array<{ key: string; value: string }>;
  /** JSON text; placeholders inside it are JSON-escaped. */
  body?: string;
  /** Dot path into the JSON reply (e.g. data.items.0.id) stored as `var_key`. */
  mappings?: Array<{ path: string; var_key: string }>;
  /** Up to 5 routes on an exact status ("200") or a class ("2xx"), checked in order. */
  routes?: Array<{ status: string; next_node_key: string }>;
  /** Any other status, a timeout, a blocked destination or a network error. */
  fallback_next: string;
}

/** Ends this run and starts another active flow for the same contact, carrying the run's variables. */
export interface ConnectFlowNodeConfig {
  flow_id: string;
}

/** Assigns the conversation to an agent and carries on (handoff also pauses the bot and ends the run). */
export interface AssignAgentNodeConfig {
  mode: "specific" | "round_robin";
  agent_id?: string;
  next_node_key: string;
}

/** Writes a run variable or a contact field from a literal or `{{vars.x}}`. */
export interface SetAttributeNodeConfig {
  target: "var" | "contact_field" | "custom_field";
  /** Variable name, one of name/email/company, or a custom field id. */
  key: string;
  value: string;
  next_node_key: string;
}

export type ConditionOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "present"
  | "absent"
  | "gt"
  | "gte"
  | "lt"
  | "lte"
  | "between";

export type ConditionSubject = "var" | "tag" | "contact_field" | "custom_field" | "time" | "date";

/** One test. `time` and `date` read the clock in the node's timezone (HH:MM, YYYY-MM-DD). */
export interface ConditionRule {
  subject: ConditionSubject;
  /**
   * For `var`: the key in flow_runs.vars.
   * For `tag`: the tag UUID (matched against contact_tags).
   * For `contact_field`: one of 'name' | 'email' | 'phone' | 'company'.
   * For `custom_field`: the custom field id. Unused for `time` / `date`.
   */
  subject_key: string;
  operator: ConditionOperator;
  /** Compared value; the lower bound for `between`. */
  value?: string;
  /** Upper bound for `between` (inclusive; a time window may cross midnight). */
  value2?: string;
}

/**
 * Routes the run based on its rules. Without `rules` the node is the
 * original single test (the ConditionRule fields at the top level).
 * Always auto-advances — no Meta call, no customer-side input.
 */
export interface ConditionNodeConfig extends Partial<ConditionRule> {
  /** Every rule must hold (`all`, default) or any one (`any`). */
  match?: "all" | "any";
  rules?: ConditionRule[];
  /** IANA timezone for `time` / `date` rules; defaults to UTC. */
  timezone?: string;
  /** Node to advance to when the predicate evaluates true. */
  true_next: string;
  /** Node to advance to when it evaluates false. */
  false_next: string;
}

export interface SetTagNodeConfig {
  mode: "add" | "remove";
  /** Tag UUID. The builder picks from the user's existing tags. */
  tag_id: string;
  next_node_key: string;
}

// Terminal nodes carry no config — they just stop the run.
export type EndNodeConfig = Record<string, never>;

/**
 * Catalogue steps (lib/commerce/catalog-send). They send from the
 * conversation's number with the catalogue linked to it, then auto-advance.
 * Products are named by their catalogue content id (retailer id), so a
 * flow survives re-syncs; texts may use {{vars.X}}.
 */
export interface SendProductNodeConfig {
  product_retailer_id: string;
  body_text?: string;
  footer_text?: string;
  next_node_key: string;
}

export interface SendProductListNodeConfig {
  header_text: string;
  body_text: string;
  footer_text?: string;
  /** 1-10 sections, 1-30 products in total; titles required when more than one section. */
  sections: Array<{ title: string; product_retailer_ids: string[] }>;
  next_node_key: string;
}

export interface SendCatalogNodeConfig {
  body_text: string;
  footer_text?: string;
  thumbnail_product_retailer_id?: string;
  next_node_key: string;
}

/**
 * Total union — every concrete node_type the v1 engine understands.
 * Add new node types here and the engine's switch will flag missing
 * cases via TypeScript's exhaustiveness check.
 *
 * v1.5+ additions (collect_input, condition, set_tag, http_fetch) will
 * extend this union — out-of-scope for the v1 engine PR.
 */
export type FlowNodeConfig =
  | { node_type: "start"; config: StartNodeConfig }
  | { node_type: "send_message"; config: SendMessageNodeConfig }
  | { node_type: "send_buttons"; config: SendButtonsNodeConfig }
  | { node_type: "send_list"; config: SendListNodeConfig }
  | { node_type: "send_media"; config: SendMediaNodeConfig }
  | { node_type: "collect_input"; config: CollectInputNodeConfig }
  | { node_type: "condition"; config: ConditionNodeConfig }
  | { node_type: "set_tag"; config: SetTagNodeConfig }
  | { node_type: "set_attribute"; config: SetAttributeNodeConfig }
  | { node_type: "ask_media"; config: AskMediaNodeConfig }
  | { node_type: "ask_location"; config: AskLocationNodeConfig }
  | { node_type: "ask_address"; config: AskAddressNodeConfig }
  | { node_type: "send_form"; config: SendFormNodeConfig }
  | { node_type: "send_product"; config: SendProductNodeConfig }
  | { node_type: "send_product_list"; config: SendProductListNodeConfig }
  | { node_type: "send_catalog"; config: SendCatalogNodeConfig }
  | { node_type: "payment_link"; config: PaymentLinkNodeConfig }
  | { node_type: "send_template"; config: SendTemplateNodeConfig }
  | { node_type: "api_request"; config: ApiRequestNodeConfig }
  | { node_type: "connect_flow"; config: ConnectFlowNodeConfig }
  | { node_type: "assign_agent"; config: AssignAgentNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "end"; config: EndNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  /** `regex` tests `pattern` against the message instead of the keywords. */
  match_type?: "exact" | "contains" | "regex";
  case_sensitive?: boolean;
  /** Regular expression for `match_type: "regex"` (searched, not anchored). */
  pattern?: string;
  /** Editor hint: the keywords are WhatsApp ice breakers (matched exactly). */
  icebreaker?: boolean;
}

/**
 * Starts the flow when a customer taps a quick-reply button on a sent
 * template (a broadcast, say). The tapped button's text is stored in the
 * run's `trigger_button` variable so the flow can branch on it.
 */
export interface TemplateReplyTriggerConfig {
  template_name: string;
  /** Button texts that start the flow; empty means any button. */
  buttons?: string[];
}

// No knobs in v1 — the trigger has a single semantic. Kept as a type
// alias (not an empty interface) for forward compat without tripping
// the no-empty-object-type lint rule.
export type FirstInboundTriggerConfig = Record<string, never>;

/** Starts the flow when a customer sends a WhatsApp cart. No knobs yet. */
export type OrderReceivedTriggerConfig = Record<string, never>;

export type FlowTriggerConfig =
  | { trigger_type: "order_received"; config: OrderReceivedTriggerConfig }
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "manual"; config: Record<string, never> }
  | { trigger_type: "template_reply"; config: TemplateReplyTriggerConfig };

// ============================================================
// DB-row shapes (read by the engine via databaseAdmin)
// ============================================================

export interface FlowRow {
  id: string;
  /** Account tenancy (NOT NULL post-017). The engine looks up active
   *  flows for inbound dispatch using this field. */
  account_id: string;
  /** Author. Used as a default sender-of-record on engine sends and
   *  preserved on flow_runs for log/audit display. */
  user_id: string;
  name: string;
  description: string | null;
  status: "draft" | "active" | "archived";
  trigger_type: "keyword" | "first_inbound_message" | "manual" | "template_reply" | "order_received";
  trigger_config: KeywordTriggerConfig | FirstInboundTriggerConfig | TemplateReplyTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  /** While the flow is a draft it runs only for these numbers (digits, up to 3). */
  test_numbers?: string[];
  /** The WhatsApp number (whatsapp_config.id) the flow listens on; null listens on every number. */
  whatsapp_config_id?: string | null;
  execution_count: number;
  last_executed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface FlowNodeRow {
  id: string;
  flow_id: string;
  node_key: string;
  node_type: FlowNodeType;
  config: Record<string, unknown>;
  position_x: number;
  position_y: number;
  created_at: string;
}

export interface FlowRunRow {
  id: string;
  flow_id: string;
  /** Tenancy. Matches flows.account_id; NOT NULL post-017. */
  account_id: string;
  /** Audit. Matches the parent flow.user_id. */
  user_id: string;
  contact_id: string | null;
  conversation_id: string | null;
  status:
    | "active"
    | "completed"
    | "handed_off"
    | "timed_out"
    | "cancelled"
    | "paused_by_agent"
    | "failed";
  current_node_key: string | null;
  transition_seq: number;
  last_prompt_message_id: string | null;
  vars: Record<string, unknown>;
  reprompt_count: number;
  started_at: string;
  last_advanced_at: string;
  ended_at: string | null;
  end_reason: string | null;
  /** Set while the run waits out a node delay. */
  delay_until?: string | null;
}

// ============================================================
// Fallback policy (matches flows.fallback_policy JSONB)
// ============================================================

export interface FlowFallbackPolicy {
  /** What to do when the customer reply doesn't match any option. */
  on_unknown_reply: "reprompt" | "handoff" | "ignore" | "ai";
  /** Max reprompts before applying `on_exhaust`. */
  max_reprompts: number;
  /** Stale-run sweep cutoff. */
  on_timeout_hours: number;
  /** What to do once max_reprompts has been hit. */
  on_exhaust: "handoff" | "end";
  /** Sent whenever a reply is off-script, before the action above. */
  fallback_message?: FallbackMessage;
}

/** The default reply to an off-script message: text, or an image / video with the text as caption. */
export interface FallbackMessage {
  text: string;
  media_type?: "image" | "video";
  media_url?: string;
}

export const DEFAULT_FALLBACK_POLICY: FlowFallbackPolicy = {
  on_unknown_reply: "reprompt",
  max_reprompts: 2,
  on_timeout_hours: 24,
  on_exhaust: "handoff",
};

// ============================================================
// Engine input — what `dispatchInboundToFlows` accepts
// ============================================================

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound =
  | {
      kind: "text";
      /** The user's typed message body. */
      text: string;
      /** Meta's `messages[0].id` — used for idempotency. */
      meta_message_id: string;
    }
  | {
      kind: "interactive_reply";
      /** The reply_id of the tapped button or list row. */
      reply_id: string;
      /** The visible title of the tapped option (for logging). */
      reply_title: string;
      meta_message_id: string;
      /** Name of the sent template whose quick-reply button this tap answers. */
      context_template?: string;
    }
  | {
      kind: "media";
      media_type: MediaReplyType;
      /** Stored link (mirrored copy or the media proxy). */
      url: string;
      caption: string;
      meta_message_id: string;
    }
  | {
      kind: "location";
      latitude: number;
      longitude: number;
      name?: string;
      address?: string;
      meta_message_id: string;
    }
  | {
      kind: "address";
      /** Address-form fields (city, state, in_pin_code, …). */
      values: Record<string, string>;
      meta_message_id: string;
    }
  | {
      kind: "form";
      /** The submitted form, when its flow token was known. */
      form_id: string | null;
      /** Answers keyed by form field id. */
      answers: Record<string, string | number | boolean | string[]>;
      /** The readable summary shown in the inbox. */
      summary: string;
      /** First submission on a live session for this contact. */
      trusted: boolean;
      /** The run and send_form node the session was issued for, when trusted. */
      flow_run_id: string | null;
      node_key: string | null;
      meta_message_id: string;
    }
  | {
      kind: "order";
      /** The inbox text for the cart ("[Order] 2 × Shirt — ₹998.00"). */
      summary: string;
      /** order_id, order_total, order_currency, order_items_count, order_items. */
      vars: Record<string, string>;
      meta_message_id: string;
    };

export interface DispatchInboundInput {
  /** Account tenancy key. Drives the lookup of active flows and the
   *  idempotency check for previously-seen inbound message_ids. */
  accountId: string;
  /** Sender-of-record for the bot's outbound prompts on engine
   *  sends. Set by the webhook to the WhatsApp config owner. */
  userId: string;
  contactId: string;
  conversationId: string;
  message: ParsedInbound;
}

export interface DispatchInboundResult {
  /**
   * True iff the runner handled the message — it either advanced an
   * existing run or started a new one matching a flow trigger.
   * Webhook uses this to decide whether to also fire automations.
   */
  consumed: boolean;
  /** For diagnostics / logging — null when not consumed. */
  flow_run_id?: string;
  /** For diagnostics. */
  outcome?:
    | "advanced"
    | "started"
    | "completed"
    | "handed_off"
    | "fallback_fired"
    | "ai_fallback"
    | "duplicate_inbound_ignored"
    | "waiting"
    | "no_match";
}

// ============================================================
// Helpers — exhaustiveness assertions
// ============================================================

/**
 * Throws a typed compile-time error if the switch over a discriminated
 * union forgets a case. Used in the engine's node-type switch.
 */
export function assertNever(x: never): never {
  throw new Error(`Unhandled node type: ${JSON.stringify(x)}`);
}
