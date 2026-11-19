/**
 * Store plan Phase 8, batch 6: the pure rules of shop email (campaigns, order confirmations, consent). No database, no
 * environment: the validators for what an admin types, the dedupe keys, the send schedule and the unsubscribe token shape.
 */
import { EMAIL_LIMITS } from './email-limits';
import { StoreError } from './store-settings';

export { EMAIL_LIMITS };

const CONTROL = /[\u0000-\u001f\u007f]/;
const ADDRESS = /^[^\s@<>",;]{1,64}@[^\s@<>",;]{1,255}$/;

export const isEmailAddress = (value: unknown): value is string =>
  typeof value === 'string' && value.length <= EMAIL_LIMITS.address && ADDRESS.test(value) && !CONTROL.test(value);

/** Job dedupe key of one campaign recipient: one job per campaign and contact, ever. */
export const campaignJobKey = (campaignId: string, contactId: string) => `emailc:${campaignId}:${contactId}`;
/** Outbound intent key of the same send: a repeated or replayed job asks dispatchOnce again and is refused. */
export const campaignIntentKey = (campaignId: string, contactId: string) => `shop-email:${campaignId}:${contactId}`;
export const orderEmailJobKey = (orderId: string) => `oemail:${orderId}`;
export const orderEmailIntentKey = (orderId: string) => `shop-order-email:${orderId}`;
export const referralJobKey = (orderId: string) => `referral:${orderId}`;

/** When recipient number `index` (0-based) is released: `perMinute` per minute from `start`. */
export function sendSlot(start: Date, index: number, perMinute: number = EMAIL_LIMITS.perMinute): Date {
  return new Date(start.getTime() + Math.floor(index / perMinute) * 60_000);
}

function text(value: unknown, max: number, field: string, options: { multiline?: boolean } = {}): string {
  if (typeof value !== 'string') throw new StoreError('invalid', { field });
  const v = value.trim();
  if (!v || v.length > max) throw new StoreError('invalid', { field });
  if (options.multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v) : CONTROL.test(v)) throw new StoreError('invalid', { field });
  return v;
}

export interface CampaignInput { name: string; subject: string; body: string; segmentId: string | null }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function parseCampaignInput(body: unknown): CampaignInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const segment = b.segment_id;
  if (segment !== null && segment !== undefined && (typeof segment !== 'string' || !UUID.test(segment))) throw new StoreError('invalid', { field: 'segment_id' });
  return {
    name: text(b.name, EMAIL_LIMITS.name, 'name'), subject: text(b.subject, EMAIL_LIMITS.subject, 'subject'),
    body: text(b.body, EMAIL_LIMITS.body, 'body', { multiline: true }), segmentId: typeof segment === 'string' ? segment.toLowerCase() : null,
  };
}

export interface MarketingSettingsInput {
  order_emails_enabled: boolean;
  sender_name: string | null;
  sender_address: string | null;
  reply_to: string | null;
  referral_enabled: boolean;
  referral_reward_minor: number;
  referral_hold_days: number;
}

export function parseMarketingSettings(body: unknown): MarketingSettingsInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const flag = (key: string) => { if (typeof b[key] !== 'boolean') throw new StoreError('invalid', { field: key }); return b[key] as boolean; };
  const optional = (key: string, max: number, multiline = false) =>
    b[key] === null || b[key] === undefined || b[key] === '' ? null : text(b[key], max, key, { multiline });
  const reply = optional('reply_to', EMAIL_LIMITS.address);
  if (reply !== null && !isEmailAddress(reply)) throw new StoreError('invalid', { field: 'reply_to' });
  const reward = b.referral_reward_minor, hold = b.referral_hold_days;
  if (typeof reward !== 'number' || !Number.isSafeInteger(reward) || reward < 0 || reward > 100_000_000_000) throw new StoreError('invalid', { field: 'referral_reward_minor' });
  if (typeof hold !== 'number' || !Number.isInteger(hold) || hold < 0 || hold > 90) throw new StoreError('invalid', { field: 'referral_hold_days' });
  return {
    order_emails_enabled: flag('order_emails_enabled'), referral_enabled: flag('referral_enabled'),
    sender_name: optional('sender_name', EMAIL_LIMITS.senderName), sender_address: optional('sender_address', EMAIL_LIMITS.senderAddress, true),
    reply_to: reply, referral_reward_minor: reward, referral_hold_days: hold,
  };
}

/** Why a contact may not get a marketing email (null: may). Consent must be recorded, and an unsubscribe is final. */
export function emailRefusal(contact: { email: string | null; blocked_at: Date | null }, prefs: { opted_in_at: Date | null; unsubscribed_at: Date | null } | null): string | null {
  if (contact.blocked_at) return 'contact_blocked';
  if (!isEmailAddress(contact.email?.trim())) return 'no_email';
  if (prefs?.unsubscribed_at) return 'unsubscribed';
  if (!prefs?.opted_in_at) return 'no_consent';
  return null;
}

/** The unsubscribe token (see email-send.ts): <account>.<contact>.<signature>. Only its shape is checked here. */
export const UNSUBSCRIBE_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/;

/** The plain-text mail: the body, then the sender's address and the unsubscribe link. */
export function campaignText(args: { body: string; senderName: string | null; senderAddress: string; unsubscribeUrl: string; unsubscribeLine: string }): string {
  const lines = [args.body.trim(), '', '--'];
  if (args.senderName) lines.push(args.senderName);
  lines.push(args.senderAddress, '', `${args.unsubscribeLine} ${args.unsubscribeUrl}`);
  return `${lines.join('\n')}\n`;
}
