// What each channel can do (Phase 11, Stage 1). Pure: no I/O, safe to import
// from client components. Flow publish (validate.ts), the runtime engine
// guard, the flow editor, the automation builder and validator and the
// Instagram composer all read this one registry: the per-channel trigger,
// node, automation-trigger and automation-step palettes live only here.
import type { FlowChannelScope, FlowNodeType, FlowTriggerConfig } from '@/lib/flows/types';
import type { AutomationStepType, AutomationTriggerType, Channel } from '@/types';
import { INSTAGRAM_LIMITS, quickRepliesFit, utf8Bytes } from '@/lib/instagram/graph-limits';

export type { Channel };
export const CHANNELS: readonly Channel[] = ['whatsapp', 'instagram'];

export function isChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (CHANNELS as readonly string[]).includes(value);
}

/** Does a flow with this scope run on this channel? Absent scope (pre-Phase 11 rows) is WhatsApp. */
export function scopeIncludes(scope: FlowChannelScope | null | undefined, channel: Channel): boolean {
  const s = scope ?? 'whatsapp';
  return s === 'any' || s === channel;
}

/** The channels a scope covers. */
export function scopeChannels(scope: FlowChannelScope | null | undefined): Channel[] {
  return CHANNELS.filter((c) => scopeIncludes(scope, c));
}

/** 'yes': runs as on WhatsApp; 'conditional': runs only when its config fits; 'no': unavailable. */
export type NodeSupport = 'yes' | 'conditional' | 'no';

/** Instagram support per flow node (design section 8; Stage 2 adds the Instagram-only steps and opens ai_reply). */
export const INSTAGRAM_NODE_SUPPORT: Record<FlowNodeType, NodeSupport> = {
  start: 'yes',
  send_message: 'yes',
  send_media: 'conditional',
  send_buttons: 'yes',
  send_list: 'conditional',
  collect_input: 'yes',
  ask_media: 'yes',
  ask_location: 'no',
  ask_address: 'no',
  send_template: 'no',
  send_form: 'no',
  send_product: 'no',
  send_product_list: 'no',
  send_catalog: 'no',
  send_storefront_link: 'yes',
  payment_link: 'yes',
  book_appointment: 'no',
  // Stage 4: Conversions API events from Instagram flows. The step sends no message (needsMessagingWindow
  // already skips it) and queues the event for the contact's latest attributable click-to-Direct ad.
  conversion_event: 'yes',
  // Stage 2 (plan item 9): the AI step answers inside the 24-hour window.
  ai_reply: 'yes',
  condition: 'yes',
  set_tag: 'yes',
  set_attribute: 'yes',
  api_request: 'yes',
  connect_flow: 'yes',
  assign_agent: 'yes',
  // Stage 2 Instagram-only steps.
  ig_comment_reply: 'yes',
  ig_private_reply: 'yes',
  send_card: 'yes',
  send_gallery: 'yes',
  // Stage 5 logic steps: they send nothing themselves; a send after a smart delay re-checks the window.
  actions: 'yes',
  randomizer: 'yes',
  smart_delay: 'yes',
  google_sheets: 'yes',
  handoff: 'yes',
  end: 'yes',
};

/**
 * WhatsApp support per flow node. Every node that existed before Stage 2 runs
 * on WhatsApp (send_buttons is WhatsApp's reply-button message; its
 * Instagram-only `link_buttons` are for the validator to refuse). The
 * Instagram-only steps (comment reply, private reply, card, gallery) are 'no',
 * so a WhatsApp flow can never place or run them.
 */
export const WHATSAPP_NODE_SUPPORT: Record<FlowNodeType, NodeSupport> = {
  start: 'yes',
  send_message: 'yes',
  send_media: 'yes',
  send_buttons: 'yes',
  send_list: 'yes',
  collect_input: 'yes',
  ask_media: 'yes',
  ask_location: 'yes',
  ask_address: 'yes',
  send_template: 'yes',
  send_form: 'yes',
  send_product: 'yes',
  send_product_list: 'yes',
  send_catalog: 'yes',
  send_storefront_link: 'yes',
  payment_link: 'yes',
  book_appointment: 'yes',
  conversion_event: 'yes',
  ai_reply: 'yes',
  condition: 'yes',
  set_tag: 'yes',
  set_attribute: 'yes',
  api_request: 'yes',
  connect_flow: 'yes',
  assign_agent: 'yes',
  // Instagram-only: comment replies, private replies and generic-template cards.
  ig_comment_reply: 'no',
  ig_private_reply: 'no',
  send_card: 'no',
  send_gallery: 'no',
  // Stage 5 logic steps run on both channels.
  actions: 'yes',
  randomizer: 'yes',
  smart_delay: 'yes',
  google_sheets: 'yes',
  handoff: 'yes',
  end: 'yes',
};

const NODE_SUPPORT: Record<Channel, Record<FlowNodeType, NodeSupport>> = {
  whatsapp: WHATSAPP_NODE_SUPPORT,
  instagram: INSTAGRAM_NODE_SUPPORT,
};

/** The flow nodes a channel's builder offers ('conditional' ones too: their config decides at publish). */
export function flowNodesFor(channel: Channel): FlowNodeType[] {
  const support = NODE_SUPPORT[channel];
  return (Object.keys(support) as FlowNodeType[]).filter((node) => support[node] !== 'no');
}

export type NodeAvailability = { ok: true; warning?: 'text_over_limit' } | { ok: false; reason: 'unavailable_on_channel' };

/** send_media node types Instagram can carry (a document only as a PDF, audio only in a format it plays). */
const MEDIA_TYPES_ON_INSTAGRAM = new Set(['image', 'video', 'document', 'audio']);

/**
 * Audio files Instagram plays, by file extension: AAC, M4A, MP4 and WAV
 * (the composer's INSTAGRAM_AUDIO_MIME below). MP3, Ogg/Opus (the WhatsApp
 * voice note) and WebM are refused.
 */
export const INSTAGRAM_AUDIO_FILE = /\.(aac|m4a|mp4|wav)(?:$|[?#])/i;

/**
 * Audio files WhatsApp sends, by file extension: AAC, AMR, MP3, M4A/MP4 and
 * Ogg (Opus). Meta refuses WAV, WebM and bare .opus files at send time, which
 * would end the run as send_media_failed, so publish refuses them first.
 */
export const WHATSAPP_AUDIO_FILE = /\.(aac|amr|mp3|m4a|mp4|ogg)(?:$|[?#])/i;

/** A send_media config's file name and URL, whichever are strings. */
const mediaNames = (config: Record<string, unknown>): string[] =>
  [config.filename, config.media_url].filter((v): v is string => typeof v === 'string');

const textOf = (config: Record<string, unknown>): string | null => {
  for (const key of ['text', 'body', 'message']) if (typeof config[key] === 'string') return config[key] as string;
  return null;
};

/**
 * Whether a node may run on a channel. For a conditional Instagram node the
 * config decides: media must be an image, a video, a PDF document or an
 * AAC/M4A/MP4/WAV audio file (the file name or URL shows which); a list must
 * fit Instagram quick replies. Text over 1000 bytes is a warning (variables
 * may shorten it), not a refusal; the send path refuses it. On WhatsApp only
 * an audio step is checked (WHATSAPP_AUDIO_FILE).
 */
export function nodeAvailableOn(nodeType: FlowNodeType, channel: Channel,
  config: Record<string, unknown> = {}): NodeAvailability {
  if (channel === 'whatsapp') {
    if (WHATSAPP_NODE_SUPPORT[nodeType] === 'no') return { ok: false, reason: 'unavailable_on_channel' };
    // Stage 3 audio: only a format WhatsApp sends. The other media types are unchanged.
    if (nodeType === 'send_media' && config.media_type === 'audio' && !mediaNames(config).some((name) => WHATSAPP_AUDIO_FILE.test(name)))
      return { ok: false, reason: 'unavailable_on_channel' };
    return { ok: true };
  }
  const support = INSTAGRAM_NODE_SUPPORT[nodeType] ?? 'no';
  if (support === 'no') return { ok: false, reason: 'unavailable_on_channel' };
  if (nodeType === 'send_media') {
    const mediaType = typeof config.media_type === 'string' ? config.media_type : null;
    if (!mediaType || !MEDIA_TYPES_ON_INSTAGRAM.has(mediaType)) return { ok: false, reason: 'unavailable_on_channel' };
    const names = mediaNames(config);
    if (mediaType === 'document' && !names.some((name) => /\.pdf(?:$|[?#])/i.test(name)))
      return { ok: false, reason: 'unavailable_on_channel' };
    if (mediaType === 'audio' && !names.some((name) => INSTAGRAM_AUDIO_FILE.test(name)))
      return { ok: false, reason: 'unavailable_on_channel' };
  }
  if (nodeType === 'send_list' && !listFitsQuickReplies(config)) return { ok: false, reason: 'unavailable_on_channel' };
  const text = textOf(config);
  if (text && utf8Bytes(text) > INSTAGRAM_LIMITS.textBytes) return { ok: true, warning: 'text_over_limit' };
  return { ok: true };
}

/** A send_list node's rows as quick replies, when they fit. */
export function listFitsQuickReplies(config: Record<string, unknown>): boolean {
  const sections = Array.isArray(config.sections) ? config.sections : [];
  const rows = sections.flatMap((section) => {
    const list = (section as { rows?: unknown })?.rows;
    return Array.isArray(list) ? list : [];
  }) as { reply_id?: unknown; title?: unknown }[];
  return quickRepliesFit(rows.map((row) => ({
    title: typeof row.title === 'string' ? row.title : '',
    payload: typeof row.reply_id === 'string' ? row.reply_id : '',
  })));
}

type TriggerType = FlowTriggerConfig['trigger_type'];

/**
 * The channels each flow trigger runs on, in palette order. `satisfies`
 * makes this exhaustive at compile time: a trigger type added to
 * FlowTriggerConfig fails the build until it is placed here, and a key that is
 * not a trigger type fails too. A flow with scope 'any' must use a trigger
 * both channels offer. Stage 3 opens ad_click on Instagram (click-to-Direct
 * ads) and adds the Instagram Live comment and ref link triggers.
 */
const FLOW_TRIGGER_CHANNELS = {
  keyword: ['whatsapp', 'instagram'],
  first_inbound_message: ['whatsapp', 'instagram'],
  manual: ['whatsapp', 'instagram'],
  template_reply: ['whatsapp'],
  order_received: ['whatsapp'],
  ad_click: ['whatsapp', 'instagram'],
  default_reply: ['whatsapp', 'instagram'],
  ig_comment: ['instagram'],
  ig_story_reply: ['instagram'],
  ig_story_mention: ['instagram'],
  ig_live_comment: ['instagram'],
  ig_ref: ['instagram'],
  // Stage 4: only while INSTAGRAM_SHARE_TO_STORY_ENABLED is on (the picker hides it and the webhook path ignores it while off; this map is pure and a flag-off flow is stored but never fires).
  ig_share_to_story: ['instagram'],
} as const satisfies Record<TriggerType, readonly Channel[]>;

const triggersOn = (channel: Channel): readonly TriggerType[] =>
  (Object.keys(FLOW_TRIGGER_CHANNELS) as TriggerType[])
    .filter((trigger) => (FLOW_TRIGGER_CHANNELS[trigger] as readonly Channel[]).includes(channel));

/** The flow triggers each channel offers (derived from the exhaustive map above). */
export const FLOW_TRIGGERS_BY_CHANNEL: Record<Channel, readonly TriggerType[]> = {
  whatsapp: triggersOn('whatsapp'),
  instagram: triggersOn('instagram'),
};

export function flowTriggersFor(channel: Channel): readonly TriggerType[] {
  return FLOW_TRIGGERS_BY_CHANNEL[channel];
}

export function triggerAvailableOn(triggerType: TriggerType, channel: Channel): boolean {
  return FLOW_TRIGGERS_BY_CHANNEL[channel].includes(triggerType);
}

// Every automation trigger and step type, checked against the unions in
// src/types/index.ts: adding a type there fails the build until it is placed here.
const ALL_AUTOMATION_TRIGGERS = Object.keys({
  new_message_received: true,
  first_inbound_message: true,
  keyword_match: true,
  new_contact_created: true,
  conversation_assigned: true,
  tag_added: true,
  time_based: true,
  interactive_reply: true,
  ad_click: true,
  appointment_booked: true,
  appointment_cancelled: true,
  appointment_rescheduled: true,
  appointment_completed: true,
  appointment_no_show: true,
  tag_removed: true,
  field_changed: true,
} satisfies Record<AutomationTriggerType, true>) as AutomationTriggerType[];

const ALL_AUTOMATION_STEPS = Object.keys({
  send_message: true,
  send_buttons: true,
  send_list: true,
  send_template: true,
  add_tag: true,
  remove_tag: true,
  assign_conversation: true,
  update_contact_field: true,
  create_deal: true,
  wait: true,
  condition: true,
  send_webhook: true,
  close_conversation: true,
  notify_team: true,
  start_flow: true,
} satisfies Record<AutomationStepType, true>) as AutomationStepType[];

/** Instagram's automation triggers. Comment, story, live and ref events are flow triggers only. */
const INSTAGRAM_AUTOMATION_TRIGGERS: readonly AutomationTriggerType[] = ['new_message_received', 'first_inbound_message',
  'keyword_match', 'interactive_reply', 'new_contact_created', 'conversation_assigned', 'tag_added',
  // Stage 5 contact events.
  'tag_removed', 'field_changed'];

/**
 * The automation triggers each channel offers. Instagram has no appointment
 * triggers; `time_based` (Stage 5) only while INSTAGRAM_SCHEDULED_AUTOMATIONS_ENABLED
 * is on, because every scheduled send must re-check the 24-hour window. Pure:
 * the flag is passed in (instagramScheduledAutomationsEnabled() on the server,
 * the page's prop in the browser); the constant below is the flag-off palette.
 */
export function automationTriggersFor(channel: Channel, opts: { instagramScheduled?: boolean } = {}): readonly AutomationTriggerType[] {
  if (channel === 'whatsapp') return ALL_AUTOMATION_TRIGGERS;
  return opts.instagramScheduled ? [...INSTAGRAM_AUTOMATION_TRIGGERS, 'time_based'] : INSTAGRAM_AUTOMATION_TRIGGERS;
}

export const AUTOMATION_TRIGGERS_BY_CHANNEL: Record<Channel, readonly AutomationTriggerType[]> = {
  whatsapp: ALL_AUTOMATION_TRIGGERS,
  instagram: INSTAGRAM_AUTOMATION_TRIGGERS,
};

/** Steps not available on Instagram: templates are WhatsApp-only and a list message does not fit quick replies. */
const NOT_ON_INSTAGRAM: ReadonlySet<AutomationStepType> = new Set<AutomationStepType>(['send_template', 'send_list']);

/** The automation steps each channel offers. */
export const AUTOMATION_STEPS_BY_CHANNEL: Record<Channel, readonly AutomationStepType[]> = {
  whatsapp: ALL_AUTOMATION_STEPS,
  instagram: ALL_AUTOMATION_STEPS.filter((step) => !NOT_ON_INSTAGRAM.has(step)),
};

export function automationStepsFor(channel: Channel): readonly AutomationStepType[] {
  return AUTOMATION_STEPS_BY_CHANNEL[channel];
}

export function automationTriggerAvailableOn(trigger: AutomationTriggerType, channel: Channel,
  opts: { instagramScheduled?: boolean } = {}): boolean {
  return automationTriggersFor(channel, opts).includes(trigger);
}

export function automationStepAvailableOn(step: AutomationStepType, channel: Channel): boolean {
  return AUTOMATION_STEPS_BY_CHANNEL[channel].includes(step);
}

/** Composer and send-path capabilities that Instagram lacks in Phase 11. */
export type ChannelCapability =
  | 'template'
  | 'form'
  | 'catalog'
  | 'product'
  | 'location_request'
  | 'address_request'
  | 'list'
  | 'reaction'
  | 'interactive'
  | 'media_type';

/** Audio Instagram plays: AAC/M4A/MP4 and WAV. Ogg/Opus (the WhatsApp voice note) and WebM are refused. */
const INSTAGRAM_AUDIO_MIME = new Set(['audio/aac', 'audio/mp4', 'audio/x-m4a', 'audio/m4a', 'audio/wav', 'audio/x-wav']);

/** Can the Instagram composer attach this file? png/jpeg <= 8 MB, aac/m4a/wav audio and video <= 25 MB, pdf <= 25 MB. */
export function instagramMediaAllowed(mimeType: string, bytes: number): { ok: true; type: 'image' | 'audio' | 'video' | 'file' } | { ok: false } {
  const mime = mimeType.toLowerCase().split(';')[0].trim();
  if (!Number.isFinite(bytes) || bytes <= 0) return { ok: false };
  if (mime === 'image/png' || mime === 'image/jpeg') return bytes <= INSTAGRAM_LIMITS.imageBytes ? { ok: true, type: 'image' } : { ok: false };
  if (mime.startsWith('audio/')) return INSTAGRAM_AUDIO_MIME.has(mime) && bytes <= INSTAGRAM_LIMITS.audioBytes ? { ok: true, type: 'audio' } : { ok: false };
  if (mime.startsWith('video/')) return bytes <= INSTAGRAM_LIMITS.videoBytes ? { ok: true, type: 'video' } : { ok: false };
  if (mime === 'application/pdf') return bytes <= INSTAGRAM_LIMITS.fileBytes ? { ok: true, type: 'file' } : { ok: false };
  return { ok: false };
}
