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
  /**
   * Instagram only (Stage 2): buttons that open a link (button template
   * `web_url`). They have no route: a link tap does not reach the webhook and
   * does not open the 24-hour window. `buttons` plus `link_buttons` stay within
   * 3 (INSTAGRAM_LIMITS.buttons). A WhatsApp flow never carries them.
   */
  link_buttons?: Array<{ title: string; url: string }>;
  /** Stage 5: link buttons go through a tracked /r/<token> link (lib/flows/link-tracking.ts). */
  track_clicks?: boolean;
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
 * Sends a single image / video / document / audio file, then
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
/** The file kinds a send_media node sends (`audio` from Stage 3). */
export const SEND_MEDIA_TYPES = ["image", "video", "document", "audio"] as const;
export type SendMediaType = (typeof SEND_MEDIA_TYPES)[number];

export interface SendMediaNodeConfig {
  /**
   * `audio` (Stage 3): on Instagram only AAC, M4A, MP4 and WAV files play
   * (nodeAvailableOn checks the file name); WhatsApp takes AAC, M4A, MP3 and
   * Ogg/Opus.
   */
  media_type: SendMediaType;
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
  /**
   * Stage 5: also write a valid answer to the contact (src/lib/contacts/field-write.ts).
   * `contact_field` keys are name/email/phone/company; `custom_field` keys are custom field ids.
   * A phone or email owned by another contact is not written (event `save_conflict`).
   */
  save_to?: FlowSaveTo;
  /** Stage 5: actions run once after a valid answer (same rules as the Actions step). */
  on_success_actions?: FlowAction[];
}

/** Where an Ask Question answer is also stored (Stage 5). */
export interface FlowSaveTo {
  target: "contact_field" | "custom_field";
  key: string;
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
  /**
   * Charge the run's order (vars.order_id, set by the order_received trigger)
   * instead of `amount`/`currency`: the link is attached to the order and asks
   * for what is still due. A server-priced order uses its own total; an
   * unpriced WhatsApp cart is refused (failed port) while store checkout is
   * enabled, so a Meta catalogue price is never charged.
   */
  link_order?: boolean;
  paid_next: string;
  expired_next?: string;
  failed_next?: string;
}

/**
 * Book appointment: offers free times as WhatsApp lists (service, then
 * practitioner when the customer chooses, then day, then time) and books the
 * time the customer taps (lib/appointments/booking, source 'flow', idempotent
 * per run, node and transition). Continues on `success_next` with
 * `appointment_id` and `appointment_local_time` in vars (never the manage
 * link); on `unavailable_next` when nothing can be booked or the replies run
 * out; on `cancelled_next` when the customer taps Cancel. An unwired
 * unavailable/cancelled port ends the run. May carry a reply timeout.
 * Engine: engine.ts (runAppointmentStep / handleAppointmentReply),
 * lib/flows/appointment-node.ts and appointment-runtime.ts.
 */
export interface BookAppointmentNodeConfig {
  /** appointment_services ids, at most 9; empty or absent offers every bookable service. */
  service_ids?: string[];
  /** Only services of this mode (the J2 online/offline choice); absent = both. */
  service_mode?: "online" | "offline";
  /** appointment_locations id; absent = the first location offering the chosen service. */
  location_id?: string;
  /** 'choose' lets the customer pick the practitioner; 'any' (default) books any free one. */
  staff_mode?: "any" | "choose";
  /** Days ahead to look for free times, 1–14 (default 7). */
  days_ahead?: number;
  success_next: string;
  unavailable_next?: string;
  cancelled_next?: string;
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

/**
 * `ig_profile` (Stage 2, Instagram flows only): a fact from the customer's
 * Instagram profile, re-read when the run reaches the condition (the follow
 * gate). `subject_key` is one of IG_PROFILE_FACTS; booleans compare with
 * `equals` "true"/"false" (or present/absent), the follower count numerically.
 */
export type ConditionSubject =
  | "var"
  | "tag"
  | "contact_field"
  | "custom_field"
  | "time"
  | "date"
  | "ig_profile"
  // Stage 5 (engine: 5B; until then the publish validator refuses them).
  /** One of SYSTEM_FACTS, in `subject_key`. */
  | "system"
  /** A saved segment id; `equals` "true" is in the segment, "false" is not. */
  | "segment"
  /** A node_key of this flow; `equals` "true" when the contact clicked a tracked link sent by that step. */
  | "link_click"
  /** A non-secret workspace attribute key. */
  | "workspace_field"
  /** A sequence id; `equals` "true" when the contact has an active subscription (5H). */
  | "sequence";

/** Every condition subject, in picker order. */
export const CONDITION_SUBJECTS = Object.keys({
  tag: true,
  contact_field: true,
  custom_field: true,
  var: true,
  time: true,
  date: true,
  ig_profile: true,
  system: true,
  segment: true,
  link_click: true,
  workspace_field: true,
  sequence: true,
} satisfies Record<ConditionSubject, true>) as ConditionSubject[];

/** The condition subjects added in Stage 5. */
export const STAGE5_CONDITION_SUBJECTS = ["system", "segment", "link_click", "workspace_field", "sequence"] as const satisfies readonly ConditionSubject[];

/** Instagram profile facts a condition can test (contact_channel_identities columns). */
export const IG_PROFILE_FACTS = ["follows_business", "business_follows", "is_verified", "follower_count", "in_window"] as const;
export type IgProfileFact = (typeof IG_PROFILE_FACTS)[number];

/**
 * System facts a `system` condition can test (Stage 5): the stored Instagram
 * username, the last inbound time, when the messaging window closes, whether the
 * contact is subscribed on the run's channel, and the contact id.
 */
export const SYSTEM_FACTS = ["ig_username", "last_interaction_at", "window_open_until", "subscribed", "contact_id"] as const;
export type SystemFact = (typeof SYSTEM_FACTS)[number];

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
 * AI reply: answers the customer with the workspace's AI agent (agent
 * profile + these instructions, grounded in the knowledge base when
 * `use_knowledge`), sent from the conversation's own number inside the
 * 24-hour window. A confident answer goes on through `next_node_key`
 * ("answered"); a low-confidence answer, a control phrase, a handoff
 * keyword or AI being unavailable goes through `handoff_next`. With
 * `max_turns` above 1 the step waits and answers follow-up messages
 * until that many answers were sent, then moves on; it may then carry a
 * reply timeout like the question steps. Engine: lib/ai/flow-reply.ts.
 */
export interface AiReplyNodeConfig {
  /** Extra operator instructions (<= 2000 chars) appended to the agent profile. Not interpolated. */
  instructions?: string;
  /** Ground the answer in the knowledge base. */
  use_knowledge?: boolean;
  /** Answers sent inside this step before it moves on (1-10, default 1). */
  max_turns?: number;
  /** Stores the latest answer in vars[var_key]. */
  var_key?: string;
  /** 0..1; defaults to the agent profile's threshold. */
  confidence_threshold?: number;
  /** "Answered" port. */
  next_node_key: string;
  /** "Handoff" port. */
  handoff_next: string;
  /**
   * Stage 5 (5G): up to AI_GOAL_LIMITS.goals ordered goals the step works
   * through (lib/ai/goals.ts runGoalTurn). With goals the step follows
   * `finish_next` once every goal is met or given up.
   */
  goals?: AiGoal[];
  /** Stage 5: "Goals finished" port; required when `goals` is set. */
  finish_next?: string;
  /** Stage 5 AI-step editor: the goal sentence the task list was drafted from (≤ 500 chars). */
  goal_text?: string;
  /** Stage 5 AI-step editor: the ordered task list (≤ AI_GOAL_LIMITS.tasks). */
  tasks?: AiTask[];
  /** Stage 5 AI-step editor: background the AI may use (≤ 2000 chars). Not interpolated. */
  context?: string;
}

/** Stage 5 AI goals. */
export const AI_GOAL_TYPES = ["share_link", "grow_followers", "capture_lead"] as const;
export type AiGoalType = (typeof AI_GOAL_TYPES)[number];

/** Contact fields a capture_lead goal may ask for; custom fields use `custom:<id>`. */
export const AI_LEAD_FIELDS = ["name", "email", "phone", "company"] as const;

export type AiGoal =
  /** Share a link once the person shows interest; `url` is http(s). */
  | { type: "share_link"; url: string; label?: string }
  /** Ask the person to follow the account; met when the stored follow fact is true. */
  | { type: "grow_followers" }
  /** Collect these fields; on refusal hand off to a person or continue the flow. */
  | { type: "capture_lead"; fields: string[]; on_refusal: "handoff" | "continue" };

/** One task of the AI step's task list; `save_to` stores the person's answer. */
export interface AiTask {
  text: string;
  save_to?: FlowSaveTo;
}

export const AI_GOAL_LIMITS = { goals: 3, tasks: 10, taskChars: 300, goalTextChars: 500, contextChars: 2000, leadFields: 5 } as const;

/** The Conversions API events a flow can report for a click-to-WhatsApp ad contact. */
export const CONVERSION_EVENT_NAMES = [
  "Purchase",
  "LeadSubmitted",
  "QualifiedLead",
  "InitiateCheckout",
  "AddToCart",
  "ViewContent",
] as const;
export type ConversionEventName = (typeof CONVERSION_EVENT_NAMES)[number];

/**
 * Report a conversion to Meta's Conversions API for the contact's latest
 * attributable ad click, then continue. The event is queued durably (one per
 * run and node, a loop revisit is a no-op) and sent by the worker; nothing is
 * queued while CAPI is off, and the node advances either way. Single `next`
 * port. Engine: lib/flows/conversion-node.ts.
 */
export interface ConversionEventNodeConfig {
  event_name: ConversionEventName;
  /** Run variable holding the value (a non-negative decimal <= 1e12); omitted when unset or invalid. */
  value_var?: string;
  /** ISO 4217 code (3 upper-case letters) for the value. */
  currency?: string;
  next_node_key: string;
}

/**
 * Send storefront link: issues a secure storefront link bound to the run's
 * contact (lib/commerce/storefront, design E12) and sends it as a text in
 * the 24-hour window. `shop` opens the store; `status` shows the contact's
 * latest order. The link itself is never stored in run variables. Continues
 * on `next_node_key` once sent; on `failed_next` when the store is off, the
 * contact has no order (status), or the send was refused. An unwired failed
 * port ends the run. Runtime: lib/flows/storefront-node.ts.
 */
export interface SendStorefrontLinkNodeConfig {
  /** Text sent above the link (≤ 1024 chars); may use {{vars.x}}. */
  message: string;
  /** Hours the link stays valid (1 – 168, default 24). */
  ttl_hours?: number;
  purpose: "shop" | "status";
  next_node_key: string;
  failed_next?: string;
}

export const STOREFRONT_LINK_LIMITS = { messageMax: 1024, ttlMinHours: 1, ttlMaxHours: 168, ttlDefaultHours: 24 } as const;

// ------------------------------------------------------------ Instagram nodes (Stage 2)
// Instagram-only steps. WHATSAPP_NODE_SUPPORT marks them 'no', so a WhatsApp
// flow can never place or run them. Their sizes are checked against
// INSTAGRAM_LIMITS (src/lib/instagram/graph-limits.ts) on publish and again by
// the graph client before any request.

/** A card button: opens a link (no route; it does not open the window) or posts back and routes. */
export type IgCardButton =
  | { type: "web_url"; title: string; url: string }
  | { type: "postback"; title: string; reply_id: string; next_node_key: string }
  /**
   * Stage 5 (5G): opens a checkout link for this amount (lib/flows/buy-button.ts,
   * one payment link per run, step and button slot). Needs the `payments`
   * capability; when no link can be made the button is dropped.
   */
  | { type: "buy"; title: string; amount_minor: number; currency: string };

/** One generic-template element: title (≤ 80), optional subtitle (≤ 80), https image and link, 0–3 buttons. */
export interface IgCard {
  title: string;
  subtitle?: string;
  image_url?: string;
  /** Opens when the card itself is tapped. */
  default_url?: string;
  buttons?: IgCardButton[];
}

/**
 * Public reply to the comment that started the run (POST /{comment-id}/replies).
 * One of `replies` is picked per comment (rotation); each is at most
 * INSTAGRAM_LIMITS.commentReplyChars. Sent once per comment (dispatch key
 * `ig-comment-reply:{commentId}`). Runs only in an ig_comment flow.
 */
export interface IgCommentReplyNodeConfig {
  /** 1–3 variants. */
  replies: string[];
  next_node_key: string;
}

/**
 * The first message of a comment-started run, sent as a private reply
 * (recipient: { comment_id }) through the instagram.private_reply job: one
 * per comment, within 7 days of it. No input, typing delay or second message
 * may sit in this node (the publish validator refuses them). With
 * `opt_in_label` the message carries one quick reply (the "Opening DM"
 * button) and the run waits for that tap, which opens the 24-hour window;
 * without it the run continues at once. May carry a reply timeout
 * (`after_timeout` port) like the other waiting steps.
 */
export interface IgPrivateReplyNodeConfig {
  /** ≤ 1000 UTF-8 bytes; may use {{vars.x}}. */
  text: string;
  /** Quick-reply title (≤ 20 characters). */
  opt_in_label?: string;
  next_node_key: string;
}

/** One card (generic template), then auto-advance. Postback buttons route like send_buttons. */
export interface SendCardNodeConfig {
  card: IgCard;
  next_node_key: string;
  /** Stage 5: link buttons go through a tracked /r/<token> link (lib/flows/link-tracking.ts). */
  track_clicks?: boolean;
}

/** A gallery: 1–10 cards in one horizontally scrolling message, then auto-advance. */
export interface SendGalleryNodeConfig {
  cards: IgCard[];
  next_node_key: string;
  /** Stage 5: as on send_card. */
  track_clicks?: boolean;
}

// ------------------------------------------------------------ Stage 5 steps
// Registered in 5A; the engine runs them from 5B. Until then a run reaching
// one ends with reason `not_implemented` and the publish validator refuses them.

/** Every action an Actions step can run (Stage 5). */
export const FLOW_ACTION_TYPES = [
  "add_tag",
  "remove_tag",
  "set_field",
  "set_workspace_field",
  "set_channel_consent",
  "subscribe_sequence",
  "unsubscribe_sequence",
  "start_flow",
  "stop_flow",
  "pause_automations",
  "resume_automations",
  "log_conversion",
  "set_conversation_status",
  "notify_team",
] as const;
export type FlowActionType = (typeof FLOW_ACTION_TYPES)[number];

/** The picker group of each action (the "+ Action" menu). */
export const FLOW_ACTION_GROUPS = {
  add_tag: "contact",
  remove_tag: "contact",
  set_field: "contact",
  set_channel_consent: "contact",
  set_workspace_field: "automation",
  subscribe_sequence: "automation",
  unsubscribe_sequence: "automation",
  start_flow: "automation",
  stop_flow: "automation",
  pause_automations: "automation",
  resume_automations: "automation",
  set_conversation_status: "inbox",
  notify_team: "inbox",
  log_conversion: "ads",
} as const satisfies Record<FlowActionType, "contact" | "automation" | "inbox" | "ads">;
export type FlowActionGroup = (typeof FLOW_ACTION_GROUPS)[FlowActionType];

/**
 * One action. Each is idempotent per run, node and position (the engine keeps a
 * cursor in the run so a retry resumes at the failed action).
 */
export type FlowAction =
  | { type: "add_tag"; tag_id: string }
  | { type: "remove_tag"; tag_id: string }
  /** `contact_field` keys: name/email/phone/company; `custom_field` keys: custom field ids. Value may use placeholders. */
  | { type: "set_field"; target: "contact_field" | "custom_field"; key: string; value: string }
  /** A non-secret workspace attribute; `increment` adds a number in one atomic UPDATE. */
  | { type: "set_workspace_field"; key: string; mode: "set" | "increment"; value: string }
  | { type: "set_channel_consent"; channel: "instagram"; state: "opted_in" | "opted_out" }
  | { type: "subscribe_sequence"; sequence_id: string }
  | { type: "unsubscribe_sequence"; sequence_id: string }
  /** Queues another active flow for the contact; this run carries on. Never this flow. */
  | { type: "start_flow"; flow_id: string }
  /** Ends the contact's waiting runs of that flow (reason `stopped_by_flow`). Never this flow. */
  | { type: "stop_flow"; flow_id: string }
  /** `minutes` null pauses until resumed. */
  | { type: "pause_automations"; minutes: number | null }
  | { type: "resume_automations" }
  | { type: "log_conversion"; event_type_id: string }
  | { type: "set_conversation_status"; status: "open" | "closed" }
  /** An in-app notice: fixed text plus the author's note, never the customer's message. */
  | { type: "notify_team"; target: "assignee" | "admins"; note?: string };

/** Pause lengths an action or the inbox may choose, in minutes (null = until resumed). */
export const PAUSE_MINUTES_CHOICES = [30, 60, 180, 360, 720, 1440, null] as const;

/** Runs `actions` in order and continues; sends no message. */
export interface ActionsNodeConfig {
  actions: FlowAction[];
  next_node_key: string;
}

/** One randomizer path: `weight` percent of contacts go to `next_node_key`. */
export interface RandomizerPath {
  /** Stable id (A, B, …); the pick is stored by id. */
  id: string;
  weight: number;
  next_node_key: string;
}

/**
 * Splits traffic over 2–6 paths whose weights total 100. `sticky` keeps a
 * contact on the same path (hash of contact id and node key); otherwise the
 * pick is written to the run before advancing so a replay follows it.
 */
export interface RandomizerNodeConfig {
  paths: RandomizerPath[];
  sticky: boolean;
}

export type SmartDelayUnit = "seconds" | "minutes" | "hours" | "days";

/** Allowed send hours (HH:MM, `to` may be before `from` to cross midnight) and weekdays (0 = Sunday). */
export interface SendWindow {
  from: string;
  to: string;
  weekdays: number[];
}

/**
 * Waits, then continues (durable `flow.timer`). `duration`: `amount` `unit`
 * (or the number in custom field `amount_field_id`), at most
 * FLOW_STEP_LIMITS.smartDelayMaxDays. `until_date`: a fixed `date` (ISO) or the
 * date in custom field `date_field_id`, plus `offset_minutes`; the run stops
 * there when that date has already passed. `send_window` moves the wake time to
 * the next allowed hour and weekday in `timezone` (default: the workspace's).
 * On Instagram the send after the wait still needs an open window.
 */
export interface SmartDelayNodeConfig {
  mode: "duration" | "until_date";
  amount?: number;
  unit?: SmartDelayUnit;
  amount_field_id?: string;
  date?: string;
  date_field_id?: string;
  offset_minutes?: number;
  send_window?: SendWindow;
  timezone?: string;
  next_node_key: string;
}

/** A column and the value (may use placeholders) written to it. */
export interface SheetColumnValue {
  column: string;
  value: string;
}

/**
 * Google Sheets (5G, behind GOOGLE_SHEETS_ENABLED and the `sheets`
 * capability): insert a row, get the row whose `match.column` equals
 * `match.value` (mapping columns to run variables with `var_map`), or update
 * that row. An unknown outcome is never retried: it follows `failure_next`.
 */
export interface GoogleSheetsNodeConfig {
  op: "insert_row" | "get_row" | "update_row";
  spreadsheet_id: string;
  sheet: string;
  match?: SheetColumnValue;
  columns: SheetColumnValue[];
  var_map?: Array<{ column: string; var_key: string }>;
  next_node_key: string;
  failure_next: string;
}

export const FLOW_STEP_LIMITS = {
  actionsMin: 1,
  actionsMax: 10,
  notifyNoteChars: 500,
  randomizerPathsMin: 2,
  randomizerPathsMax: 6,
  smartDelayMaxDays: 365,
  sheetColumns: 26,
} as const;

/** The node types added in Stage 5. */
export const STAGE5_NODE_TYPES = ["actions", "randomizer", "smart_delay", "google_sheets"] as const;

/**
 * A sticky note on the canvas (Stage 5): free text, no ports, never run.
 * Stored in flows.canvas_notes; templates may ship with notes.
 */
export interface CanvasNote {
  id: string;
  text: string;
  x: number;
  y: number;
}

export const CANVAS_NOTE_LIMITS = { notes: 30, chars: 1000 } as const;

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
  | { node_type: "book_appointment"; config: BookAppointmentNodeConfig }
  | { node_type: "ai_reply"; config: AiReplyNodeConfig }
  | { node_type: "conversion_event"; config: ConversionEventNodeConfig }
  | { node_type: "send_storefront_link"; config: SendStorefrontLinkNodeConfig }
  | { node_type: "send_template"; config: SendTemplateNodeConfig }
  | { node_type: "api_request"; config: ApiRequestNodeConfig }
  | { node_type: "connect_flow"; config: ConnectFlowNodeConfig }
  | { node_type: "assign_agent"; config: AssignAgentNodeConfig }
  | { node_type: "ig_comment_reply"; config: IgCommentReplyNodeConfig }
  | { node_type: "ig_private_reply"; config: IgPrivateReplyNodeConfig }
  | { node_type: "send_card"; config: SendCardNodeConfig }
  | { node_type: "send_gallery"; config: SendGalleryNodeConfig }
  | { node_type: "actions"; config: ActionsNodeConfig }
  | { node_type: "randomizer"; config: RandomizerNodeConfig }
  | { node_type: "smart_delay"; config: SmartDelayNodeConfig }
  | { node_type: "google_sheets"; config: GoogleSheetsNodeConfig }
  | { node_type: "handoff"; config: HandoffNodeConfig }
  | { node_type: "end"; config: EndNodeConfig };

export type FlowNodeType = FlowNodeConfig["node_type"];

/** The Instagram-only node types (Stage 2). */
export const INSTAGRAM_ONLY_NODE_TYPES = ["ig_comment_reply", "ig_private_reply", "send_card", "send_gallery"] as const satisfies readonly FlowNodeType[];

// ============================================================
// Triggers (matches `flows.trigger_type` + `trigger_config`)
// ============================================================

export interface KeywordTriggerConfig {
  /** One or more keywords. Match is case-insensitive by default. */
  keywords: string[];
  /**
   * `regex` tests `pattern` against the message instead of the keywords.
   * `intent` (Stage 5, needs AI) asks lib/ai/intent-match.ts whether the
   * message means `intent`; it is tried only after every exact trigger failed
   * and before default_reply.
   */
  match_type?: "exact" | "contains" | "regex" | "intent";
  /** The meaning to recognise for `match_type: "intent"` (≤ FLOW_TRIGGER_LIMITS.intentChars). */
  intent?: string;
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

/**
 * Starts the flow when a conversation message carries a click-to-WhatsApp ad
 * referral. `ad_ids` (Meta ad ids, digits, at most 50) limits it to those
 * ads; empty or absent means any ad. The run gets `ad_id`, `ad_headline` and
 * `ad_source_url` variables (never the click id).
 */
export interface AdClickTriggerConfig {
  ad_ids?: string[];
}

// ------------------------------------------------------------ Stage 2 triggers
// Instagram triggers (ig_*) run only in Instagram flows; default_reply runs on
// both channels. FLOW_TRIGGERS_BY_CHANNEL (src/lib/channels/capabilities.ts)
// places every trigger type in its channel palettes, checked at compile time.

/** How a keyword list matches: anywhere in the text, or the whole text (case-insensitive, trimmed). */
export type IgKeywordMode = "contains" | "exact";

/** Which posts a comment trigger listens on. */
export type IgPostScope = "any" | "specific" | "next";

/**
 * A comment on a post. Fires on a person's first comment per post only.
 * - `post_scope`: `any` post; `specific` posts (`media_ids`); or the `next`
 *   post published after `next_after`, resolved on its first comment and kept
 *   in `resolved_media_id`.
 * - `include_keywords`: empty or absent matches any comment; `exclude_keywords`
 *   wins over a match. Each list has its own mode.
 * - `public_replies`: 0–3 variants; one is posted under the comment (rotated).
 */
export interface IgCommentTriggerConfig {
  /** instagram_accounts.id; absent listens on every connected account of the workspace. */
  instagram_account_id?: string;
  post_scope: IgPostScope;
  /** Instagram media ids (digits), at most IG_TRIGGER_LIMITS.mediaIds; `specific` only. */
  media_ids?: string[];
  /** ISO time the "next post" choice was made; `next` only. */
  next_after?: string;
  /** The post `next` resolved to (set by the engine on that post's first comment). */
  resolved_media_id?: string;
  include_keywords?: string[];
  include_mode?: IgKeywordMode;
  exclude_keywords?: string[];
  exclude_mode?: IgKeywordMode;
  public_replies?: string[];
  /** Stage 5: hold the first step this long (0 – FLOW_TRIGGER_LIMITS.replyDelaySecondsMax), via flow.timer. */
  reply_delay_seconds?: number;
}

/**
 * A reply to one of the account's stories. `story_ids` empty or absent means
 * any story. `keywords` empty or absent matches any reply; `reactions`
 * also starts the flow on an emoji reaction to the story.
 */
export interface IgStoryReplyTriggerConfig {
  instagram_account_id?: string;
  story_ids?: string[];
  keywords?: string[];
  match_mode?: IgKeywordMode;
  reactions?: boolean;
}

/** How often a contact may start a once-limited trigger. */
export type TriggerFrequency = "every_time" | "once_per_24h";

/** A person mentions the account in their story (needs live capture: story_mention payload). */
export interface IgStoryMentionTriggerConfig {
  instagram_account_id?: string;
  frequency: TriggerFrequency;
}

/**
 * Runs when an inbound message started no other flow and no run is waiting
 * (the channel's default reply). One per channel section; `frequency` limits
 * it per contact.
 */
export interface DefaultReplyTriggerConfig {
  frequency: TriggerFrequency;
}

// ------------------------------------------------------------ Stage 3 triggers

/**
 * A comment on the account's Instagram Live broadcast (the `live_comments`
 * webhook, which Meta sends only while the broadcast is live). Fires on a
 * person's first matching comment per broadcast. `keywords` empty or absent
 * matches any comment. As with ig_comment, the run's first message is a
 * private reply to the comment (ig_private_reply) and Meta allows nothing
 * else until the person answers. Needs live capture: built against Meta's
 * documented live_comments payload.
 */
export interface IgLiveCommentTriggerConfig {
  /** instagram_accounts.id; absent listens on every connected account of the workspace. */
  instagram_account_id?: string;
  keywords?: string[];
  match_mode?: IgKeywordMode;
  /** Stage 5: as on ig_comment. */
  reply_delay_seconds?: number;
}

/**
 * Someone opens a chat from a ref link (`https://ig.me/m/<username>?ref=<key>`,
 * src/lib/instagram/ref-links.ts). `refs` lists the keys that start this flow:
 * 1 to IG_TRIGGER_LIMITS.refs, each matching IG_REF_KEY, compared without
 * case. The key is also kept on the contact's Instagram identity (last_ref).
 * Needs live capture: the referral payload on an Instagram Login app.
 */
export interface IgRefTriggerConfig {
  instagram_account_id?: string;
  refs: string[];
}

// ------------------------------------------------------------ Stage 4 triggers

/**
 * Someone shares one of the account's posts or reels to their story (Stage 4).
 * Starts the flow like a story mention: `frequency` limits how often one
 * person starts it. Meta may not deliver this event to Instagram Login apps, so
 * the trigger exists only while INSTAGRAM_SHARE_TO_STORY_ENABLED is on (and
 * INSTAGRAM_ENABLED); it is built against a documented fixture and needs live
 * capture before the flag is turned on.
 */
export interface IgShareToStoryTriggerConfig {
  instagram_account_id?: string;
  frequency: TriggerFrequency;
}

/** Sizes the trigger editors and the validator enforce. */
export const IG_TRIGGER_LIMITS = {
  mediaIds: 50,
  storyIds: 50,
  keywords: 50,
  keywordChars: 100,
  publicReplies: 3,
  /** Ref keys per ig_ref trigger (Stage 3). */
  refs: 20,
} as const;

export type FlowTriggerConfig =
  | { trigger_type: "order_received"; config: OrderReceivedTriggerConfig }
  | { trigger_type: "keyword"; config: KeywordTriggerConfig }
  | { trigger_type: "first_inbound_message"; config: FirstInboundTriggerConfig }
  | { trigger_type: "manual"; config: Record<string, never> }
  | { trigger_type: "template_reply"; config: TemplateReplyTriggerConfig }
  | { trigger_type: "ad_click"; config: AdClickTriggerConfig }
  | { trigger_type: "default_reply"; config: DefaultReplyTriggerConfig }
  | { trigger_type: "ig_comment"; config: IgCommentTriggerConfig }
  | { trigger_type: "ig_story_reply"; config: IgStoryReplyTriggerConfig }
  | { trigger_type: "ig_story_mention"; config: IgStoryMentionTriggerConfig }
  | { trigger_type: "ig_live_comment"; config: IgLiveCommentTriggerConfig }
  | { trigger_type: "ig_ref"; config: IgRefTriggerConfig }
  | { trigger_type: "ig_share_to_story"; config: IgShareToStoryTriggerConfig };

export type FlowTriggerType = FlowTriggerConfig["trigger_type"];

/** Every trigger type, in palette order. The record makes adding a type to the union a compile error until it is listed. */
export const FLOW_TRIGGER_TYPES = Object.keys({
  keyword: true,
  first_inbound_message: true,
  manual: true,
  template_reply: true,
  order_received: true,
  ad_click: true,
  default_reply: true,
  ig_comment: true,
  ig_story_reply: true,
  ig_story_mention: true,
  ig_live_comment: true,
  ig_ref: true,
  ig_share_to_story: true,
} satisfies Record<FlowTriggerType, true>) as FlowTriggerType[];

/**
 * Triggers started by a comment (on a post, or on a Live broadcast, Stage 3):
 * the run's first message is a private reply to that comment (ig_private_reply,
 * one per comment) and nothing may message the person before it. The public
 * comment reply step (ig_comment_reply) stays ig_comment only: Live comments
 * get no public reply. The builder and the publish validator read this list.
 */
export const PRIVATE_REPLY_TRIGGERS = ["ig_comment", "ig_live_comment"] as const satisfies readonly FlowTriggerType[];

export function startsFromComment(trigger: FlowTriggerType | string | null | undefined): boolean {
  return (PRIVATE_REPLY_TRIGGERS as readonly string[]).includes(trigger ?? "");
}

// ------------------------------------------------------------ Stage 5 triggers

/** Sizes for Stage 5 trigger features. */
export const FLOW_TRIGGER_LIMITS = {
  /** `flows.extra_triggers` entries (so at most 5 triggers in total). */
  extraTriggers: 4,
  /** `flows.test_usernames` entries. */
  testUsernames: 3,
  /** ig_comment / ig_live_comment `reply_delay_seconds`. */
  replyDelaySecondsMax: 600,
  /** Keyword trigger `intent` sentence. */
  intentChars: 300,
} as const;

/**
 * Triggers that may be combined on one flow (Stage 5): an Instagram flow may
 * add up to FLOW_TRIGGER_LIMITS.extraTriggers of these to its primary trigger,
 * which must be one of them too. default_reply, manual and WhatsApp or `any`
 * scope flows keep exactly one trigger.
 */
export const COMBINABLE_TRIGGERS = [
  "keyword",
  "ig_comment",
  "ig_live_comment",
  "ig_story_reply",
  "ig_story_mention",
  "ig_ref",
  "ad_click",
] as const satisfies readonly FlowTriggerType[];
export type CombinableTriggerType = (typeof COMBINABLE_TRIGGERS)[number];

export function isCombinableTrigger(trigger: unknown): trigger is CombinableTriggerType {
  return typeof trigger === "string" && (COMBINABLE_TRIGGERS as readonly string[]).includes(trigger);
}

/** An Instagram username as stored for test runs: lowercase, no `@`, 1–30 of [a-z0-9._]. */
export const IG_TEST_USERNAME = /^[a-z0-9._]{1,30}$/;

// ------------------------------------------------------------ Template metadata (Stage 5, amendment 4)

/** Gallery filters "By goal". */
export const TEMPLATE_GOALS = ["grow_followers", "engage_audience", "drive_traffic"] as const;
export type TemplateGoal = (typeof TEMPLATE_GOALS)[number];

/** Gallery filters "By trigger"; null for a template that ships without a trigger. */
export const TEMPLATE_TRIGGERS = ["post_comment", "dm", "story_reply", "live_comment"] as const;
export type TemplateTrigger = (typeof TEMPLATE_TRIGGERS)[number];

/** What the gallery shows about a template before install. */
export interface FlowTemplateMeta {
  goals: TemplateGoal[];
  trigger: TemplateTrigger | null;
  /** `quick`: a form-page quick automation; `flow`: opens on the canvas. */
  kind: "quick" | "flow";
  level: "beginner" | "advanced";
  uses_ai: boolean;
  needs_payments: boolean;
  /** Shown in the Recommended row. */
  recommended?: boolean;
}

// ============================================================
// DB-row shapes (read by the engine via databaseAdmin)
// ============================================================

/** Which channels a flow runs on (flows.channel_scope, Phase 11). Existing flows are 'whatsapp'. */
export type FlowChannelScope = "whatsapp" | "instagram" | "any";
export const FLOW_CHANNEL_SCOPES: readonly FlowChannelScope[] = ["whatsapp", "instagram", "any"];
/**
 * Scopes a new flow may get (Stage 1): each flow belongs to one channel's
 * section. 'any' stays legal in the database for legacy flows, which keep
 * running on both channels until the user splits them.
 */
export const CREATABLE_CHANNEL_SCOPES: readonly Exclude<FlowChannelScope, "any">[] = ["whatsapp", "instagram"];

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
  /** `paused` (Phase 12): no new enrollments; pinned runs finish on their version. */
  status: "draft" | "active" | "paused" | "archived";
  trigger_type: FlowTriggerType;
  trigger_config: KeywordTriggerConfig | FirstInboundTriggerConfig | TemplateReplyTriggerConfig | AdClickTriggerConfig
    | DefaultReplyTriggerConfig | IgCommentTriggerConfig | IgStoryReplyTriggerConfig | IgStoryMentionTriggerConfig
    | IgLiveCommentTriggerConfig | IgRefTriggerConfig | Record<string, unknown>;
  entry_node_id: string | null;
  fallback_policy: FlowFallbackPolicy;
  /** While the flow is a draft it runs only for these numbers (digits, up to 3). */
  test_numbers?: string[];
  /** The WhatsApp number (whatsapp_config.id) the flow listens on; null listens on every number. */
  whatsapp_config_id?: string | null;
  /** Channels the flow runs on; absent (rows read before Phase 11) means 'whatsapp'. */
  channel_scope?: FlowChannelScope;
  /** The live flow_versions row (Phase 12); null until first published. Absent on rows read before Phase 12. */
  published_version_id?: string | null;
  /**
   * Stage 5: further triggers that also start the flow (COMBINABLE_TRIGGERS,
   * Instagram flows only, at most FLOW_TRIGGER_LIMITS.extraTriggers). Absent or
   * empty: the primary trigger only, as before. Read through effectiveTriggers().
   */
  extra_triggers?: FlowTriggerConfig[];
  /** Stage 5: while an Instagram flow is a draft it runs only for these usernames (lowercase, no @, up to 3). */
  test_usernames?: string[];
  /** Stage 5: the flow_folders row the flow is filed in; null is the top level. */
  folder_id?: string | null;
  /** Stage 5: sticky notes on the canvas (never run). */
  canvas_notes?: CanvasNote[];
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
  /**
   * The flow version the run is pinned to (Phase 12). Null for draft
   * test-number runs and runs started before the flow was versioned; those
   * run on the live draft. Optional so rows and fixtures built before Phase
   * 12 still type-check; the engine treats absent as null.
   */
  flow_version_id?: string | null;
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
 * The ad or link summary carried with an inbound message: a click-to-WhatsApp
 * ad (from ad_referrals, via the inbound-actions job payload) and, from Stage
 * 3, an Instagram click-to-Direct ad or ref link. Never the click id.
 */
export interface ParsedInboundReferral {
  source_id: string | null;
  /** `link` (Stage 3): an ig.me ref link, not an ad. */
  source_type: "ad" | "post" | "link" | "unknown";
  headline: string | null;
  source_url: string | null;
  /**
   * The ref key the chat was opened with (Stage 3: Instagram ref links, and
   * ads that carry one), already passed through normalizeInboundRef
   * (src/lib/instagram/ref-links.ts). Absent when there was none.
   */
  ref?: string;
}

/**
 * Normalised view of an inbound message that the runner needs. The
 * webhook lifts this out of the raw Meta payload before invoking the
 * runner; keeps the runner free of any WhatsApp-API specifics.
 */
export type ParsedInbound = (
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
    }
) & {
  /** Present when the message started from a click-to-WhatsApp ad or post. */
  referral?: ParsedInboundReferral;
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
