/**
 * Checkout extras (store plan Phase 8, batch 5): an order note, a gift message, a delivery date with a time slot, and up
 * to five admin-defined custom fields (text, choice, tick box). They are what the buyer tells the shop, never part of
 * pricing. Pure rules only; the settings row is in buyer-settings.ts.
 *
 * Two checks with one rule set: while the buyer fills the page the values are checked for shape and range
 * (`complete: false`), and placing the order checks them again against the shop's current settings, with the required
 * fields now enforced (`complete: true`). The order keeps a snapshot (labels and values), so renaming a field later
 * does not change old orders. Fixed caps everywhere; control characters are removed.
 */
import { CUSTOM_FIELD_TYPES, EXTRAS_LIMITS } from './checkout-extras-limits';
import { StoreError } from './store-settings';

export { CUSTOM_FIELD_TYPES, EXTRAS_LIMITS };
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export interface DeliverySlot { id: string; label: string }
export interface CustomField { id: string; label: string; type: CustomFieldType; required: boolean; options: string[] }

/** What the shop offers at checkout. */
export interface ExtrasConfig {
  note_enabled: boolean;
  gift_message_enabled: boolean;
  delivery_date_enabled: boolean;
  /** Whole days between today and the first date the buyer may pick. */
  lead_days: number;
  /** How many days after the first date can still be picked. */
  window_days: number;
  slots: DeliverySlot[];
  custom_fields: CustomField[];
  /** The workspace's timezone (read from its settings, never written here); decides "today" for the delivery date. */
  timezone?: string;
}

export const DEFAULT_EXTRAS_CONFIG: ExtrasConfig = {
  note_enabled: false, gift_message_enabled: false, delivery_date_enabled: false, lead_days: 1, window_days: 14, slots: [], custom_fields: [],
};

/** What the page sends and the session stores. */
export interface ExtrasInput {
  note?: string | null;
  gift_message?: string | null;
  /** YYYY-MM-DD */
  delivery_date?: string | null;
  slot_id?: string | null;
  /** field id -> text / chosen option / true */
  custom?: Record<string, string | boolean>;
}

/** What the order keeps. */
export interface BuyerExtras {
  note: string | null;
  gift_message: string | null;
  delivery_date: string | null;
  delivery_slot: string | null;
  custom: Array<{ label: string; value: string }>;
}

const ID = /^[a-z0-9]{1,12}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const fail = (field: string): never => { throw new StoreError('extras_invalid', { field }); };

/** Trim, drop control characters, cap the length; null for empty. */
function clean(value: unknown, max: number, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') return fail(field);
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length > max) return fail(field);
  return text || null;
}

// ---------------------------------------------------------------------------
// The shop's configuration (admin)

const flag = (value: unknown, field: string): boolean => (typeof value === 'boolean' ? value : (fail(field) as never));
const integer = (value: unknown, min: number, max: number, field: string): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : (fail(field) as never);

/** Validate an admin's body (a full replacement). Ids are short lowercase codes the page makes; they must be unique. */
export function parseExtrasConfig(body: unknown): ExtrasConfig {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return fail('body');
  const b = body as Record<string, unknown>;
  const slotsRaw = b.slots ?? [];
  const fieldsRaw = b.custom_fields ?? [];
  if (!Array.isArray(slotsRaw) || slotsRaw.length > EXTRAS_LIMITS.slots) return fail('slots');
  if (!Array.isArray(fieldsRaw) || fieldsRaw.length > EXTRAS_LIMITS.customFields) return fail('custom_fields');
  const slots = slotsRaw.map((raw): DeliverySlot => {
    const s = raw as Record<string, unknown> | null;
    const id = typeof s?.id === 'string' && ID.test(s.id) ? s.id : (fail('slots') as never);
    return { id, label: clean(s?.label, EXTRAS_LIMITS.slotLabel, 'slots') ?? (fail('slots') as never) };
  });
  if (new Set(slots.map((s) => s.id)).size !== slots.length) fail('slots');
  const fields = fieldsRaw.map((raw): CustomField => {
    const f = raw as Record<string, unknown> | null;
    const id = typeof f?.id === 'string' && ID.test(f.id) ? f.id : (fail('custom_fields') as never);
    const type = (CUSTOM_FIELD_TYPES as readonly unknown[]).includes(f?.type) ? f!.type as CustomFieldType : (fail('custom_fields') as never);
    const label = clean(f?.label, EXTRAS_LIMITS.fieldLabel, 'custom_fields') ?? (fail('custom_fields') as never);
    const required = f?.required === undefined ? false : flag(f.required, 'custom_fields');
    let options: string[] = [];
    if (type === 'select') {
      const raws = f?.options;
      if (!Array.isArray(raws) || raws.length < 2 || raws.length > EXTRAS_LIMITS.options) return fail('custom_fields');
      options = raws.map((o) => clean(o, EXTRAS_LIMITS.option, 'custom_fields') ?? (fail('custom_fields') as never));
      if (new Set(options).size !== options.length) fail('custom_fields');
    }
    return { id, label, type, required, options };
  });
  if (new Set(fields.map((f) => f.id)).size !== fields.length) fail('custom_fields');
  const delivery = flag(b.delivery_date_enabled, 'delivery_date_enabled');
  return {
    note_enabled: flag(b.note_enabled, 'note_enabled'), gift_message_enabled: flag(b.gift_message_enabled, 'gift_message_enabled'),
    delivery_date_enabled: delivery, lead_days: integer(b.lead_days, 0, EXTRAS_LIMITS.leadDays, 'lead_days'),
    window_days: integer(b.window_days, 1, EXTRAS_LIMITS.windowDays, 'window_days'),
    // Slots only matter with a delivery date; keep them stored but unused otherwise.
    slots, custom_fields: fields,
  };
}

/** Whether the shop offers any extra at all (the page shows the section only then). */
export const hasExtras = (c: ExtrasConfig): boolean =>
  c.note_enabled || c.gift_message_enabled || c.delivery_date_enabled || c.custom_fields.length > 0;

// ---------------------------------------------------------------------------
// The buyer's values

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Used only when the workspace has no timezone setting at all (workspace_inbox_settings has no row). */
export const FALLBACK_TIMEZONE = 'Asia/Kolkata';

/** Today's calendar date (YYYY-MM-DD) in a timezone; an unknown zone name reads as the fallback zone. */
export function localToday(now: Date, timeZone: string): string {
  const format = (zone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  try { return format(timeZone); } catch { return format(FALLBACK_TIMEZONE); }
}

/**
 * The first and last date a buyer may pick: today in the workspace's timezone plus the lead days, then the window.
 * "Today" is the shop's today, so a shop in India at 1 am IST (still yesterday in UTC) counts from its own date.
 */
export function deliveryDateBounds(now: Date, leadDays: number, windowDays: number, timeZone: string = FALLBACK_TIMEZONE): { min: string; max: string } {
  const today = new Date(`${localToday(now, timeZone)}T00:00:00Z`);
  const start = new Date(today.getTime() + leadDays * 86_400_000);
  return { min: isoDay(start), max: isoDay(new Date(start.getTime() + windowDays * 86_400_000)) };
}

/** A real calendar date in YYYY-MM-DD. */
export function isCalendarDate(value: string): boolean {
  if (!DATE.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && isoDay(d) === value;
}

export interface ExtrasCheck {
  /** The values to store on the session (only what the shop offers; nothing else is kept). */
  input: ExtrasInput;
  /** The snapshot the order keeps. */
  extras: BuyerExtras;
}

/**
 * Check the buyer's values against the shop's offer. Unknown fields, a field the shop does not offer, an unknown slot
 * or choice, a date outside the lead/window range and over-long text are refused (extras_invalid with the field).
 * `complete`: the required custom fields, the delivery date (and a slot, when the shop has slots) must be given.
 * `physical: false` (a cart of only downloads) skips the delivery date and slot.
 */
export function checkExtras(config: ExtrasConfig, raw: unknown, now: Date, options: { complete: boolean; physical?: boolean }): ExtrasCheck {
  const input = raw === null || raw === undefined ? {} : raw;
  if (typeof input !== 'object' || Array.isArray(input)) return fail('extras');
  const b = input as Record<string, unknown>;
  const allowed = new Set(['note', 'gift_message', 'delivery_date', 'slot_id', 'custom']);
  if (Object.keys(b).some((k) => !allowed.has(k))) return fail('extras');
  const out: ExtrasInput = {};
  const snapshot: BuyerExtras = { note: null, gift_message: null, delivery_date: null, delivery_slot: null, custom: [] };

  const note = clean(b.note, EXTRAS_LIMITS.note, 'note');
  if (note && !config.note_enabled) return fail('note');
  if (note) { out.note = note; snapshot.note = note; }
  const gift = clean(b.gift_message, EXTRAS_LIMITS.giftMessage, 'gift_message');
  if (gift && !config.gift_message_enabled) return fail('gift_message');
  if (gift) { out.gift_message = gift; snapshot.gift_message = gift; }

  const physical = options.physical !== false;
  const date = clean(b.delivery_date, 10, 'delivery_date');
  const slotId = clean(b.slot_id, 12, 'slot_id');
  if ((date || slotId) && !config.delivery_date_enabled) return fail('delivery_date');
  if (config.delivery_date_enabled && physical) {
    if (date) {
      const { min, max } = deliveryDateBounds(now, config.lead_days, config.window_days, config.timezone);
      if (!isCalendarDate(date) || date < min || date > max) return fail('delivery_date');
      out.delivery_date = date;
      snapshot.delivery_date = date;
    } else if (options.complete) return fail('delivery_date');
    if (slotId) {
      const slot = config.slots.find((s) => s.id === slotId);
      if (!slot) return fail('slot_id');
      out.slot_id = slot.id;
      snapshot.delivery_slot = slot.label;
    } else if (options.complete && config.slots.length > 0) return fail('slot_id');
  }

  const customRaw = b.custom === undefined || b.custom === null ? {} : b.custom;
  if (typeof customRaw !== 'object' || Array.isArray(customRaw)) return fail('custom');
  const answers = customRaw as Record<string, unknown>;
  if (Object.keys(answers).some((id) => !config.custom_fields.some((f) => f.id === id))) return fail('custom');
  const custom: Record<string, string | boolean> = {};
  for (const field of config.custom_fields) {
    const given = answers[field.id];
    let value: string | null = null;
    if (field.type === 'checkbox') {
      if (given !== undefined && typeof given !== 'boolean') return fail(`custom.${field.id}`);
      if (given === true) value = 'yes';
      if (given === true) custom[field.id] = true;
    } else {
      const text = clean(given, EXTRAS_LIMITS.textValue, `custom.${field.id}`);
      if (text && field.type === 'select' && !field.options.includes(text)) return fail(`custom.${field.id}`);
      if (text) { value = text; custom[field.id] = text; }
    }
    if (value === null && field.required && options.complete) return fail(`custom.${field.id}`);
    if (value !== null) snapshot.custom.push({ label: field.label, value });
  }
  if (Object.keys(custom).length) out.custom = custom;
  return { input: out, extras: snapshot };
}

/** True when nothing was given (the order then stores no extras). */
export const isEmptyExtras = (e: BuyerExtras): boolean =>
  !e.note && !e.gift_message && !e.delivery_date && !e.delivery_slot && e.custom.length === 0;

/** An order's stored snapshot, read defensively (it is JSON from the database). */
export function readBuyerExtras(value: unknown): BuyerExtras | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const str = (x: unknown) => (typeof x === 'string' && x ? x.slice(0, 300) : null);
  const custom = Array.isArray(v.custom)
    ? v.custom.flatMap((c) => {
      const e = c as { label?: unknown; value?: unknown } | null;
      return typeof e?.label === 'string' && typeof e.value === 'string' ? [{ label: e.label.slice(0, 60), value: e.value.slice(0, 200) }] : [];
    }).slice(0, EXTRAS_LIMITS.customFields) : [];
  const result: BuyerExtras = {
    note: str(v.note), gift_message: str(v.gift_message), delivery_date: str(v.delivery_date), delivery_slot: str(v.delivery_slot), custom,
  };
  return isEmptyExtras(result) ? null : result;
}

/** One text for the CSV export: "Label: value; Label: value". */
export function customExtrasText(e: BuyerExtras | null): string {
  return e ? e.custom.map((c) => `${c.label}: ${c.value}`).join('; ') : '';
}
