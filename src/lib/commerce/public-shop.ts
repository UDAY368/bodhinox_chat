/**
 * The public shop at /s/<handle> (store plan Phase 1).
 *
 * Anyone can browse a published shop: its settings, published products with
 * priced, live variants, and the categories that hold them. Nothing else of
 * the workspace is read for a visitor: no contacts, orders, prices of draft
 * products or archived variants. The handle is resolved through the fixed
 * SECURITY DEFINER lookup resolve_public_shop (published shops only); all
 * other work runs in withTenant(role 'owner') on the worker client after the
 * storefront plan feature and the suspension check, so an unpublished,
 * suspended or downgraded shop is the same plain "not found".
 *
 * The cart lives in the visitor's browser. Placing an order needs a known
 * contact, by one of two paths, and both end in an ordinary storefront
 * session (storefront.ts), so pricing, stock holds, coupons, COD and
 * Razorpay are unchanged:
 * - a WhatsApp one-time code sent with the shop's approved authentication
 *   template (shop_otp_challenges; only an HMAC of the code is stored), or
 * - "Order on WhatsApp": the cart is saved under a six-character code
 *   (shop_cart_codes) and the buyer sends "ORDER <CODE>" to the shop's
 *   number; the inbound job claims it for the sender and replies with the
 *   checkout link (handleShopCartCode).
 *
 * Every send is an outbound intent (dispatchOnce). Logs carry codes only,
 * never a phone number, a one-time code or cart contents.
 */
import { createHmac, hkdfSync, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { AuthError } from '@/lib/auth/errors';
import { appOrigin, hashToken } from '@/lib/auth/csrf';
import { enforceAuthRateLimit } from '@/lib/auth/service';
import { findOrCreateContact, resolveAuditUserId } from '@/lib/api/v1/contacts';
import { PlanLimitError, requireFeature } from '@/lib/billing/entitlements';
import { requireSendingAllowed } from '@/lib/billing/suspension';
import { createAdminClient } from '@/lib/data/admin';
import { getAuthPrisma, getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { decrypt } from '@/lib/whatsapp/encryption';
import { MetaApiError, sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { assertTemplateOnNumber } from '@/lib/whatsapp/sender-config';
import type { MessageTemplate } from '@/types';
import { currencyExponent, minorFromDb } from './money';
import { CART_LIMITS, normaliseCart, type CartLine } from './pricing';
import { mediaIdOf, PUBLIC_SHOP_PATH, resolveTheme, SHOP_HANDLE, type ResolvedShopTheme, type ShopImageRef } from './shop-templates';
import {
  assertStoreOpenTx, issueSessionTx, linkMessageText, loadCatalogue, loadCatalogueCategories, loadVariants, seededUuid,
  sendStorefrontText, STOREFRONT_TTL,
} from './storefront';
import { deriveStorefrontToken, storefrontUrl } from './storefront-token';
import { isUuid, loadPricingSettings, StoreError } from './store-settings';

// ---------------------------------------------------------------------------
// Resolving a shop

export const isShopHandleFormat = (value: unknown): value is string => typeof value === 'string' && SHOP_HANDLE.test(value);

/** The workspace of a published shop, or null. */
export async function resolvePublicShop(handle: string): Promise<string | null> {
  if (!isShopHandleFormat(handle)) return null;
  const [hit] = await getWorkerPrisma().$queryRaw<{ account_id: string }[]>`
    SELECT account_id::text FROM resolve_public_shop(${handle})`;
  return hit?.account_id ?? null;
}

/** Tenant work for an anonymous visitor: worker client, owner role, the plan feature and the suspension check first. */
export function inShopTenant<T>(accountId: string, work: (tx: TenantTransaction) => Promise<T>): Promise<T> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    await requireFeature(tx, accountId, 'storefront');
    await requireSendingAllowed(tx, accountId);
    return work(tx);
  }, getWorkerPrisma());
}

/** A refusal that means "this shop is not open to the public" (the page shows a plain 404). */
export function isShopHidden(error: unknown): boolean {
  return error instanceof PlanLimitError || (error instanceof StoreError && (error.code === 'not_found' || error.code === 'feature_unavailable'))
    || (error instanceof AuthError && error.status === 403);
}

/** Run `work` for a published shop; null when the handle does not resolve or the shop is hidden. */
export async function withPublicShop<T>(handle: string, work: (tx: TenantTransaction, accountId: string) => Promise<T>): Promise<T | null> {
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  try {
    return await inShopTenant(accountId, (tx) => work(tx, accountId));
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// What a visitor sees

export interface PublicShop {
  handle: string;
  name: string;
  currency: string | null;
  pricesIncludeTax: boolean;
  theme: ResolvedShopTheme;
  /** Image URLs the page can load: an https URL as stored, or our own media route. */
  logoUrl: string | null;
  bannerUrl: string | null;
  /** wa.me digits for the chat button, when the shop set its number. */
  whatsappPhone: string | null;
  ordering: { otp: boolean; whatsapp: boolean };
  /** Checkout configured and on: the cart can be ordered. */
  checkoutOpen: boolean;
}

export interface PublicProduct {
  id: string;
  name: string;
  description: string | null;
  disclosure: string | null;
  categoryId: string | null;
  categoryName: string | null;
  images: string[];
  variants: Array<{ id: string; options: Record<string, string>; priceMinor: number; compareAtMinor: number | null; inStock: boolean }>;
}

interface StorefrontRow {
  handle: string; template: string; theme: unknown; whatsapp_config_id: string | null; whatsapp_phone: string | null;
  otp_template_id: string | null;
}

async function loadStorefrontRow(tx: TenantTransaction, accountId: string): Promise<StorefrontRow | null> {
  const [row] = await tx.$queryRaw<StorefrontRow[]>`
    SELECT handle, template, theme, whatsapp_config_id::text AS whatsapp_config_id, whatsapp_phone, otp_template_id::text AS otp_template_id
    FROM shop_storefronts WHERE account_id=${accountId}::uuid`;
  return row ?? null;
}

export const shopImageUrl = (handle: string, imageId: string) => `/api/public/store/${handle}/images/${imageId}`;
const themeImageUrl = (handle: string, ref: ShopImageRef | null): string | null => {
  if (!ref) return null;
  const mediaId = mediaIdOf(ref);
  return mediaId ? `/api/public/store/${handle}/media/${mediaId}` : ref;
};

export async function loadPublicShopTx(tx: TenantTransaction, accountId: string): Promise<PublicShop | null> {
  const row = await loadStorefrontRow(tx, accountId);
  if (!row) return null;
  const settings = await loadPricingSettings(tx, accountId);
  const [account] = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM accounts WHERE id=${accountId}::uuid`;
  const theme = resolveTheme(row.template, row.theme);
  return {
    handle: row.handle, name: settings?.storefront_title || account?.name || row.handle, currency: settings?.currency ?? null,
    pricesIncludeTax: settings?.prices_include_tax ?? true, theme,
    logoUrl: themeImageUrl(row.handle, theme.logo), bannerUrl: themeImageUrl(row.handle, theme.banner),
    whatsappPhone: row.whatsapp_phone,
    ordering: { otp: !!row.otp_template_id && !!row.whatsapp_config_id, whatsapp: !!row.whatsapp_phone && !!row.whatsapp_config_id },
    checkoutOpen: !!settings?.checkout_enabled,
  };
}

/** Products a page shows: published, with at least one priced live variant. Images as public URLs. */
async function loadProducts(tx: TenantTransaction, accountId: string, handle: string,
  where: { productId?: string; categoryId?: string; limit: number }): Promise<PublicProduct[]> {
  const productId = where.productId ?? null;
  const categoryId = where.categoryId ?? null;
  const rows = await tx.$queryRaw<{ id: string; name: string; description: string | null; disclosure: string | null;
    category_id: string | null; category: string | null }[]>`
    SELECT p.id::text AS id, p.name, p.description, p.disclosure, c.id::text AS category_id, c.name AS category FROM shop_products p
    LEFT JOIN shop_categories c ON c.account_id=p.account_id AND c.id=p.category_id AND c.archived_at IS NULL
    WHERE p.account_id=${accountId}::uuid AND p.status='published'
      AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)
      AND (${productId}::uuid IS NULL OR p.id=${productId}::uuid)
      AND (${categoryId}::uuid IS NULL OR c.id=${categoryId}::uuid OR c.parent_id=${categoryId}::uuid)
    ORDER BY COALESCE(c.position, 2147483647), p.name, p.id LIMIT ${where.limit}`;
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const variants = await tx.$queryRaw<{ id: string; product_id: string; option_values: Record<string, string>; price_minor: bigint;
    compare_at_minor: bigint | null; in_stock: boolean }[]>`
    SELECT v.id::text AS id, v.product_id::text AS product_id, v.option_values, v.price_minor, v.compare_at_minor,
      (NOT v.track_inventory OR COALESCE(l.on_hand - l.reserved, 0) > 0) AS in_stock
    FROM shop_variants v LEFT JOIN inventory_levels l ON l.account_id=v.account_id AND l.variant_id=v.id
    WHERE v.account_id=${accountId}::uuid AND v.product_id = ANY(${ids}::uuid[]) AND v.archived_at IS NULL AND v.price_minor IS NOT NULL
    ORDER BY v.position, v.sku`;
  const images = await tx.$queryRaw<{ id: string; product_id: string }[]>`
    SELECT id::text AS id, product_id::text AS product_id FROM shop_product_images
    WHERE account_id=${accountId}::uuid AND product_id = ANY(${ids}::uuid[]) ORDER BY position`;
  return rows.map((p) => ({
    id: p.id, name: p.name, description: p.description, disclosure: p.disclosure, categoryId: p.category_id, categoryName: p.category,
    images: images.filter((i) => i.product_id === p.id).map((i) => shopImageUrl(handle, i.id)),
    variants: variants.filter((v) => v.product_id === p.id).map((v) => ({
      id: v.id, options: v.option_values ?? {}, priceMinor: minorFromDb(v.price_minor) ?? 0,
      compareAtMinor: minorFromDb(v.compare_at_minor), inStock: v.in_stock,
    })),
  }));
}

export interface ShopHome { shop: PublicShop; featured: PublicProduct[]; categories: Array<{ id: string; name: string }> }

export const HOME_FEATURED = 8;

export function loadShopHome(handle: string): Promise<ShopHome | null> {
  return withPublicShop(handle, async (tx, accountId) => {
    const shop = await loadPublicShopTx(tx, accountId);
    if (!shop) return null;
    const [featured, categories] = await Promise.all([
      loadProducts(tx, accountId, handle, { limit: HOME_FEATURED }),
      loadCatalogueCategories(tx, accountId),
    ]);
    return { shop, featured, categories };
  });
}

export interface ShopProductPage { shop: PublicShop; product: PublicProduct; related: PublicProduct[] }

export function loadShopProduct(handle: string, productId: string): Promise<ShopProductPage | null> {
  if (!isUuid(productId)) return Promise.resolve(null);
  return withPublicShop(handle, async (tx, accountId) => {
    const shop = await loadPublicShopTx(tx, accountId);
    const [product] = await loadProducts(tx, accountId, handle, { productId, limit: 1 });
    if (!shop || !product) return null;
    const related = product.categoryId
      ? (await loadProducts(tx, accountId, handle, { categoryId: product.categoryId, limit: 5 })).filter((p) => p.id !== product.id).slice(0, 4)
      : [];
    return { shop, product, related };
  });
}

/** Products per category page, and the most a category page sorts and filters at once. */
export const CATEGORY_PAGE_SIZE = 24;
export const CATEGORY_SCAN_LIMIT = 500;
export type CategorySort = 'featured' | 'price_asc' | 'price_desc' | 'name';
export const CATEGORY_SORTS: CategorySort[] = ['featured', 'price_asc', 'price_desc', 'name'];

export interface CategoryQuery { sort?: unknown; min?: unknown; max?: unknown; option?: unknown; page?: unknown }

export interface ShopCategoryPage {
  shop: PublicShop;
  category: { id: string; name: string; parentId: string | null };
  children: Array<{ id: string; name: string }>;
  products: PublicProduct[];
  /** Option filters on offer: name -> values, from the category's products. */
  options: Record<string, string[]>;
  sort: CategorySort;
  page: number;
  pages: number;
  total: number;
}

const lowestPrice = (p: PublicProduct) => Math.min(...p.variants.map((v) => v.priceMinor));

/** Parse "Size:M" into a name and value, or null. */
function parseOptionFilter(value: unknown): { name: string; value: string } | null {
  if (typeof value !== 'string' || value.length > 120) return null;
  const at = value.indexOf(':');
  if (at <= 0) return null;
  return { name: value.slice(0, at), value: value.slice(at + 1) };
}

const wholeNumber = (value: unknown): number | null => {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return null;
  return Number(value);
};

/**
 * A category page: its products (and its sub-categories' products), sorted
 * and filtered by price (in major units) and by one option, 24 per page.
 */
export function loadShopCategory(handle: string, categoryId: string, query: CategoryQuery = {}): Promise<ShopCategoryPage | null> {
  if (!isUuid(categoryId)) return Promise.resolve(null);
  return withPublicShop(handle, async (tx, accountId) => {
    const shop = await loadPublicShopTx(tx, accountId);
    const [category] = await tx.$queryRaw<{ id: string; name: string; parent_id: string | null }[]>`
      SELECT id::text AS id, name, parent_id::text AS parent_id FROM shop_categories
      WHERE account_id=${accountId}::uuid AND id=${categoryId}::uuid AND archived_at IS NULL`;
    if (!shop || !category) return null;
    const children = await tx.$queryRaw<{ id: string; name: string }[]>`
      SELECT id::text AS id, name FROM shop_categories WHERE account_id=${accountId}::uuid AND parent_id=${categoryId}::uuid
        AND archived_at IS NULL ORDER BY position, name LIMIT 50`;
    const all = await loadProducts(tx, accountId, handle, { categoryId, limit: CATEGORY_SCAN_LIMIT });
    const options: Record<string, Set<string>> = {};
    for (const p of all) for (const v of p.variants) for (const [name, value] of Object.entries(v.options)) (options[name] ??= new Set()).add(value);

    const sort = CATEGORY_SORTS.includes(query.sort as CategorySort) ? query.sort as CategorySort : 'featured';
    const min = wholeNumber(query.min);
    const max = wholeNumber(query.max);
    const option = parseOptionFilter(query.option);
    // The price filter is in whole currency units (₹500), the prices in minor units.
    const unit = 10 ** currencyExponent(shop.currency ?? 'INR');
    let products = all.filter((p) => p.variants.some((v) =>
      (min === null || v.priceMinor >= min * unit) && (max === null || v.priceMinor <= max * unit)
      && (!option || v.options[option.name] === option.value)));
    if (sort === 'price_asc') products = [...products].sort((a, b) => lowestPrice(a) - lowestPrice(b));
    if (sort === 'price_desc') products = [...products].sort((a, b) => lowestPrice(b) - lowestPrice(a));
    if (sort === 'name') products = [...products].sort((a, b) => a.name.localeCompare(b.name));
    const pages = Math.max(1, Math.ceil(products.length / CATEGORY_PAGE_SIZE));
    const page = Math.min(pages, Math.max(1, wholeNumber(query.page) ?? 1));
    return {
      shop, category: { id: category.id, name: category.name, parentId: category.parent_id }, children,
      products: products.slice((page - 1) * CATEGORY_PAGE_SIZE, page * CATEGORY_PAGE_SIZE),
      options: Object.fromEntries(Object.entries(options).map(([k, v]) => [k, [...v].sort()])),
      sort, page, pages, total: products.length,
    };
  });
}

/** All listed products for the "all products" page (first page of the catalogue order). */
export function loadShopAll(handle: string, cursor?: string): Promise<{ shop: PublicShop; products: PublicProduct[]; next: string | null } | null> {
  return withPublicShop(handle, async (tx, accountId) => {
    const shop = await loadPublicShopTx(tx, accountId);
    if (!shop) return null;
    const page = await loadCatalogue(tx, accountId, { cursor });
    return {
      shop, next: page.nextCursor,
      products: page.products.map((p) => ({
        id: p.id, name: p.name, description: p.description, disclosure: p.disclosure, categoryId: null, categoryName: p.categoryName,
        images: p.images.map((id) => shopImageUrl(handle, id)),
        variants: p.variants.map((v) => ({ id: v.id, options: v.options, priceMinor: v.priceMinor, compareAtMinor: v.compareAtMinor, inStock: v.inStock })),
      })),
    };
  });
}

// ---------------------------------------------------------------------------
// The browser cart

export interface CartPreviewLine {
  variantId: string;
  productId: string;
  name: string;
  options: Record<string, string>;
  qty: number;
  unitPriceMinor: number;
  lineTotalMinor: number;
  /** Units that can be bought now (null: not tracked). */
  available: number | null;
}
export interface CartPreview {
  lines: CartPreviewLine[];
  /** Variants that are no longer on sale, dropped from the cart. */
  removed: string[];
  subtotalMinor: number;
  currency: string | null;
}

/** Validate raw browser lines into a normalised cart, or throw invalid_cart. */
export function parseCartLines(input: unknown): CartLine[] {
  if (!Array.isArray(input) || !input.length || input.length > CART_LIMITS.maxLines) throw new StoreError('invalid_cart');
  const raw = input.map((l) => ({
    variantId: l && typeof l === 'object' ? (l as Record<string, unknown>).variantId : null,
    qty: l && typeof l === 'object' ? (l as Record<string, unknown>).qty : null,
  }));
  if (raw.some((l) => !isUuid(l.variantId))) throw new StoreError('invalid_cart');
  const lines = normaliseCart(raw as CartLine[]);
  if (!lines || !lines.length) throw new StoreError('invalid_cart');
  return lines;
}

/** Current names and prices for the browser cart. Unsellable lines are reported, not priced. */
export async function previewCartTx(tx: TenantTransaction, accountId: string, lines: CartLine[]): Promise<CartPreview> {
  const settings = await loadPricingSettings(tx, accountId);
  const variants = await loadVariants(tx, accountId, lines.map((l) => l.variantId));
  const out: CartPreviewLine[] = [];
  const removed: string[] = [];
  for (const line of lines) {
    const v = variants.get(line.variantId);
    if (!v || !v.sellable || v.priceMinor === null) {
      removed.push(line.variantId);
      continue;
    }
    out.push({
      variantId: v.id, productId: v.productId, name: v.productName, options: v.optionValues, qty: line.qty,
      unitPriceMinor: v.priceMinor, lineTotalMinor: v.priceMinor * line.qty, available: v.available,
    });
  }
  return { lines: out, removed, subtotalMinor: out.reduce((s, l) => s + l.lineTotalMinor, 0), currency: settings?.currency ?? null };
}

/** Every line must be on sale now; the stored cart of a code or a challenge is always sellable when saved. */
async function assertSellable(tx: TenantTransaction, accountId: string, lines: CartLine[]): Promise<void> {
  const preview = await previewCartTx(tx, accountId, lines);
  if (preview.removed.length) throw new StoreError('variant_unavailable', { variantId: preview.removed[0] });
}

const cartJson = (lines: CartLine[]) => JSON.stringify(lines.map((l) => ({ variant_id: l.variantId, qty: l.qty })));
const storedCart = (value: unknown): CartLine[] => (Array.isArray(value) ? value : []).flatMap((l) =>
  l && typeof l === 'object' && isUuid((l as { variant_id?: unknown }).variant_id) && Number.isInteger((l as { qty?: unknown }).qty)
    ? [{ variantId: (l as { variant_id: string }).variant_id, qty: (l as { qty: number }).qty }] : []);

/** Put a cart into a freshly issued session (version 1, nothing else set yet). */
async function seedSessionCart(tx: TenantTransaction, accountId: string, sessionId: string, lines: CartLine[]): Promise<void> {
  await tx.$executeRaw`UPDATE storefront_sessions SET cart=${cartJson(lines)}::jsonb
    WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid AND cart='[]'::jsonb AND order_id IS NULL`;
}

// ---------------------------------------------------------------------------
// Durable limits (hashed keys in auth_rate_limits)

export const PUBLIC_SHOP_LIMITS = {
  /** identity: client IP */
  otpStartIp: { action: 'shop_otp_start_ip', maximum: 10, windowSeconds: 3600 },
  /** identity: account + phone */
  otpStartPhone: { action: 'shop_otp_start_phone', maximum: 3, windowSeconds: 900 },
  /** identity: client IP */
  otpVerifyIp: { action: 'shop_otp_verify_ip', maximum: 30, windowSeconds: 600 },
  /** identity: client IP */
  cartCodeIp: { action: 'shop_cart_code_ip', maximum: 20, windowSeconds: 3600 },
  /** identity: contact id; an unknown "ORDER <CODE>" from one sender */
  cartCodeMiss: { action: 'shop_cart_code_miss', maximum: 10, windowSeconds: 3600 },
} as const;

function limit(kind: keyof typeof PUBLIC_SHOP_LIMITS, identity: string): Promise<void> {
  const { action, maximum, windowSeconds } = PUBLIC_SHOP_LIMITS[kind];
  return enforceAuthRateLimit(action, identity, maximum, windowSeconds);
}

// ---------------------------------------------------------------------------
// WhatsApp one-time code

export const OTP = { digits: 6, ttlMinutes: 10, maxAttempts: 5 } as const;

function otpKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error('ENCRYPTION_KEY must be a 32-byte hex key');
  return Buffer.from(hkdfSync('sha256', Buffer.from(hex, 'hex'), Buffer.alloc(0), 'shop-otp', 32));
}

/** HMAC of a code bound to its challenge, so a stored hash says nothing about another challenge. */
export function otpHash(challengeId: string, code: string): string {
  return createHmac('sha256', otpKey()).update(`${challengeId}:${code}`).digest('hex');
}

export function newOtpCode(): string {
  return String(randomInt(0, 10 ** OTP.digits)).padStart(OTP.digits, '0');
}

/** E.164 with the leading +, or null. */
export function normaliseBuyerPhone(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 32) return null;
  const digits = parseInternationalPhone(value);
  return digits && /^[1-9][0-9]{7,14}$/.test(digits) ? `+${digits}` : null;
}

interface OtpSender { phoneNumberId: string; accessTokenEnc: string; template: MessageTemplate; language: string }

/** The approved authentication template on the shop's number, ready to send, or a StoreError. */
async function loadOtpSender(tx: TenantTransaction, accountId: string, row: StorefrontRow): Promise<OtpSender> {
  if (!row.otp_template_id || !row.whatsapp_config_id) throw new StoreError('otp_unavailable');
  let config;
  try {
    config = await getNumberConfig(tx, accountId, row.whatsapp_config_id);
  } catch (error) {
    if (error instanceof NoNumberError) throw new StoreError('otp_unavailable');
    throw error;
  }
  if (isNumberDisconnected(config) || !config.phone_number_id || !config.access_token) throw new StoreError('otp_unavailable');
  const [template] = await tx.$queryRaw<MessageTemplate[]>`SELECT * FROM message_templates
    WHERE account_id=${accountId}::uuid AND id=${row.otp_template_id}::uuid`;
  const status = String(template?.status ?? '').toUpperCase();
  if (!template || status !== 'APPROVED' || template.template_kind !== 'authentication') throw new StoreError('otp_unavailable');
  try {
    assertTemplateOnNumber(template, config);
  } catch {
    throw new StoreError('otp_unavailable');
  }
  return { phoneNumberId: config.phone_number_id, accessTokenEnc: config.access_token, template, language: template.language ?? 'en_US' };
}

/** The shop is open for an order: a storefront row, checkout configured and on. */
async function openShopRow(tx: TenantTransaction, accountId: string): Promise<StorefrontRow> {
  await assertStoreOpenTx(tx, accountId, 'shop');
  const row = await loadStorefrontRow(tx, accountId);
  if (!row) throw new StoreError('not_found');
  return row;
}

export interface OtpStartInput { phone: unknown; cart: unknown; clientIp: string }

/**
 * Send a one-time code to the buyer's WhatsApp for this cart. Returns the
 * challenge id the page sends back with the code. Refusals: invalid
 * (phone), invalid_cart, variant_unavailable, otp_unavailable, checkout_disabled,
 * store_not_configured, too_many (AuthError 429), send_failed, send_uncertain.
 */
export async function startOtp(handle: string, input: OtpStartInput): Promise<{ challengeId: string; expiresAt: string } | null> {
  const phone = normaliseBuyerPhone(input.phone);
  if (!phone) throw new StoreError('invalid', { field: 'phone' });
  const lines = parseCartLines(input.cart);
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  await limit('otpStartIp', input.clientIp);
  const code = newOtpCode();
  let prepared: { challengeId: string; expiresAt: Date; sender: OtpSender };
  try {
    prepared = await inShopTenant(accountId, async (tx) => {
      const row = await openShopRow(tx, accountId);
      const sender = await loadOtpSender(tx, accountId, row);
      await assertSellable(tx, accountId, lines);
      // Per number, after every other check, so a closed shop never spends the buyer's allowance.
      await limit('otpStartPhone', `${accountId}:${phone}`);
      const challengeId = randomUUID();
      const [inserted] = await tx.$queryRaw<{ expires_at: Date }[]>`
        INSERT INTO shop_otp_challenges(id,account_id,phone,code_hash,cart,expires_at)
        VALUES(${challengeId}::uuid,${accountId}::uuid,${phone},${otpHash(challengeId, code)},${cartJson(lines)}::jsonb,
          now() + make_interval(mins => ${OTP.ttlMinutes}))
        RETURNING expires_at`;
      return { challengeId, expiresAt: inserted.expires_at, sender };
    });
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
  const { sender } = prepared;
  try {
    await dispatchOnce(accountId, `shop-otp:${prepared.challengeId}`, () => sendTemplateMessage({
      phoneNumberId: sender.phoneNumberId, accessToken: decrypt(sender.accessTokenEnc), to: phone.slice(1),
      templateName: sender.template.name, language: sender.language, template: sender.template, messageParams: { authCode: code },
    }));
  } catch (error) {
    if (error instanceof UncertainDispatchError) throw new StoreError('send_uncertain');
    if (error instanceof MetaApiError) throw new StoreError('send_failed');
    throw error;
  }
  return { challengeId: prepared.challengeId, expiresAt: prepared.expiresAt.toISOString() };
}

export interface OtpVerifyInput { challengeId: unknown; code: unknown; clientIp: string }

interface ChallengeRow { id: string; phone: string; code_hash: string; cart: unknown; attempts: number; expires_at: Date;
  verified_at: Date | null; session_id: string | null }

/**
 * Check the code and open checkout: the buyer's contact is found or created
 * by phone, and a storefront session is issued with the cart. A replay of a
 * verified challenge answers the same link. Refusals: otp_invalid,
 * otp_expired, otp_locked, contact_blocked, too_many.
 */
export async function verifyOtp(handle: string, input: OtpVerifyInput): Promise<{ url: string } | null> {
  if (!isUuid(input.challengeId) || typeof input.code !== 'string' || !/^\d{6}$/.test(input.code.trim()))
    throw new StoreError('otp_invalid');
  const challengeId = input.challengeId;
  const code = input.code.trim();
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  await limit('otpVerifyIp', input.clientIp);
  const sessionId = seededUuid(`storefront:public-otp:${accountId}:${challengeId}`);
  try {
    // 1. Check the code and count the attempt (committed even when it is wrong).
    const checked = await inShopTenant(accountId, async (tx) => {
      const [row] = await tx.$queryRaw<ChallengeRow[]>`
        SELECT id::text AS id, phone, code_hash, cart, attempts, expires_at, verified_at, session_id::text AS session_id
        FROM shop_otp_challenges WHERE account_id=${accountId}::uuid AND id=${challengeId}::uuid FOR UPDATE`;
      if (!row) return { ok: false as const, code: 'otp_invalid' as const };
      const expected = Buffer.from(row.code_hash, 'hex');
      const given = Buffer.from(otpHash(challengeId, code), 'hex');
      const match = expected.length === given.length && timingSafeEqual(expected, given);
      if (row.verified_at) return match ? { ok: true as const, row } : { ok: false as const, code: 'otp_invalid' as const };
      if (row.attempts >= OTP.maxAttempts) return { ok: false as const, code: 'otp_locked' as const };
      if (row.expires_at.getTime() <= Date.now()) return { ok: false as const, code: 'otp_expired' as const };
      await tx.$executeRaw`UPDATE shop_otp_challenges SET attempts=attempts+1,
        verified_at=CASE WHEN ${match} THEN now() ELSE verified_at END WHERE account_id=${accountId}::uuid AND id=${challengeId}::uuid`;
      return match ? { ok: true as const, row } : { ok: false as const, code: 'otp_invalid' as const };
    });
    if (!checked.ok) throw new StoreError(checked.code);
    if (checked.row.session_id) return { url: await sessionUrl(accountId, checked.row.session_id) };

    // 2. The buyer's contact (created like an API contact, inside the plan's contact limit).
    const db = createAdminClient({ accountId, role: 'owner' });
    const auditUserId = await resolveAuditUserId(db, accountId);
    const contact = await findOrCreateContact(db, accountId, auditUserId, { phone: checked.row.phone }, { enforceLimit: true });

    // 3. The session, replay-safe by challenge.
    const url = await inShopTenant(accountId, async (tx) => {
      const [blocked] = await tx.$queryRaw<{ blocked_at: Date | null }[]>`SELECT blocked_at FROM contacts
        WHERE account_id=${accountId}::uuid AND id=${contact.id}::uuid`;
      if (blocked?.blocked_at) throw new StoreError('contact_blocked');
      await assertStoreOpenTx(tx, accountId, 'shop');
      const issued = await issueSessionTx(tx, accountId, {
        sessionId, contactId: contact.id, conversationId: null, whatsappConfigId: (await loadStorefrontRow(tx, accountId))?.whatsapp_config_id ?? null,
        purpose: 'shop', orderId: null, ttlHours: STOREFRONT_TTL.defaultHours, createdBy: null,
      });
      if (issued.created) await seedSessionCart(tx, accountId, sessionId, storedCart(checked.row.cart));
      await tx.$executeRaw`UPDATE shop_otp_challenges SET session_id=${sessionId}::uuid
        WHERE account_id=${accountId}::uuid AND id=${challengeId}::uuid`;
      return issued.url;
    });
    return { url };
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
}

async function sessionUrl(accountId: string, sessionId: string): Promise<string> {
  const [row] = await withTenant({ accountId, role: 'owner' }, (tx) => tx.$queryRaw<{ token_epoch: number; revoked: boolean }[]>`
    SELECT token_epoch, revoked_at IS NOT NULL AS revoked FROM storefront_sessions WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid`,
  getWorkerPrisma());
  if (!row || row.revoked) throw new StoreError('session_expired');
  return storefrontUrl(deriveStorefrontToken(sessionId, row.token_epoch));
}

// ---------------------------------------------------------------------------
// "Order on WhatsApp"

export const CART_CODE = /^[A-HJ-NP-Z2-9]{6}$/;
const CART_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CART_CODE_TTL_HOURS = 48;

export function newCartCode(): string {
  return Array.from({ length: 6 }, () => CART_CODE_ALPHABET[randomInt(0, CART_CODE_ALPHABET.length)]).join('');
}

/** The code in an inbound "… ORDER <CODE>" text (the code ends the message), or null. */
export function parseShopOrderMessage(text: string | null | undefined): string | null {
  if (typeof text !== 'string' || text.length > 2000) return null;
  const match = /(?:^|\s)ORDER ([A-HJ-NP-Z2-9]{6})$/.exec(text.trim().toUpperCase().replace(/[ \t]+/g, ' '));
  return match ? match[1] : null;
}

export interface CartCodeResult { code: string; whatsappUrl: string }

/** The message the buyer sends: the items for the shop's team to read, then the code on its own line. */
export function cartCodeMessage(shopName: string, lines: CartPreviewLine[], code: string): string {
  const t = getT('ShopPublic.whatsapp');
  const items = lines.slice(0, 20).map((l) => {
    const options = Object.values(l.options).join(', ');
    return `• ${l.qty} × ${l.name}${options ? ` (${options})` : ''}`;
  });
  const more = lines.length > 20 ? [t('more', { count: lines.length - 20 })] : [];
  return [t('intro', { shop: shopName }), ...items, ...more, '', `ORDER ${code}`].join('\n').slice(0, 1800);
}

/** Save the cart under a fresh code and answer the wa.me link that sends it. */
export async function createCartCode(handle: string, input: { cart: unknown; clientIp: string }): Promise<CartCodeResult | null> {
  const lines = parseCartLines(input.cart);
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  await limit('cartCodeIp', input.clientIp);
  try {
    return await inShopTenant(accountId, async (tx) => {
      const row = await openShopRow(tx, accountId);
      if (!row.whatsapp_phone || !row.whatsapp_config_id) throw new StoreError('whatsapp_order_unavailable');
      const preview = await previewCartTx(tx, accountId, lines);
      if (preview.removed.length) throw new StoreError('variant_unavailable', { variantId: preview.removed[0] });
      const shop = await loadPublicShopTx(tx, accountId);
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCartCode();
        const [saved] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO shop_cart_codes(account_id,code,cart,expires_at)
          VALUES(${accountId}::uuid,${code},${cartJson(lines)}::jsonb,now() + make_interval(hours => ${CART_CODE_TTL_HOURS}))
          ON CONFLICT (account_id, code) DO NOTHING RETURNING id::text AS id`;
        if (saved) {
          const text = cartCodeMessage(shop?.name ?? handle, preview.lines, code);
          return { code, whatsappUrl: `https://wa.me/${row.whatsapp_phone}?text=${encodeURIComponent(text)}` };
        }
      }
      throw new StoreError('conflict');
    });
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
}

export interface ShopCartCodeInput {
  accountId: string;
  contactId: string;
  conversationId: string;
  /** whatsapp_config.id the message arrived on (null for legacy single-number payloads). */
  whatsappConfigId: string | null;
  code: string;
}

export interface ShopCartCodeResult {
  /** True when the code was ours: flows, automations, AI and the away message then stay silent. */
  handled: boolean;
  outcome: 'sent' | 'expired' | 'not_shop' | 'code_unknown' | 'rate_limited' | 'store_closed';
}

async function codeLimitReached(contactId: string): Promise<boolean> {
  const { action, maximum } = PUBLIC_SHOP_LIMITS.cartCodeMiss;
  const key = hashToken(`${action}:${contactId.trim().toLowerCase()}`);
  // Reads the same auth_rate_limits row enforceAuthRateLimit writes, without counting (as booking codes do).
  const [row] = await getAuthPrisma().$queryRaw<{ attempts: number }[]>`
    SELECT attempts FROM auth_rate_limits WHERE key=${key} AND reset_at>NOW()`;
  return Boolean(row && row.attempts >= maximum);
}

async function countMiss(contactId: string): Promise<void> {
  try {
    await limit('cartCodeMiss', contactId);
  } catch (error) {
    if (!(error instanceof AuthError && error.status === 429)) throw error;
  }
}

/**
 * An inbound "ORDER <CODE>" (called from processInboundActions; only the
 * reply runs inside its stage checkpoint). Claims the code for the sender, issues their storefront
 * session with the saved cart and replies with the checkout link in the
 * open window. The claim and the session are replay-safe (seeded by the
 * code); the reply is one outbound intent. Someone else's code, a code of
 * another number and an unknown code are ordinary text.
 */
export async function handleShopCartCode(input: ShopCartCodeInput,
  /** Wraps the one send (the inbound job passes its stage checkpoint); the claim before it is replay-safe on its own. */
  runSend: (send: () => Promise<ShopCartCodeResult>) => Promise<ShopCartCodeResult> = (send) => send()): Promise<ShopCartCodeResult> {
  const { accountId } = input;
  if (!CART_CODE.test(input.code) || !isUuid(input.contactId) || !isUuid(input.conversationId)) return { handled: false, outcome: 'code_unknown' };
  const worker = getWorkerPrisma();
  const context = { accountId, role: 'owner' as const };
  const scope = await withTenant(context, async (tx) => {
    const row = await loadStorefrontRow(tx, accountId);
    if (!row) return null;
    const [hit] = await tx.$queryRaw<{ id: string; cart: unknown; expires_at: Date; contact_id: string | null; session_id: string | null }[]>`
      SELECT id::text AS id, cart, expires_at, contact_id::text AS contact_id, session_id::text AS session_id FROM shop_cart_codes
      WHERE account_id=${accountId}::uuid AND code=${input.code}`;
    return { row, hit: hit ?? null };
  }, worker);
  if (!scope) return { handled: false, outcome: 'not_shop' };
  if (await codeLimitReached(input.contactId)) return { handled: false, outcome: 'rate_limited' };
  const hit = scope.hit;
  const otherNumber = input.whatsappConfigId && scope.row.whatsapp_config_id && input.whatsappConfigId !== scope.row.whatsapp_config_id;
  if (!hit || otherNumber || (hit.contact_id && hit.contact_id !== input.contactId)) {
    await countMiss(input.contactId);
    return { handled: false, outcome: 'code_unknown' };
  }
  const shopLink = `${appOrigin()}${PUBLIC_SHOP_PATH}${scope.row.handle}`;
  const t = getT('ShopPublic.whatsapp');
  if (!hit.contact_id && hit.expires_at.getTime() <= Date.now()) {
    return runSend(() => replyOnce(() => sendStorefrontText({
      accountId, contactId: input.contactId, conversationId: input.conversationId, intentKey: `shop-cart:${hit.id}:expired:${input.contactId}`,
      text: linkMessageText(t('expired'), shopLink), sender: { kind: 'bot', service: true },
    }), 'expired'));
  }

  const sessionId = seededUuid(`storefront:cart-code:${accountId}:${hit.id}`);
  let url: string;
  try {
    url = await inShopTenant(accountId, async (tx) => {
      await assertStoreOpenTx(tx, accountId, 'shop');
      const issued = await issueSessionTx(tx, accountId, {
        sessionId, contactId: input.contactId, conversationId: input.conversationId, whatsappConfigId: input.whatsappConfigId,
        purpose: 'shop', orderId: null, ttlHours: STOREFRONT_TTL.defaultHours, createdBy: null,
      });
      if (issued.created) await seedSessionCart(tx, accountId, sessionId, storedCart(hit.cart));
      await tx.$executeRaw`UPDATE shop_cart_codes SET claimed_at=COALESCE(claimed_at, now()), contact_id=${input.contactId}::uuid,
        session_id=${sessionId}::uuid WHERE account_id=${accountId}::uuid AND id=${hit.id}::uuid
          AND (contact_id IS NULL OR contact_id=${input.contactId}::uuid)`;
      return issued.url;
    });
  } catch (error) {
    // The store closed (checkout off, plan, suspension) since the code was made: ordinary text.
    if (isShopHidden(error) || (error instanceof StoreError && ['checkout_disabled', 'store_not_configured', 'conflict'].includes(error.code)))
      return { handled: false, outcome: 'store_closed' };
    throw error;
  }
  return runSend(() => replyOnce(() => sendStorefrontText({
    accountId, contactId: input.contactId, conversationId: input.conversationId, intentKey: `shop-cart:${hit.id}:link`,
    text: linkMessageText(t('checkout'), url), sender: { kind: 'bot', service: true },
  }), 'sent'));
}

/**
 * One reply. A refusal decided before the send (StoreError) or a provider
 * rejection sent nothing and is not retried; UncertainDispatchError propagates
 * so the stage checkpoint records it for reconciliation.
 */
async function replyOnce(send: () => Promise<unknown>, outcome: 'sent' | 'expired'): Promise<ShopCartCodeResult> {
  try {
    await send();
  } catch (error) {
    if (error instanceof StoreError || (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500)) {
      console.warn('[public-shop] cart code reply not sent', error instanceof StoreError ? error.code : 'provider_rejected');
      return { handled: true, outcome };
    }
    throw error;
  }
  return { handled: true, outcome };
}

/** Just the shop (the layout's header and theme). */
export function loadShopOnly(handle: string): Promise<PublicShop | null> {
  return withPublicShop(handle, (tx, accountId) => loadPublicShopTx(tx, accountId));
}
