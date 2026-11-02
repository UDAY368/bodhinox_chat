/**
 * A number's WhatsApp business profile: limits, Meta's vertical list, and the
 * server-side validation of an update. Client safe (the dialog reuses the
 * limits and verticals); Meta calls live in meta-api.ts.
 */
import type { BusinessProfileUpdate, MetaBusinessProfile } from './meta-api';

export const BUSINESS_PROFILE_LIMITS = {
  about: 139,
  address: 256,
  description: 512,
  email: 128,
  website: 256,
  websites: 2,
} as const;

/** Meta's business categories (whatsapp_business_profile.vertical). */
export const BUSINESS_VERTICALS = [
  'UNDEFINED',
  'OTHER',
  'AUTO',
  'BEAUTY',
  'APPAREL',
  'EDU',
  'ENTERTAIN',
  'EVENT_PLAN',
  'FINANCE',
  'GROCERY',
  'GOVT',
  'HOTEL',
  'HEALTH',
  'NONPROFIT',
  'PROF_SERVICES',
  'RETAIL',
  'TRAVEL',
  'RESTAURANT',
  'ALCOHOL',
  'ONLINE_GAMBLING',
  'PHYSICAL_GAMBLING',
  'OTC_DRUGS',
] as const;
export type BusinessVertical = (typeof BUSINESS_VERTICALS)[number];

/** Profile photo: Meta accepts JPEG or PNG up to 5 MB. */
export const PROFILE_PHOTO_TYPES = ['image/jpeg', 'image/png'] as const;
export const PROFILE_PHOTO_MAX_BYTES = 5 * 1024 * 1024;

/** What the API returns to the browser. */
export interface BusinessProfile {
  about: string;
  address: string;
  description: string;
  email: string;
  websites: string[];
  vertical: string;
  profile_picture_url: string | null;
}

export function toBusinessProfile(meta: MetaBusinessProfile): BusinessProfile {
  const str = (v: unknown) => (typeof v === 'string' ? v : '');
  return {
    about: str(meta.about),
    address: str(meta.address),
    description: str(meta.description),
    email: str(meta.email),
    websites: Array.isArray(meta.websites) ? meta.websites.filter((w): w is string => typeof w === 'string') : [],
    vertical: str(meta.vertical),
    profile_picture_url: typeof meta.profile_picture_url === 'string' && meta.profile_picture_url ? meta.profile_picture_url : null,
  };
}

export type BusinessProfileField = 'about' | 'address' | 'description' | 'email' | 'websites' | 'vertical';
export type BusinessProfileError = { field: BusinessProfileField | 'body'; reason: 'type' | 'empty' | 'tooLong' | 'tooMany' | 'invalid' };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Control characters are never valid in a profile field.
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function isWebsite(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === 'http:' || url.protocol === 'https:') && !!url.hostname && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * Validate a partial update. Only the fields present are changed; an empty
 * string clears address, description or email. `about` cannot be empty.
 */
export function parseBusinessProfileUpdate(
  body: unknown
): { ok: true; update: Omit<BusinessProfileUpdate, 'profile_picture_handle'> } | { ok: false; error: BusinessProfileError } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: { field: 'body', reason: 'type' } };
  const input = body as Record<string, unknown>;
  const update: Omit<BusinessProfileUpdate, 'profile_picture_handle'> = {};

  for (const field of ['about', 'address', 'description', 'email'] as const) {
    if (input[field] === undefined) continue;
    const raw = input[field];
    if (typeof raw !== 'string' || CONTROL.test(raw.replace(/\n/g, ''))) return { ok: false, error: { field, reason: 'type' } };
    const value = raw.trim();
    if (value.length > BUSINESS_PROFILE_LIMITS[field]) return { ok: false, error: { field, reason: 'tooLong' } };
    if (field === 'about' && !value) return { ok: false, error: { field, reason: 'empty' } };
    if (field === 'about' && value.includes('\n')) return { ok: false, error: { field, reason: 'invalid' } };
    if (field === 'email' && value && !EMAIL.test(value)) return { ok: false, error: { field, reason: 'invalid' } };
    update[field] = value;
  }

  if (input.websites !== undefined) {
    if (!Array.isArray(input.websites) || input.websites.some((w) => typeof w !== 'string')) {
      return { ok: false, error: { field: 'websites', reason: 'type' } };
    }
    const sites = (input.websites as string[]).map((w) => w.trim()).filter(Boolean);
    if (sites.length > BUSINESS_PROFILE_LIMITS.websites) return { ok: false, error: { field: 'websites', reason: 'tooMany' } };
    if (sites.some((w) => w.length > BUSINESS_PROFILE_LIMITS.website)) return { ok: false, error: { field: 'websites', reason: 'tooLong' } };
    if (!sites.every(isWebsite)) return { ok: false, error: { field: 'websites', reason: 'invalid' } };
    update.websites = sites;
  }

  if (input.vertical !== undefined) {
    if (typeof input.vertical !== 'string' || !(BUSINESS_VERTICALS as readonly string[]).includes(input.vertical)) {
      return { ok: false, error: { field: 'vertical', reason: 'invalid' } };
    }
    update.vertical = input.vertical;
  }

  return { ok: true, update };
}

/** Check an uploaded profile photo before it is sent to Meta. */
export function validateProfilePhoto(file: { type: string; size: number }): 'type' | 'tooLarge' | 'empty' | null {
  if (!(PROFILE_PHOTO_TYPES as readonly string[]).includes(file.type)) return 'type';
  if (file.size === 0) return 'empty';
  if (file.size > PROFILE_PHOTO_MAX_BYTES) return 'tooLarge';
  return null;
}
