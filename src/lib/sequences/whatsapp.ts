// WhatsApp sequence steps and "Exit when" (batch 7). Pure: safe in client and
// server code, unit-tested on its own.
//
// A WhatsApp step is its own text and/or one image, video or document, plus an
// optional approved template. WhatsApp allows free-form messages only within 24
// hours of the person's last message, so when the step falls due:
//   window open                -> the step's message (its template only when it has no content)
//   window closed, template    -> the template, its body values filled from the contact
//   window closed, no template -> skipped and logged outside_window_no_template
// "Exit when" stops a subscriber before a step: they replied after joining,
// they carry the chosen tag, or they have a paid order created after joining.
import { fillPlaceholders, type PlaceholderContact } from '@/lib/flows/placeholders';

export const SEQUENCE_CHANNELS = ['instagram', 'whatsapp'] as const;
export type SequenceChannel = (typeof SEQUENCE_CHANNELS)[number];

export const WA_MEDIA_TYPES = ['image', 'video', 'document'] as const;
export type WaMediaType = (typeof WA_MEDIA_TYPES)[number];

export const WA_LIMITS = { textChars: 4096, captionChars: 1024, urlChars: 2048, filenameChars: 240, templateParams: 20, paramChars: 1000 } as const;

export interface WhatsAppTemplateChoice { name: string; language: string | null; params: string[] }
export interface WhatsAppStep {
  text: string | null;
  media: { type: WaMediaType; url: string; filename: string | null } | null;
  template: WhatsAppTemplateChoice | null;
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** A media link the sender can fetch: https, or this app's own /api/media/object path. */
function mediaUrlOk(url: string): boolean {
  if (url.length > WA_LIMITS.urlChars) return false;
  if (url.startsWith('/api/media/object?')) return true;
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Validates a step body ({ text?, media?: { type, url, filename? }, template?: { name, language?, params? } | null }).
 * The step needs text or media; a caption (text with media) is at most 1024 characters. Returns null when invalid.
 */
export function parseWhatsAppStep(body: unknown): WhatsAppStep | null {
  if (!isObject(body)) return null;
  for (const key of Object.keys(body)) if (!['text', 'media', 'template'].includes(key)) return null;
  let text: string | null = null;
  if (body.text !== undefined && body.text !== null) {
    if (typeof body.text !== 'string') return null;
    text = body.text.trim() || null;
  }
  let media: WhatsAppStep['media'] = null;
  if (body.media !== undefined && body.media !== null) {
    const m = body.media;
    if (!isObject(m) || typeof m.type !== 'string' || !(WA_MEDIA_TYPES as readonly string[]).includes(m.type)
      || typeof m.url !== 'string' || !mediaUrlOk(m.url.trim())) return null;
    if (m.filename !== undefined && m.filename !== null && (typeof m.filename !== 'string' || m.filename.length > WA_LIMITS.filenameChars)) return null;
    media = { type: m.type as WaMediaType, url: m.url.trim(), filename: typeof m.filename === 'string' && m.filename.trim() ? m.filename.trim() : null };
  }
  if (!text && !media) return null;
  if (text && text.length > (media ? WA_LIMITS.captionChars : WA_LIMITS.textChars)) return null;
  let template: WhatsAppTemplateChoice | null = null;
  if (body.template !== undefined && body.template !== null) {
    const t = body.template;
    if (!isObject(t) || typeof t.name !== 'string' || !t.name.trim() || t.name.length > 512) return null;
    if (t.language !== undefined && t.language !== null && (typeof t.language !== 'string' || t.language.length > 15)) return null;
    const params = t.params ?? [];
    if (!Array.isArray(params) || params.length > WA_LIMITS.templateParams
      || params.some((p) => typeof p !== 'string' || p.length > WA_LIMITS.paramChars)) return null;
    template = { name: t.name.trim(), language: typeof t.language === 'string' && t.language.trim() ? t.language.trim() : null, params: params as string[] };
  }
  return { text, media, template };
}

export type WhatsAppSendPlan =
  | { kind: 'message' }
  | { kind: 'template' }
  | { kind: 'skip'; reason: 'no_content' | 'outside_window_no_template' };

/** What a due WhatsApp step sends, given whether the contact's 24-hour window is open right now. */
export function chooseWhatsAppSend(step: Pick<WhatsAppStep, 'text' | 'media' | 'template'>, windowOpen: boolean): WhatsAppSendPlan {
  const hasContent = !!(step.text || step.media);
  if (windowOpen) return hasContent ? { kind: 'message' } : step.template ? { kind: 'template' } : { kind: 'skip', reason: 'no_content' };
  return step.template ? { kind: 'template' } : { kind: 'skip', reason: 'outside_window_no_template' };
}

/**
 * The template's body values: `count` positional values, each the step's
 * placeholder text filled from the contact ({{contact.name|there}}). Meta
 * refuses an empty value, so an empty one is sent as "-".
 */
export function fillTemplateParams(params: readonly string[], count: number, contact: PlaceholderContact): string[] {
  return Array.from({ length: count }, (_, i) =>
    (fillPlaceholders(params[i] ?? '', {}, {}, contact).trim().slice(0, WA_LIMITS.paramChars)) || '-');
}

// ------------------------------------------------------------------ exit when

export const SEQUENCE_EXIT_REASONS = ['replied', 'tagged', 'purchased'] as const;
export type SequenceExitReason = (typeof SEQUENCE_EXIT_REASONS)[number];
/** What sequence_subscriptions.exit_reason can hold (exit rules plus consent). */
export type SubscriptionEndReason = SequenceExitReason | 'opted_out' | 'blocked';

export interface ExitSettings { exit_on_reply: boolean; exit_on_tag_id: string | null; exit_on_purchase: boolean }
/** Facts read at send time; each is false when its setting is off. */
export interface ExitFacts { replied: boolean; tagged: boolean; purchased: boolean }

/** The first exit rule that applies, or null to keep going. */
export function exitReason(facts: ExitFacts): SequenceExitReason | null {
  if (facts.replied) return 'replied';
  if (facts.tagged) return 'tagged';
  if (facts.purchased) return 'purchased';
  return null;
}

/** Whether an event of `reason` stops a sequence with these settings (the push path, exitSequencesFor). */
export function exitApplies(settings: ExitSettings, reason: SequenceExitReason, tagId?: string | null): boolean {
  if (reason === 'replied') return settings.exit_on_reply;
  if (reason === 'purchased') return settings.exit_on_purchase;
  return !!settings.exit_on_tag_id && !!tagId && settings.exit_on_tag_id.toLowerCase() === tagId.toLowerCase();
}

/** Validates the "Exit when" part of a PATCH body; undefined keys are left alone. Returns null when invalid. */
export function parseExitPatch(body: Record<string, unknown>): Partial<ExitSettings> | null {
  const out: Partial<ExitSettings> = {};
  if ('exit_on_reply' in body) {
    if (typeof body.exit_on_reply !== 'boolean') return null;
    out.exit_on_reply = body.exit_on_reply;
  }
  if ('exit_on_purchase' in body) {
    if (typeof body.exit_on_purchase !== 'boolean') return null;
    out.exit_on_purchase = body.exit_on_purchase;
  }
  if ('exit_on_tag_id' in body) {
    const v = body.exit_on_tag_id;
    if (v !== null && (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v))) return null;
    out.exit_on_tag_id = v;
  }
  return out;
}
