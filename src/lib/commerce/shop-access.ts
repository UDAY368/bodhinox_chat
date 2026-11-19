/**
 * Shop access (store plan Phase 8, batch 3): the public shop is open, behind a password, or "coming soon".
 *
 * Gate: inShopTenant (public-shop.ts) calls visitorMayEnterTx for every anonymous request, so the shop pages,
 * the cart, the one-time code, "Order on WhatsApp" and "notify me" all refuse together (the plain 404; the
 * page layout shows the lock screen instead). The password is checked with scrypt in constant time and a
 * correct one sets a signed, httpOnly cookie named for the shop, so the cookie of one shop opens no other.
 * Attempts are limited per client address and per shop. Only the hash is stored, in shop_access_secrets, a
 * table only the worker role can read or write: the app role (and so any browser API) cannot see it. The
 * staff API says whether a password is set, nothing more.
 *
 * The staff preview (the theme editor) does not go through the public shop, so it works in every mode. An
 * inbound "ORDER <CODE>" message has no browser, so it is refused only for "coming soon".
 */
import { ForbiddenError } from '@/lib/auth/errors';
import { enforceAuthRateLimit } from '@/lib/auth/service';
import { requireFeature } from '@/lib/billing/entitlements';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { isShopAccessMode, type ShopAccessMode } from './selling-rules';
import {
  ACCESS_COOKIE_TTL_MS, accessCookieName, hashShopPassword, signAccessCookie, validShopPassword, verifyAccessCookie, verifyShopPassword,
} from './selling-tokens';
import { auditStoreChange, StoreError } from './store-settings';

export interface ShopAccessRow { handle: string; mode: ShopAccessMode; message: string | null }

export async function loadShopAccessTx(tx: TenantTransaction, accountId: string): Promise<ShopAccessRow | null> {
  const [row] = await tx.$queryRaw<{ handle: string; access_mode: string; coming_soon_message: string | null }[]>`
    SELECT handle, access_mode, coming_soon_message FROM shop_storefronts WHERE account_id=${accountId}::uuid`;
  if (!row) return null;
  return { handle: row.handle, mode: isShopAccessMode(row.access_mode) ? row.access_mode : 'open', message: row.coming_soon_message };
}

/** The password hash. Worker transactions only: the app role has no access to shop_access_secrets. */
async function loadAccessHashTx(tx: TenantTransaction, accountId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ password_hash: string }[]>`SELECT password_hash FROM shop_access_secrets WHERE account_id=${accountId}::uuid`;
  return row?.password_hash ?? null;
}

/** The visitor's access cookie for this shop, or null (outside a request there is none). */
async function accessCookie(handle: string): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    return (await cookies()).get(accessCookieName(handle))?.value ?? null;
  } catch {
    return null;
  }
}

/**
 * Whether an anonymous caller may use the shop now (a worker transaction: the hash is read here). `visitor`: a browser (password mode needs its cookie).
 * `inbound`: a WhatsApp message claiming a saved cart (only "coming soon" refuses it).
 */
export async function visitorMayEnterTx(tx: TenantTransaction, accountId: string, who: 'visitor' | 'inbound' = 'visitor', now = new Date()): Promise<boolean> {
  const row = await loadShopAccessTx(tx, accountId);
  if (!row || row.mode === 'open') return true;
  if (row.mode === 'coming_soon') return false;
  if (who === 'inbound') return true;
  return verifyAccessCookie(await accessCookie(row.handle), row.handle, await loadAccessHashTx(tx, accountId), now);
}

// ---------------------------------------------------------------------------
// Visitor: enter the password

export const SHOP_UNLOCK_LIMITS = {
  /** identity: client IP; every attempt counts */
  ip: { action: 'shop_unlock_ip', maximum: 10, windowSeconds: 600 },
  /** identity: the shop; every attempt counts (a spread-out guess still meets this) */
  shop: { action: 'shop_unlock_shop', maximum: 100, windowSeconds: 600 },
} as const;

export interface UnlockReply { body: { ok: true }; cookie: { name: string; value: string; maxAgeSeconds: number } }

/**
 * Check a visitor's password. null = no such shop in password mode (the plain 404); throws StoreError
 * wrong_password for a wrong one and AuthError 429 past the limits.
 */
export async function unlockShop(accountId: string, handle: string, password: unknown, clientIp: string, now = new Date()): Promise<UnlockReply | null> {
  await enforceAuthRateLimit(SHOP_UNLOCK_LIMITS.ip.action, clientIp, SHOP_UNLOCK_LIMITS.ip.maximum, SHOP_UNLOCK_LIMITS.ip.windowSeconds);
  await enforceAuthRateLimit(SHOP_UNLOCK_LIMITS.shop.action, accountId, SHOP_UNLOCK_LIMITS.shop.maximum, SHOP_UNLOCK_LIMITS.shop.windowSeconds);
  const row = await readAccess(accountId);
  if (!row || row.mode !== 'password' || !row.hash || row.handle !== handle) return null;
  const hash = row.hash;
  if (typeof password !== 'string' || !verifyShopPassword(password, hash)) throw new StoreError('wrong_password');
  const expiresAt = new Date(now.getTime() + ACCESS_COOKIE_TTL_MS);
  return {
    body: { ok: true },
    cookie: { name: accessCookieName(handle), value: signAccessCookie(handle, hash, expiresAt), maxAgeSeconds: Math.floor(ACCESS_COOKIE_TTL_MS / 1000) },
  };
}

async function readAccess(accountId: string): Promise<(ShopAccessRow & { hash: string | null }) | null> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => {
    const row = await loadShopAccessTx(tx, accountId);
    return row && { ...row, hash: await loadAccessHashTx(tx, accountId) };
  }, getWorkerPrisma());
}

/** Whether a password is set, read through the worker connection. */
async function passwordIsSet(accountId: string): Promise<boolean> {
  return withTenant({ accountId, role: 'owner' }, async (tx) => !!(await loadAccessHashTx(tx, accountId)), getWorkerPrisma());
}

async function storePassword(accountId: string, hash: string): Promise<void> {
  await withTenant({ accountId, role: 'owner' }, (tx) => tx.$executeRaw`INSERT INTO shop_access_secrets(account_id,password_hash) VALUES(${accountId}::uuid,${hash})
    ON CONFLICT (account_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, updated_at=now()`, getWorkerPrisma());
}

// ---------------------------------------------------------------------------
// Staff: read and set the mode

export interface ShopAccessView { mode: ShopAccessMode; passwordSet: boolean; comingSoonMessage: string | null; shopSaved: boolean }

export async function getShopAccess(ctx: TenantContext): Promise<ShopAccessView> {
  return withTenant(ctx, async (tx) => {
    await requireFeature(tx, ctx.accountId, 'storefront');
    const row = await loadShopAccessTx(tx, ctx.accountId);
    return { mode: row?.mode ?? 'open', passwordSet: row ? await passwordIsSet(ctx.accountId) : false, comingSoonMessage: row?.message ?? null, shopSaved: !!row };
  });
}

export interface ShopAccessInput { mode: ShopAccessMode; password: string | null; comingSoonMessage: string | null }

/** Validate a staff request: a mode, an optional new password (6 to 72 characters) and an optional message (500). */
export function parseShopAccessInput(body: unknown): ShopAccessInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (!isShopAccessMode(b.mode)) throw new StoreError('invalid', { field: 'mode' });
  let password: string | null = null;
  if (b.password !== undefined && b.password !== null && b.password !== '') {
    if (!validShopPassword(b.password)) throw new StoreError('invalid', { field: 'password' });
    password = b.password;
  }
  let message: string | null = null;
  if (b.comingSoonMessage !== undefined && b.comingSoonMessage !== null && b.comingSoonMessage !== '') {
    if (typeof b.comingSoonMessage !== 'string') throw new StoreError('invalid', { field: 'comingSoonMessage' });
    message = b.comingSoonMessage.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, ' ').trim().slice(0, 501);
    if (message.length > 500) throw new StoreError('invalid', { field: 'comingSoonMessage' });
    message = message || null;
  }
  return { mode: b.mode, password, comingSoonMessage: message };
}

/** Save the mode (admins; the app role's RLS and column grants enforce it too). Password mode needs a password to exist. */
export async function saveShopAccess(ctx: TenantContext & { userId: string }, input: ShopAccessInput): Promise<ShopAccessView> {
  return withTenant(ctx, async (tx) => {
    await requireFeature(tx, ctx.accountId, 'storefront');
    const [row] = await tx.$queryRaw<{ handle: string }[]>`
      SELECT handle FROM shop_storefronts WHERE account_id=${ctx.accountId}::uuid FOR UPDATE`;
    if (!row) {
      // Row security hides the row from the lock for anyone below an admin: a shop that exists is a refusal, not "not set up".
      if (await loadShopAccessTx(tx, ctx.accountId)) throw new ForbiddenError('Insufficient workspace role');
      throw new StoreError('shop_not_set_up');
    }
    // The caller is an admin (the locked row is visible to no one below). The hash is written through the worker
    // connection, before the mode, so a shop is never in password mode without one.
    const passwordSet = !!input.password || await passwordIsSet(ctx.accountId);
    if (input.mode === 'password' && !passwordSet) throw new StoreError('password_required', { field: 'password' });
    if (input.password) await storePassword(ctx.accountId, hashShopPassword(input.password));
    const changed = await tx.$executeRaw`UPDATE shop_storefronts SET access_mode=${input.mode},
        coming_soon_message=${input.comingSoonMessage} WHERE account_id=${ctx.accountId}::uuid`;
    // Row security hides the row from the update for anyone below an admin: no row changed means refused.
    if (changed !== 1) throw new ForbiddenError('Insufficient workspace role');
    await auditStoreChange(tx, ctx, 'commerce.shop_access_updated', ctx.accountId, { mode: input.mode, password_changed: !!input.password });
    return { mode: input.mode, passwordSet, comingSoonMessage: input.comingSoonMessage, shopSaved: true };
  });
}
