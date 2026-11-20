/**
 * Theme editor content for the public shop (store plan Phase 2): sections
 * with their blocks, the top menu, the footer, store pages and policy notes.
 *
 * Every section type is declared once in SECTION_SPECS as a fixed list of
 * fields (a short line, a paragraph, an image, a link, a choice, a number, a
 * category or a video link). The same spec validates what the editor sends
 * and draws the editor's form, and our own React components render the
 * result. Nothing here is customer code: texts are plain (React escapes them),
 * images are https URLs or media library ids, links are a fixed set of shop
 * paths or https URLs, and unknown keys are dropped. Client-safe.
 */
import {
  isShopTemplateId, MEDIA_REF, mediaIdOf, parseImageRef, parseThemeSettings, plainText, safeHttpsUrl, ShopThemeError,
  type ShopTemplateId, type ShopThemeSettings,
} from './shop-templates';

// ---------------------------------------------------------------------------
// Fields

export type ShopField =
  | { key: string; kind: 'line'; max: number }
  | { key: string; kind: 'text'; max: number }
  | { key: string; kind: 'image' }
  | { key: string; kind: 'link' }
  | { key: string; kind: 'video' }
  | { key: string; kind: 'category' }
  | { key: string; kind: 'collection' }
  | { key: string; kind: 'choice'; options: readonly string[] }
  | { key: string; kind: 'number'; min: number; max: number; default: number }
  /** A moment in time, stored as an ISO string in UTC (the offer countdown's end). */
  | { key: string; kind: 'datetime' };

export type FieldValue = string | number | null;
export type FieldValues = Record<string, FieldValue>;

const line = (key: string, max: number): ShopField => ({ key, kind: 'line', max });
const text = (key: string, max: number): ShopField => ({ key, kind: 'text', max });
const image: ShopField = { key: 'image', kind: 'image' };
const button: ShopField[] = [line('buttonLabel', 30), { key: 'buttonLink', kind: 'link' }];

export const SHOP_SECTION_TYPES = [
  'announcement', 'banner', 'slideshow', 'categories', 'featured_collection', 'product_grid', 'image_text', 'testimonials',
  'faq', 'video', 'text', 'whatsapp',
  'offer', 'trust_badges', 'logo_strip', 'gallery', 'signup', 'best_sellers', 'recently_viewed',
] as const;
export type ShopSectionType = (typeof SHOP_SECTION_TYPES)[number];
export const isSectionType = (value: unknown): value is ShopSectionType =>
  typeof value === 'string' && (SHOP_SECTION_TYPES as readonly string[]).includes(value);

export interface SectionSpec {
  fields: ShopField[];
  /** Repeated blocks inside the section (slides, testimonials, questions). */
  items?: { fields: ShopField[]; min: number; max: number };
}

export const PRODUCT_SORTS = ['featured', 'price_asc', 'price_desc', 'name'] as const;
export type ProductSort = (typeof PRODUCT_SORTS)[number];

/** The fixed icons a trust badge may show (drawn by our own icon set, never an uploaded file). */
export const TRUST_ICONS = ['truck', 'shield', 'returns', 'cash', 'leaf', 'star', 'support', 'badge'] as const;
export type TrustIcon = (typeof TRUST_ICONS)[number];

export const SECTION_SPECS: Record<ShopSectionType, SectionSpec> = {
  announcement: { fields: [line('text', 120), { key: 'link', kind: 'link' }] },
  banner: {
    fields: [{ key: 'style', kind: 'choice', options: ['auto', 'split', 'full', 'band'] }, image, line('heading', 80), line('text', 200), ...button],
  },
  slideshow: { fields: [], items: { fields: [image, line('heading', 80), line('text', 200), ...button], min: 1, max: 6 } },
  categories: { fields: [line('title', 60)] },
  featured_collection: {
    // A collection, when set, wins over the category (older saved themes only have the category).
    fields: [line('title', 60), { key: 'collection', kind: 'collection' }, { key: 'category', kind: 'category' },
      { key: 'limit', kind: 'number', min: 2, max: 12, default: 4 }],
  },
  product_grid: {
    fields: [line('title', 60), { key: 'sort', kind: 'choice', options: PRODUCT_SORTS },
      { key: 'limit', kind: 'number', min: 2, max: 24, default: 8 }],
  },
  image_text: {
    fields: [image, line('heading', 80), text('text', 1000), ...button, { key: 'imageSide', kind: 'choice', options: ['left', 'right'] }],
  },
  testimonials: { fields: [line('title', 60)], items: { fields: [text('quote', 400), line('name', 60)], min: 1, max: 8 } },
  faq: { fields: [line('title', 60)], items: { fields: [line('question', 160), text('answer', 1000)], min: 1, max: 20 } },
  video: { fields: [line('title', 60), { key: 'video', kind: 'video' }, line('caption', 200)] },
  text: { fields: [line('heading', 80), text('text', 2000), { key: 'align', kind: 'choice', options: ['left', 'center'] }] },
  whatsapp: { fields: [line('heading', 80), line('text', 200), line('buttonLabel', 30), line('message', 200)] },
  /** An offer with a countdown; it hides itself once `endsAt` has passed. */
  offer: { fields: [line('heading', 80), line('text', 200), { key: 'endsAt', kind: 'datetime' }, ...button] },
  trust_badges: { fields: [line('title', 60)], items: { fields: [{ key: 'icon', kind: 'choice', options: TRUST_ICONS }, line('text', 60)], min: 1, max: 4 } },
  logo_strip: { fields: [line('title', 60)], items: { fields: [image, line('name', 60)], min: 1, max: 8 } },
  gallery: { fields: [line('title', 60)], items: { fields: [image, { key: 'link', kind: 'link' }], min: 1, max: 12 } },
  /** Sign-up: opens the shop's WhatsApp chat with "Subscribe" typed in (there is no anonymous subscriber list to write to). */
  signup: { fields: [line('heading', 80), line('text', 200), line('buttonLabel', 30)] },
  /** Ranked by real sales (paid or confirmed cash on delivery) in the last `days` days. */
  best_sellers: { fields: [line('title', 60), { key: 'days', kind: 'number', min: 7, max: 365, default: 30 }, { key: 'limit', kind: 'number', min: 2, max: 12, default: 4 }] },
  /** The visitor's own recently opened products, from their browser only. */
  recently_viewed: { fields: [line('title', 60), { key: 'limit', kind: 'number', min: 2, max: 12, default: 4 }] },
};

export interface ShopSection {
  id: string;
  type: ShopSectionType;
  hidden: boolean;
  settings: FieldValues;
  items: FieldValues[];
}

// ---------------------------------------------------------------------------
// Links

export const SHOP_PAGE_SLUGS = ['about', 'contact', 'faq', 'shipping', 'refund', 'privacy', 'terms'] as const;
export type ShopPageSlug = (typeof SHOP_PAGE_SLUGS)[number];
export const POLICY_SLUGS = ['shipping', 'refund', 'privacy', 'terms'] as const;
export type PolicySlug = (typeof POLICY_SLUGS)[number];
export const isPageSlug = (value: unknown): value is ShopPageSlug =>
  typeof value === 'string' && (SHOP_PAGE_SLUGS as readonly string[]).includes(value);

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
/** Paths inside the shop a link may point at ("" is the home page). */
const SHOP_PATH = new RegExp(`^/(?:all|cart|c/${UUID}|p/${UUID}|collections/[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?|pages/(?:${SHOP_PAGE_SLUGS.join('|')}))?$`);

/** A link as stored: a shop path ("/", "/all", "/c/<id>", "/p/<id>", "/collections/<slug>", "/pages/<slug>", "/cart") or an https URL. */
export function parseLink(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') throw new ShopThemeError(field);
  const trimmed = value.trim();
  if (trimmed.startsWith('/')) {
    const path = trimmed.toLowerCase();
    if (!SHOP_PATH.test(path)) throw new ShopThemeError(field);
    return path;
  }
  const url = safeHttpsUrl(trimmed);
  if (!url) throw new ShopThemeError(field);
  return url;
}

/** Where a stored link goes on the shop at `base` ("/s/<handle>"). */
export function shopHref(link: string | null, base: string): { href: string; external: boolean } | null {
  if (!link) return null;
  if (link.startsWith('/')) return { href: link === '/' ? base : `${base}${link}`, external: false };
  return /^https:\/\//.test(link) ? { href: link, external: true } : null;
}

// ---------------------------------------------------------------------------
// Videos

/** A YouTube video id from a youtube.com or youtu.be link, or null. */
export function youtubeId(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^(www\.|m\.)/, '');
    const id = host === 'youtu.be' ? u.pathname.slice(1)
      : host === 'youtube.com' ? (u.searchParams.get('v') ?? u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/)?.[1] ?? null)
        : null;
    return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Parsing

const SECTION_ID = /^[a-z0-9]{4,16}$/;
export const SHOP_CONTENT_LIMITS = { sections: 25, menu: 8, footerLinks: 12, bytes: 100_000 } as const;

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function paragraphs(value: unknown, max: number, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') throw new ShopThemeError(field);
  // Line breaks kept (at most one blank line in a row); other control characters out.
  const cleaned = value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (cleaned.length > max) throw new ShopThemeError(field);
  return cleaned || null;
}

/** Earliest and latest moments a datetime field accepts. */
export const MOMENT_RANGE = { min: Date.UTC(2020, 0, 1), max: Date.UTC(2100, 0, 1) } as const;

/** An ISO date-time (with a zone) between 2020 and 2100, normalised to UTC, or null. */
export function parseMoment(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(value)) throw new ShopThemeError(field);
  const at = Date.parse(value);
  if (!Number.isFinite(at) || at < MOMENT_RANGE.min || at > MOMENT_RANGE.max) throw new ShopThemeError(field);
  return new Date(at).toISOString();
}

function parseField(field: ShopField, value: unknown, path: string): FieldValue {
  const at = `${path}.${field.key}`;
  switch (field.kind) {
    case 'line': return plainText(value, field.max, at);
    case 'text': return paragraphs(value, field.max, at);
    case 'image': return parseImageRef(value, at);
    case 'link': return parseLink(value, at);
    case 'video': {
      if (value === null || value === undefined || value === '') return null;
      const url = safeHttpsUrl(value);
      if (!url) throw new ShopThemeError(at);
      return url;
    }
    case 'category': {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value !== 'string' || !new RegExp(`^${UUID}$`).test(value.toLowerCase())) throw new ShopThemeError(at);
      return value.toLowerCase();
    }
    case 'collection': {
      if (value === null || value === undefined || value === '') return null;
      if (typeof value !== 'string' || !new RegExp(`^${UUID}$`).test(value.toLowerCase())) throw new ShopThemeError(at);
      return value.toLowerCase();
    }
    case 'choice': {
      if (value === null || value === undefined || value === '') return field.options[0];
      if (typeof value !== 'string' || !field.options.includes(value)) throw new ShopThemeError(at);
      return value;
    }
    case 'number': {
      if (value === null || value === undefined || value === '') return field.default;
      if (!Number.isInteger(value) || (value as number) < field.min || (value as number) > field.max) throw new ShopThemeError(at);
      return value as number;
    }
    case 'datetime': return parseMoment(value, at);
  }
}

function parseValues(fields: ShopField[], raw: unknown, path: string): FieldValues {
  const source = isObject(raw) ? raw : {};
  return Object.fromEntries(fields.map((f) => [f.key, parseField(f, source[f.key], path)]));
}

export function parseSection(raw: unknown, path: string): ShopSection {
  if (!isObject(raw)) throw new ShopThemeError(path);
  if (typeof raw.id !== 'string' || !SECTION_ID.test(raw.id)) throw new ShopThemeError(`${path}.id`);
  if (!isSectionType(raw.type)) throw new ShopThemeError(`${path}.type`);
  const spec = SECTION_SPECS[raw.type];
  let items: FieldValues[] = [];
  if (spec.items) {
    if (!Array.isArray(raw.items) || raw.items.length > spec.items.max) throw new ShopThemeError(`${path}.items`);
    items = raw.items.map((item, i) => parseValues(spec.items!.fields, item, `${path}.items.${i}`));
  }
  return { id: raw.id, type: raw.type, hidden: raw.hidden === true, settings: parseValues(spec.fields, raw.settings, `${path}.settings`), items };
}

export interface ShopMenuLink { label: string; link: string }

function parseLinks(raw: unknown, max: number, path: string): ShopMenuLink[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > max) throw new ShopThemeError(path);
  return raw.map((item, i) => {
    const label = plainText(isObject(item) ? item.label : null, 40, `${path}.${i}.label`);
    const link = parseLink(isObject(item) ? item.link : null, `${path}.${i}.link`);
    if (!label || !link) throw new ShopThemeError(`${path}.${i}`);
    return { label, link };
  });
}

export interface ShopFooter {
  text: string | null;
  links: ShopMenuLink[];
  contact: { phone: string | null; email: string | null; address: string | null; hours: string | null };
}

export interface ShopPages {
  about: { title: string | null; body: string | null; image: string | null };
  contact: { title: string | null; body: string | null };
  faq: { title: string | null; items: Array<{ question: string; answer: string }> };
}

/** Everything the editor manages besides the template and brand settings. */
export interface ShopContent {
  sections: ShopSection[];
  menu: ShopMenuLink[];
  footer: ShopFooter;
  pages: ShopPages;
  /** An extra note the shop adds under each generated policy page. */
  policies: Record<PolicySlug, string | null>;
}

/** The editor's draft: template, brand settings and content together. */
export interface ShopDocument extends ShopContent {
  template: ShopTemplateId;
  theme: ShopThemeSettings;
}

const EMAIL = /^[^\s@<>()]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function parseFooter(raw: unknown): ShopFooter {
  const f = isObject(raw) ? raw : {};
  const c = isObject(f.contact) ? f.contact : {};
  const email = plainText(c.email, 120, 'footer.contact.email');
  if (email && !EMAIL.test(email)) throw new ShopThemeError('footer.contact.email');
  const phone = plainText(c.phone, 24, 'footer.contact.phone');
  if (phone && !/^\+?[0-9 ()-]{6,24}$/.test(phone)) throw new ShopThemeError('footer.contact.phone');
  return {
    text: plainText(f.text, 300, 'footer.text'),
    links: parseLinks(f.links, SHOP_CONTENT_LIMITS.footerLinks, 'footer.links'),
    contact: { phone, email: email?.toLowerCase() ?? null, address: paragraphs(c.address, 300, 'footer.contact.address'), hours: plainText(c.hours, 120, 'footer.contact.hours') },
  };
}

function parsePages(raw: unknown): ShopPages {
  const p = isObject(raw) ? raw : {};
  const about = isObject(p.about) ? p.about : {};
  const contact = isObject(p.contact) ? p.contact : {};
  const faq = isObject(p.faq) ? p.faq : {};
  if (faq.items !== undefined && faq.items !== null && (!Array.isArray(faq.items) || faq.items.length > 30)) throw new ShopThemeError('pages.faq.items');
  const items = (Array.isArray(faq.items) ? faq.items : []).map((item, i) => ({
    question: plainText(isObject(item) ? item.question : null, 160, `pages.faq.items.${i}.question`),
    answer: paragraphs(isObject(item) ? item.answer : null, 1000, `pages.faq.items.${i}.answer`),
  })).filter((item): item is { question: string; answer: string } => !!item.question && !!item.answer);
  return {
    about: { title: plainText(about.title, 80, 'pages.about.title'), body: paragraphs(about.body, 5000, 'pages.about.body'), image: parseImageRef(about.image, 'pages.about.image') },
    contact: { title: plainText(contact.title, 80, 'pages.contact.title'), body: paragraphs(contact.body, 2000, 'pages.contact.body') },
    faq: { title: plainText(faq.title, 80, 'pages.faq.title'), items },
  };
}

function parsePolicies(raw: unknown): Record<PolicySlug, string | null> {
  const p = isObject(raw) ? raw : {};
  return Object.fromEntries(POLICY_SLUGS.map((slug) => [slug, paragraphs(p[slug], 4000, `policies.${slug}`)])) as Record<PolicySlug, string | null>;
}

function parseSections(raw: unknown): ShopSection[] {
  if (!Array.isArray(raw) || raw.length > SHOP_CONTENT_LIMITS.sections) throw new ShopThemeError('sections');
  const sections = raw.map((s, i) => parseSection(s, `sections.${i}`));
  if (new Set(sections.map((s) => s.id)).size !== sections.length) throw new ShopThemeError('sections.id');
  return sections;
}

/** Validate content from the editor. A bad value throws ShopThemeError with its path. */
export function parseShopContent(input: unknown): ShopContent {
  if (!isObject(input)) throw new ShopThemeError('document');
  const content: ShopContent = {
    sections: parseSections(input.sections ?? []),
    menu: parseLinks(input.menu, SHOP_CONTENT_LIMITS.menu, 'menu'),
    footer: parseFooter(input.footer),
    pages: parsePages(input.pages),
    policies: parsePolicies(input.policies),
  };
  if (JSON.stringify(content).length > SHOP_CONTENT_LIMITS.bytes) throw new ShopThemeError('document');
  return content;
}

/** Validate a whole draft (template, brand settings and content). */
export function parseShopDocument(input: unknown): ShopDocument {
  if (!isObject(input)) throw new ShopThemeError('document');
  if (!isShopTemplateId(input.template)) throw new ShopThemeError('template');
  return { template: input.template, theme: parseThemeSettings(input.theme ?? {}), ...parseShopContent(input) };
}

/** The sections a template starts with: the Phase 1 home page (banner, categories, featured products). */
export function defaultSections(): ShopSection[] {
  return [
    { id: 'banner1', type: 'banner', hidden: false, settings: parseValues(SECTION_SPECS.banner.fields, {}, 'd'), items: [] },
    { id: 'cats1', type: 'categories', hidden: false, settings: parseValues(SECTION_SPECS.categories.fields, {}, 'd'), items: [] },
    { id: 'grid1', type: 'product_grid', hidden: false, settings: parseValues(SECTION_SPECS.product_grid.fields, {}, 'd'), items: [] },
  ];
}

/** A new section of `type` with empty settings (and one empty block when it has blocks). */
export function newSection(type: ShopSectionType, id: string): ShopSection {
  const spec = SECTION_SPECS[type];
  return {
    id, type, hidden: false, settings: parseValues(spec.fields, {}, 'n'),
    items: spec.items ? [parseValues(spec.items.fields, {}, 'n')] : [],
  };
}

export const emptyContent = (): ShopContent => ({
  sections: defaultSections(), menu: [], footer: parseFooter({}), pages: parsePages({}), policies: parsePolicies({}),
});

/**
 * Stored content read back leniently: a section, menu, footer or page that no
 * longer validates is dropped, never rendered. `{}` (a shop from before the
 * editor) is the template's default home page.
 */
export function readShopContent(stored: unknown): ShopContent {
  if (!isObject(stored) || stored.sections === undefined) return { ...emptyContent(), ...(isObject(stored) ? softRest(stored) : {}) };
  const sections = Array.isArray(stored.sections)
    ? stored.sections.slice(0, SHOP_CONTENT_LIMITS.sections).flatMap((s, i) => { try { return [parseSection(s, `sections.${i}`)]; } catch { return []; } })
    : [];
  const unique = sections.filter((s, i) => sections.findIndex((o) => o.id === s.id) === i);
  return { ...emptyContent(), ...softRest(stored), sections: unique };
}

function softRest(stored: Record<string, unknown>): Partial<ShopContent> {
  const out: Partial<ShopContent> = {};
  const attempt = <K extends keyof ShopContent>(key: K, parse: () => ShopContent[K]) => {
    try { out[key] = parse(); } catch { /* dropped */ }
  };
  attempt('menu', () => parseLinks(stored.menu, SHOP_CONTENT_LIMITS.menu, 'menu'));
  attempt('footer', () => parseFooter(stored.footer));
  attempt('pages', () => parsePages(stored.pages));
  attempt('policies', () => parsePolicies(stored.policies));
  return out;
}

export function readShopDocument(stored: unknown, fallback: { template: unknown; theme: unknown; document: unknown }): ShopDocument {
  if (isObject(stored)) {
    try {
      return parseShopDocument(stored);
    } catch { /* fall through to the published state */ }
  }
  let theme: ShopThemeSettings;
  try { theme = parseThemeSettings(fallback.theme ?? {}); } catch { theme = parseThemeSettings({}); }
  return { template: isShopTemplateId(fallback.template) ? fallback.template : 'wellness', theme, ...readShopContent(fallback.document) };
}

/** The content part of a draft, as stored in shop_storefronts.document. */
export const contentOf = (doc: ShopDocument): ShopContent =>
  ({ sections: doc.sections, menu: doc.menu, footer: doc.footer, pages: doc.pages, policies: doc.policies });

// ---------------------------------------------------------------------------
// Reading content for pages

/** Every media library id the content and theme name (the public media route serves only these). */
export function contentMediaIds(theme: ShopThemeSettings, content: ShopContent): string[] {
  const refs: (string | null)[] = [theme.logo, theme.banner, content.pages.about.image];
  for (const section of content.sections) {
    if (section.hidden) continue;
    const spec = SECTION_SPECS[section.type];
    for (const f of spec.fields) if (f.kind === 'image') refs.push(section.settings[f.key] as string | null);
    for (const item of section.items) for (const f of spec.items?.fields ?? []) if (f.kind === 'image') refs.push(item[f.key] as string | null);
  }
  return [...new Set(refs.map((r) => mediaIdOf(r)).filter((id): id is string => !!id))];
}

export const isMediaRef = (value: unknown): value is string => typeof value === 'string' && MEDIA_REF.test(value);

/** Whether the shop has an About, Contact or FAQ page to link to. */
export function pagesOn(content: ShopContent): Record<'about' | 'contact' | 'faq', boolean> {
  const c = content.footer.contact;
  return {
    about: !!content.pages.about.body,
    contact: !!content.pages.contact.body || !!(c.phone || c.email || c.address || c.hours),
    faq: content.pages.faq.items.length > 0,
  };
}

export interface PickableProduct { id: string; name: string; categoryId: string | null; variants: Array<{ priceMinor: number }> }

/** The products a product section shows, from the shop's products in catalogue order. */
export function pickProducts<P extends PickableProduct>(products: P[], settings: FieldValues, categoryIds: (id: string) => Set<string> | null): P[] {
  const limit = typeof settings.limit === 'number' ? settings.limit : 8;
  let list = products;
  if (typeof settings.category === 'string') {
    const ids = categoryIds(settings.category);
    list = ids ? products.filter((p) => p.categoryId && ids.has(p.categoryId)) : [];
  }
  const low = (p: P) => Math.min(...p.variants.map((v) => v.priceMinor));
  if (settings.sort === 'price_asc') list = [...list].sort((a, b) => low(a) - low(b));
  else if (settings.sort === 'price_desc') list = [...list].sort((a, b) => low(b) - low(a));
  else if (settings.sort === 'name') list = [...list].sort((a, b) => a.name.localeCompare(b.name));
  return list.slice(0, limit);
}

/** The products of a collection, in the collection's order (ids), limited. Ids outside `products` are skipped. */
export function pickCollectionProducts<P extends { id: string }>(products: P[], productIds: string[], limit: number): P[] {
  const byId = new Map(products.map((p) => [p.id, p]));
  return productIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : [])).slice(0, limit);
}

/** A category and its sub-categories, from (id, parentId) rows. */
export function categoryTree(rows: Array<{ id: string; parentId: string | null }>): (id: string) => Set<string> | null {
  return (id) => {
    if (!rows.some((r) => r.id === id)) return null;
    return new Set([id, ...rows.filter((r) => r.parentId === id).map((r) => r.id)]);
  };
}
