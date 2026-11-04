// What each channel can do (Phase 11). Pure: no I/O, safe to import from client
// components. Flow publish (validate.ts), the runtime engine guard, the flow
// editor and the Instagram composer all read this one registry.
import type { FlowChannelScope, FlowNodeType, FlowTriggerConfig } from '@/lib/flows/types';
import { INSTAGRAM_LIMITS, quickRepliesFit, utf8Bytes } from '@/lib/instagram/graph-limits';

export type Channel = 'whatsapp' | 'instagram';
export const CHANNELS: readonly Channel[] = ['whatsapp', 'instagram'];

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

/** Instagram support per flow node (design section 8). Every node runs on WhatsApp. */
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
  conversion_event: 'no',
  ai_reply: 'no',
  condition: 'yes',
  set_tag: 'yes',
  set_attribute: 'yes',
  api_request: 'yes',
  connect_flow: 'yes',
  assign_agent: 'yes',
  handoff: 'yes',
  end: 'yes',
};

export type NodeAvailability = { ok: true; warning?: 'text_over_limit' } | { ok: false; reason: 'unavailable_on_channel' };

/** send_media node types Instagram can carry (a document only as a PDF). */
const MEDIA_TYPES_ON_INSTAGRAM = new Set(['image', 'video', 'document']);

const textOf = (config: Record<string, unknown>): string | null => {
  for (const key of ['text', 'body', 'message']) if (typeof config[key] === 'string') return config[key] as string;
  return null;
};

/**
 * Whether a node may run on a channel. For a conditional Instagram node the
 * config decides: media must be image/audio/video/pdf (a document must be a
 * PDF); a list must fit Instagram quick replies. Text over 1000 bytes is a
 * warning (variables may shorten it), not a refusal; the send path refuses it.
 */
export function nodeAvailableOn(nodeType: FlowNodeType, channel: Channel,
  config: Record<string, unknown> = {}): NodeAvailability {
  if (channel === 'whatsapp') return { ok: true };
  const support = INSTAGRAM_NODE_SUPPORT[nodeType] ?? 'no';
  if (support === 'no') return { ok: false, reason: 'unavailable_on_channel' };
  if (nodeType === 'send_media') {
    const mediaType = typeof config.media_type === 'string' ? config.media_type : null;
    if (!mediaType || !MEDIA_TYPES_ON_INSTAGRAM.has(mediaType)) return { ok: false, reason: 'unavailable_on_channel' };
    if (mediaType === 'document') {
      const names = [config.filename, config.media_url].filter((v): v is string => typeof v === 'string');
      if (!names.some((name) => /\.pdf(?:$|[?#])/i.test(name))) return { ok: false, reason: 'unavailable_on_channel' };
    }
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

/** Triggers an Instagram (or 'any') flow may use; the rest are WhatsApp-only. */
export const INSTAGRAM_TRIGGERS: ReadonlySet<TriggerType> = new Set<TriggerType>(['keyword', 'first_inbound_message', 'manual']);

export function triggerAvailableOn(triggerType: TriggerType, channel: Channel): boolean {
  return channel === 'whatsapp' || INSTAGRAM_TRIGGERS.has(triggerType);
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
