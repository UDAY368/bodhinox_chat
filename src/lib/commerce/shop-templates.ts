/**
 * Public shop templates and brand settings (store plan Phase 1).
 *
 * A template is one of our own layouts plus default colors and fonts; the
 * workspace stores only its choice and a small, fixed set of brand settings
 * (shop_storefronts.theme). Nothing here is customer code: every value is
 * validated to a fixed shape (hex colors, a font id from a fixed list, https
 * URLs or media library ids, short plain texts) before it is saved, and the
 * public pages render it through React, which escapes text. Client-safe (no
 * server imports), so the admin preview and the public pages share it.
 */

export const SHOP_TEMPLATE_IDS = ['wellness', 'fashion', 'beauty', 'food', 'grocery', 'electronics'] as const;
export type ShopTemplateId = (typeof SHOP_TEMPLATE_IDS)[number];
export const isShopTemplateId = (value: unknown): value is ShopTemplateId =>
  typeof value === 'string' && (SHOP_TEMPLATE_IDS as readonly string[]).includes(value);

/**
 * Font choices as local font stacks. The app's CSP allows fonts only from
 * our own origin, so a shop never loads a web font from another site.
 */
export const SHOP_FONTS = {
  modern: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
  humanist: '"Avenir Next", Avenir, "Segoe UI", "Trebuchet MS", "Gill Sans", ui-sans-serif, sans-serif',
  rounded: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", "Varela Round", ui-sans-serif, system-ui, sans-serif',
  classic: 'Georgia, Cambria, "Times New Roman", Times, ui-serif, serif',
  elegant: '"Didot", "Bodoni MT", "Playfair Display", "Book Antiqua", Palatino, Georgia, ui-serif, serif',
  technical: 'ui-monospace, "SF Mono", "Cascadia Mono", "Roboto Mono", Menlo, Consolas, monospace',
} as const;
export type ShopFontId = keyof typeof SHOP_FONTS;
export const SHOP_FONT_IDS = Object.keys(SHOP_FONTS) as ShopFontId[];
const isFontId = (value: unknown): value is ShopFontId => typeof value === 'string' && value in SHOP_FONTS;

export interface ShopColors {
  primary: string;
  accent: string;
  background: string;
  surface: string;
  text: string;
}
export const SHOP_COLOR_KEYS: (keyof ShopColors)[] = ['primary', 'accent', 'background', 'surface', 'text'];

export interface ShopLayout {
  /** Home banner: image beside the text, image behind it, or text only on a color band. */
  hero: 'split' | 'full' | 'band';
  /** Product cards per row on wide screens (phones always show two). */
  columns: 3 | 4;
  /** Product image shape. */
  image: 'square' | 'portrait';
  /** Categories as small chips or as large tiles. */
  categories: 'chips' | 'tiles';
  /** Corner radius in px for cards and buttons. */
  radius: number;
}

export interface ShopTemplate {
  id: ShopTemplateId;
  colors: ShopColors;
  font: { heading: ShopFontId; body: ShopFontId };
  layout: ShopLayout;
}

export const SHOP_TEMPLATES: Record<ShopTemplateId, ShopTemplate> = {
  wellness: {
    id: 'wellness',
    colors: { primary: '#2f5d3a', accent: '#c8963e', background: '#f7f3ea', surface: '#ffffff', text: '#1f2a22' },
    font: { heading: 'classic', body: 'humanist' },
    layout: { hero: 'split', columns: 3, image: 'square', categories: 'tiles', radius: 14 },
  },
  fashion: {
    id: 'fashion',
    colors: { primary: '#111111', accent: '#b4232c', background: '#ffffff', surface: '#f5f5f4', text: '#111111' },
    font: { heading: 'elegant', body: 'modern' },
    layout: { hero: 'full', columns: 4, image: 'portrait', categories: 'chips', radius: 0 },
  },
  beauty: {
    id: 'beauty',
    colors: { primary: '#9d3c62', accent: '#e8b4a0', background: '#fdf6f4', surface: '#ffffff', text: '#3a2230' },
    font: { heading: 'elegant', body: 'humanist' },
    layout: { hero: 'split', columns: 4, image: 'portrait', categories: 'chips', radius: 20 },
  },
  food: {
    id: 'food',
    colors: { primary: '#a4471c', accent: '#f2b33d', background: '#fff8ef', surface: '#ffffff', text: '#3b2414' },
    font: { heading: 'rounded', body: 'rounded' },
    layout: { hero: 'full', columns: 3, image: 'square', categories: 'tiles', radius: 18 },
  },
  grocery: {
    id: 'grocery',
    colors: { primary: '#1d7a3e', accent: '#f6c445', background: '#f4f8f2', surface: '#ffffff', text: '#16261b' },
    font: { heading: 'modern', body: 'modern' },
    layout: { hero: 'band', columns: 4, image: 'square', categories: 'tiles', radius: 10 },
  },
  electronics: {
    id: 'electronics',
    colors: { primary: '#1f4fd8', accent: '#00b3a4', background: '#f3f5f9', surface: '#ffffff', text: '#0f172a' },
    font: { heading: 'technical', body: 'modern' },
    layout: { hero: 'band', columns: 4, image: 'square', categories: 'chips', radius: 8 },
  },
};

/** An image: an https URL, or `media:<uuid>` for the workspace media library. */
export type ShopImageRef = string;

export interface ShopSocial {
  instagram: string | null;
  facebook: string | null;
  youtube: string | null;
}

/** What the workspace stores (shop_storefronts.theme). Every field is optional; null means the template default. */
export interface ShopThemeSettings {
  colors: Partial<ShopColors>;
  font: { heading?: ShopFontId; body?: ShopFontId };
  logo: ShopImageRef | null;
  banner: ShopImageRef | null;
  headline: string | null;
  subheadline: string | null;
  announcement: string | null;
  social: ShopSocial;
}

/** The theme a page renders: the template's defaults with the workspace's settings on top. */
export interface ResolvedShopTheme {
  template: ShopTemplateId;
  colors: ShopColors;
  font: { heading: ShopFontId; body: ShopFontId };
  layout: ShopLayout;
  logo: ShopImageRef | null;
  banner: ShopImageRef | null;
  headline: string | null;
  subheadline: string | null;
  announcement: string | null;
  social: ShopSocial;
}

export const SHOP_TEXT_LIMITS = { headline: 80, subheadline: 200, announcement: 120 } as const;

export const EMPTY_THEME: ShopThemeSettings = {
  colors: {}, font: {}, logo: null, banner: null, headline: null, subheadline: null, announcement: null,
  social: { instagram: null, facebook: null, youtube: null },
};

export class ShopThemeError extends Error {
  constructor(readonly field: string) {
    super(`invalid shop theme field: ${field}`);
    this.name = 'ShopThemeError';
  }
}

const HEX = /^#[0-9a-f]{6}$/;
export const MEDIA_REF = /^media:[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOCIAL_HOSTS: Record<keyof ShopSocial, RegExp> = {
  instagram: /^(www\.)?instagram\.com$/,
  facebook: /^(www\.|m\.)?facebook\.com$/,
  youtube: /^(www\.|m\.)?youtube\.com$|^youtu\.be$/,
};

/** A plain https URL without credentials, at most 500 characters, or null. */
export function safeHttpsUrl(value: unknown, host?: RegExp): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password) return null;
    if (host && !host.test(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** An image ref as stored: an https URL or media:<uuid>. */
export function parseImageRef(value: unknown, field: string): ShopImageRef | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'string' && MEDIA_REF.test(value.trim().toLowerCase())) return value.trim().toLowerCase();
  const url = safeHttpsUrl(value);
  if (!url) throw new ShopThemeError(field);
  return url;
}

/** The media library id of an image ref, or null for a URL. */
export const mediaIdOf = (ref: ShopImageRef | null): string | null => (ref && ref.startsWith('media:') ? ref.slice(6) : null);

export function plainText(value: unknown, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ShopThemeError(field);
  // Control characters out, whitespace folded; React escapes the rest on render.
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (text.length > max) throw new ShopThemeError(field);
  return text || null;
}

/** Validate brand settings from the admin form. Unknown keys are dropped; a bad value throws ShopThemeError. */
export function parseThemeSettings(input: unknown): ShopThemeSettings {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ShopThemeError('theme');
  const raw = input as Record<string, unknown>;
  const colors: Partial<ShopColors> = {};
  const rawColors = raw.colors && typeof raw.colors === 'object' ? raw.colors as Record<string, unknown> : {};
  for (const key of SHOP_COLOR_KEYS) {
    const value = rawColors[key];
    if (value === null || value === undefined || value === '') continue;
    if (typeof value !== 'string' || !HEX.test(value.toLowerCase())) throw new ShopThemeError(`colors.${key}`);
    colors[key] = value.toLowerCase();
  }
  const rawFont = raw.font && typeof raw.font === 'object' ? raw.font as Record<string, unknown> : {};
  const font: ShopThemeSettings['font'] = {};
  for (const key of ['heading', 'body'] as const) {
    const value = rawFont[key];
    if (value === null || value === undefined || value === '') continue;
    if (!isFontId(value)) throw new ShopThemeError(`font.${key}`);
    font[key] = value;
  }
  const rawSocial = raw.social && typeof raw.social === 'object' ? raw.social as Record<string, unknown> : {};
  const social = { instagram: null, facebook: null, youtube: null } as ShopSocial;
  for (const key of Object.keys(SOCIAL_HOSTS) as (keyof ShopSocial)[]) {
    const value = rawSocial[key];
    if (value === null || value === undefined || value === '') continue;
    const url = safeHttpsUrl(value, SOCIAL_HOSTS[key]);
    if (!url) throw new ShopThemeError(`social.${key}`);
    social[key] = url;
  }
  return {
    colors, font, social,
    logo: parseImageRef(raw.logo, 'logo'),
    banner: parseImageRef(raw.banner, 'banner'),
    headline: plainText(raw.headline, SHOP_TEXT_LIMITS.headline, 'headline'),
    subheadline: plainText(raw.subheadline, SHOP_TEXT_LIMITS.subheadline, 'subheadline'),
    announcement: plainText(raw.announcement, SHOP_TEXT_LIMITS.announcement, 'announcement'),
  };
}

/** Stored settings read back leniently: anything that no longer validates is dropped, never rendered. */
export function readThemeSettings(stored: unknown): ShopThemeSettings {
  try {
    return parseThemeSettings(stored);
  } catch {
    return EMPTY_THEME;
  }
}

export function resolveTheme(template: unknown, stored: unknown): ResolvedShopTheme {
  const base = SHOP_TEMPLATES[isShopTemplateId(template) ? template : 'wellness'];
  const settings = readThemeSettings(stored);
  return {
    template: base.id,
    colors: { ...base.colors, ...settings.colors },
    font: { heading: settings.font.heading ?? base.font.heading, body: settings.font.body ?? base.font.body },
    layout: base.layout,
    logo: settings.logo, banner: settings.banner, headline: settings.headline, subheadline: settings.subheadline,
    announcement: settings.announcement, social: settings.social,
  };
}

/** WCAG relative luminance of a #rrggbb color. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio (1 to 21) of two #rrggbb colors. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white, whichever reads better on `hex` (button text on the brand color). */
export function readableOn(hex: string): '#000000' | '#ffffff' {
  const l = luminance(HEX.test(hex) ? hex : '#000000');
  return (1.05) / (l + 0.05) >= (l + 0.05) / 0.05 ? '#ffffff' : '#000000';
}

/** CSS custom properties for a resolved theme (values are validated hex colors and fixed font stacks). */
export function themeCssVars(theme: ResolvedShopTheme): Record<string, string> {
  return {
    '--shop-primary': theme.colors.primary,
    '--shop-on-primary': readableOn(theme.colors.primary),
    '--shop-accent': theme.colors.accent,
    '--shop-on-accent': readableOn(theme.colors.accent),
    '--shop-bg': theme.colors.background,
    '--shop-surface': theme.colors.surface,
    '--shop-text': theme.colors.text,
    '--shop-radius': `${theme.layout.radius}px`,
    '--shop-font-heading': SHOP_FONTS[theme.font.heading],
    '--shop-font-body': SHOP_FONTS[theme.font.body],
  };
}

// ---------------------------------------------------------------------------
// Handles

export const SHOP_HANDLE = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
/** Handles that would read as ours, not the shop's. */
const RESERVED_HANDLES = new Set(['admin', 'api', 'app', 'bodhinox', 'help', 'login', 'shop', 'store', 'support', 'www', 'static', 'assets']);

export function normaliseHandle(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const handle = value.trim().toLowerCase();
  if (!SHOP_HANDLE.test(handle) || handle.includes('--') || RESERVED_HANDLES.has(handle)) return null;
  return handle;
}

/** A suggested handle from the business name ("Kumar's Ayurveda" -> "kumars-ayurveda"). */
export function suggestHandle(name: string): string {
  const base = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36).replace(/-+$/g, '');
  return normaliseHandle(base) ?? normaliseHandle(`${base}-shop`) ?? 'my-shop';
}

export const PUBLIC_SHOP_PATH = '/s/';
