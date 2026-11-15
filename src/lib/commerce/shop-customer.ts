/**
 * Customer accounts on the public shop (store plan Phase 5): /s/<handle>/account.
 *
 * A buyer signs in with their phone and a WhatsApp code. The code uses the
 * same challenge table, template, limits and send path as the cart's code
 * (public-shop.ts), stored with purpose 'sign_in', so it can never open
 * checkout and a checkout code can never sign anyone in. A sign-in code works
 * once.
 *
 * A session is one row in shop_customer_sessions (30 days). The raw token is
 * only in the buyer's cookie; the row holds sha256 of it. A session is looked
 * up by that hash inside the tenant of the shop the page's handle names, so
 * it never works on another shop. A blocked contact is refused at sign-in and
 * on every read. Every read and write below is scoped by account_id and the
 * session's contact_id, on the worker client inside withTenant.
 *
 * Logs carry nothing from here: no phone, token, code or address.
 */
import { randomUUID } from 'node:crypto';
import { hashToken, randomToken } from '@/lib/auth/csrf';
import type { TenantTransaction } from '@/lib/db/tenant';
import { minorFromDb } from './money';
import type { CartLine } from './pricing';
import {
  assertSellable, buyerContactId, checkOtp, enforceShopLimit, inShopTenant, isShopHidden, normaliseBuyerPhone, openShopRow, parseCartLines,
  parseOtpVerify, resolvePublicShop, seedSessionCart, sendOtp,
} from './public-shop';
import {
  ACCOUNT_ORDERS_PAGE_SIZE, CUSTOMER_SESSION_DAYS, CUSTOMER_TOKEN, MAX_SAVED_ADDRESSES, maskPhone,
} from './shop-customer-cookie';
import { isUuid, StoreError } from './store-settings';
import {
  issueSessionTx, loadOrderView, loadVariants, orderReference, parseAddress, STOREFRONT_TTL, type StorefrontAddress, type StorefrontOrderView,
} from './storefront';

export interface Customer {
  accountId: string;
  sessionId: string;
  contactId: string;
  /** For the page: country code and last four digits only. */
  phoneMasked: string;
  tokenHash: string;
}

// ---------------------------------------------------------------------------
// Sign in and out

/** Send a sign-in code to the buyer's WhatsApp. Same refusals as the cart's code, minus the cart ones. */
export function startSignIn(handle: string, input: { phone: unknown; clientIp: string }): Promise<{ challengeId: string; expiresAt: string } | null> {
  const phone = normaliseBuyerPhone(input.phone);
  if (!phone) throw new StoreError('invalid', { field: 'phone' });
  return sendOtp(handle, { phone, lines: [], purpose: 'sign_in', clientIp: input.clientIp });
}

/**
 * Check a sign-in code and open a session. Answers the raw token for the
 * cookie (never stored). Refusals: otp_invalid (also a checkout code, and a
 * code used before), otp_expired, otp_locked, contact_blocked, too_many.
 */
export async function verifySignIn(handle: string, input: { challengeId: unknown; code: unknown; clientIp: string }): Promise<{ token: string } | null> {
  const { challengeId, code } = parseOtpVerify(input);
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  await enforceShopLimit('otpVerifyIp', input.clientIp);
  try {
    const checked = await checkOtp(accountId, challengeId, code, 'sign_in');
    if (checked.replay) throw new StoreError('otp_invalid');
    const contactId = await buyerContactId(accountId, checked.row.phone);
    const token = randomToken();
    await inShopTenant(accountId, async (tx) => {
      const [contact] = await tx.$queryRaw<{ blocked: boolean }[]>`SELECT blocked_at IS NOT NULL AS blocked FROM contacts
        WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
      if (!contact || contact.blocked) throw new StoreError('contact_blocked');
      await tx.$executeRaw`INSERT INTO shop_customer_sessions(account_id,contact_id,token_hash,expires_at)
        VALUES(${accountId}::uuid,${contactId}::uuid,${hashToken(token)},now() + make_interval(days => ${CUSTOMER_SESSION_DAYS}))`;
    });
    return { token };
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
}

/** The live session a cookie token names in this workspace, or null: unknown, expired, revoked, or the contact is blocked. */
export async function findCustomerTx(tx: TenantTransaction, accountId: string, token: unknown): Promise<Customer | null> {
  if (typeof token !== 'string' || !CUSTOMER_TOKEN.test(token)) return null;
  const tokenHash = hashToken(token);
  const [row] = await tx.$queryRaw<{ id: string; contact_id: string; phone: string; stale: boolean }[]>`
    SELECT s.id::text AS id, s.contact_id::text AS contact_id, c.phone, s.last_seen_at < now() - interval '1 hour' AS stale
    FROM shop_customer_sessions s JOIN contacts c ON c.account_id=s.account_id AND c.id=s.contact_id
    WHERE s.account_id=${accountId}::uuid AND s.token_hash=${tokenHash} AND s.revoked_at IS NULL AND s.expires_at > now()
      AND c.blocked_at IS NULL`;
  if (!row) return null;
  if (row.stale) await tx.$executeRaw`UPDATE shop_customer_sessions SET last_seen_at=now()
    WHERE account_id=${accountId}::uuid AND id=${row.id}::uuid`;
  return { accountId, sessionId: row.id, contactId: row.contact_id, phoneMasked: maskPhone(row.phone), tokenHash };
}

/**
 * Run `work` for the signed-in buyer of this shop. null: the shop is not
 * public (plain 404). Throws signed_out when the cookie names no live session
 * here. `mutate` counts the call against the session's durable limit.
 */
export async function withCustomer<T>(handle: string, token: unknown, work: (tx: TenantTransaction, customer: Customer) => Promise<T>,
  options: { mutate?: boolean } = {}): Promise<T | null> {
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  try {
    return await inShopTenant(accountId, async (tx) => {
      const customer = await findCustomerTx(tx, accountId, token);
      if (!customer) throw new StoreError('signed_out');
      if (options.mutate) await enforceShopLimit('customerMutate', customer.tokenHash);
      return work(tx, customer);
    });
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
}

/** As withCustomer, for pages: `{ customer: null }` instead of the signed_out refusal. */
export async function readAsCustomer<T>(handle: string, token: unknown, work: (tx: TenantTransaction, customer: Customer) => Promise<T>):
  Promise<{ customer: Customer; value: T } | { customer: null } | null> {
  try {
    return await withCustomer(handle, token, async (tx, customer) => ({ customer, value: await work(tx, customer) }));
  } catch (error) {
    if (error instanceof StoreError && error.code === 'signed_out') return { customer: null };
    throw error;
  }
}

/** Sign out: the session row is revoked. An unknown token changes nothing. */
export async function signOut(handle: string, token: unknown): Promise<{ ok: true } | null> {
  if (typeof token !== 'string' || !CUSTOMER_TOKEN.test(token)) return { ok: true };
  const accountId = await resolvePublicShop(handle);
  if (!accountId) return null;
  try {
    await inShopTenant(accountId, (tx) => tx.$executeRaw`UPDATE shop_customer_sessions SET revoked_at=now()
      WHERE account_id=${accountId}::uuid AND token_hash=${hashToken(token)} AND revoked_at IS NULL`);
  } catch (error) {
    if (isShopHidden(error)) return null;
    throw error;
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Orders

export interface AccountOrder { id: string; reference: string; status: string; currency: string; totalMinor: number | null; placedAt: string; items: number }
export interface AccountOrders { orders: AccountOrder[]; page: number; hasNext: boolean }

/** The buyer's own orders in this shop, newest first. */
export async function listOrdersTx(tx: TenantTransaction, customer: Customer, page: number): Promise<AccountOrders> {
  const size = ACCOUNT_ORDERS_PAGE_SIZE;
  const rows = await tx.$queryRaw<{ id: string; status: string; currency: string; total_minor: bigint | null; created_at: Date; items: number }[]>`
    SELECT o.id::text AS id, o.status, o.currency, o.total_minor, o.created_at,
      (SELECT COALESCE(sum(i.quantity), 0)::int FROM order_items i WHERE i.account_id=o.account_id AND i.order_id=o.id) AS items
    FROM orders o WHERE o.account_id=${customer.accountId}::uuid AND o.contact_id=${customer.contactId}::uuid
    ORDER BY o.created_at DESC, o.id DESC LIMIT ${size + 1} OFFSET ${(page - 1) * size}`;
  return {
    page, hasNext: rows.length > size,
    orders: rows.slice(0, size).map((o) => ({
      id: o.id, reference: orderReference(o.id), status: o.status, currency: o.currency, totalMinor: minorFromDb(o.total_minor),
      placedAt: o.created_at.toISOString(), items: o.items,
    })),
  };
}

/** True when the order is this buyer's, in this shop. */
async function ownsOrder(tx: TenantTransaction, customer: Customer, orderId: unknown): Promise<Date | null> {
  if (!isUuid(orderId)) return null;
  const [row] = await tx.$queryRaw<{ created_at: Date }[]>`SELECT created_at FROM orders
    WHERE account_id=${customer.accountId}::uuid AND id=${orderId}::uuid AND contact_id=${customer.contactId}::uuid`;
  return row?.created_at ?? null;
}

export interface AccountOrderDetail { id: string; placedAt: string; order: StorefrontOrderView }

/** One of the buyer's orders: items, totals, status and the tracking path. null for anyone else's order. */
export async function loadOrderDetailTx(tx: TenantTransaction, customer: Customer, orderId: unknown): Promise<AccountOrderDetail | null> {
  const placed = await ownsOrder(tx, customer, orderId);
  if (!placed) return null;
  const order = await loadOrderView(tx, customer.accountId, orderId as string);
  return order ? { id: orderId as string, placedAt: placed.toISOString(), order } : null;
}

/**
 * The lines of one of the buyer's orders that can be bought again now, for
 * the browser cart (prices come from the server when the cart opens).
 * `skipped` counts the order's lines that are no longer on sale or are sold out.
 */
export async function reorderLinesTx(tx: TenantTransaction, customer: Customer, orderId: unknown): Promise<{ lines: CartLine[]; skipped: number }> {
  if (!(await ownsOrder(tx, customer, orderId))) throw new StoreError('not_found');
  const items = await tx.$queryRaw<{ variant_id: string | null; quantity: number }[]>`SELECT variant_id::text AS variant_id, quantity
    FROM order_items WHERE account_id=${customer.accountId}::uuid AND order_id=${orderId}::uuid ORDER BY id LIMIT 100`;
  const variants = await loadVariants(tx, customer.accountId, items.flatMap((i) => (i.variant_id ? [i.variant_id] : [])));
  const wanted = new Map<string, number>();
  let skipped = 0;
  for (const item of items) {
    const v = item.variant_id ? variants.get(item.variant_id) : undefined;
    if (!v || !v.sellable || v.priceMinor === null || (v.available !== null && v.available <= 0)) { skipped++; continue; }
    wanted.set(v.id, (wanted.get(v.id) ?? 0) + item.quantity);
  }
  const lines = [...wanted].slice(0, 50).map(([variantId, qty]) => {
    const available = variants.get(variantId)?.available ?? null;
    return { variantId, qty: Math.max(1, Math.min(99, qty, available ?? qty)) };
  });
  return { lines, skipped };
}

// ---------------------------------------------------------------------------
// Saved addresses

export interface SavedAddress extends StorefrontAddress { id: string }

interface AddressRow extends StorefrontAddress { id: string }

export async function listAddressesTx(tx: TenantTransaction, customer: Customer): Promise<SavedAddress[]> {
  return tx.$queryRaw<AddressRow[]>`
    SELECT id::text AS id, name, phone, line1, line2, city, state, state_code, postal_code, country, instructions
    FROM shop_customer_addresses WHERE account_id=${customer.accountId}::uuid AND contact_id=${customer.contactId}::uuid
    ORDER BY created_at, id LIMIT ${MAX_SAVED_ADDRESSES}`;
}

/**
 * Add an address (at most five per buyer per shop) or change one of the
 * buyer's own. The fields are the checkout address's, validated the same way.
 */
export async function saveAddressTx(tx: TenantTransaction, customer: Customer, input: { id?: unknown; address: unknown }): Promise<SavedAddress[]> {
  const a = parseAddress(input.address);
  if (input.id !== undefined && input.id !== null) {
    if (!isUuid(input.id)) throw new StoreError('invalid', { field: 'id' });
    const changed = await tx.$executeRaw`UPDATE shop_customer_addresses SET name=${a.name}, phone=${a.phone}, line1=${a.line1}, line2=${a.line2},
      city=${a.city}, state=${a.state}, state_code=${a.state_code}, postal_code=${a.postal_code}, country=${a.country}, instructions=${a.instructions}
      WHERE account_id=${customer.accountId}::uuid AND id=${input.id}::uuid AND contact_id=${customer.contactId}::uuid`;
    if (changed !== 1) throw new StoreError('not_found');
    return listAddressesTx(tx, customer);
  }
  // One add at a time per buyer, so two tabs cannot both pass the count.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`shop-customer-address:${customer.accountId}:${customer.contactId}`}, 0))`;
  const [{ n }] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_customer_addresses
    WHERE account_id=${customer.accountId}::uuid AND contact_id=${customer.contactId}::uuid`;
  if (n >= MAX_SAVED_ADDRESSES) throw new StoreError('address_limit');
  await tx.$executeRaw`INSERT INTO shop_customer_addresses(account_id,contact_id,name,phone,line1,line2,city,state,state_code,postal_code,country,instructions)
    VALUES(${customer.accountId}::uuid,${customer.contactId}::uuid,${a.name},${a.phone},${a.line1},${a.line2},${a.city},${a.state},${a.state_code},
      ${a.postal_code},${a.country},${a.instructions})`;
  return listAddressesTx(tx, customer);
}

export async function deleteAddressTx(tx: TenantTransaction, customer: Customer, id: unknown): Promise<SavedAddress[]> {
  if (!isUuid(id)) throw new StoreError('invalid', { field: 'id' });
  await tx.$executeRaw`DELETE FROM shop_customer_addresses
    WHERE account_id=${customer.accountId}::uuid AND id=${id}::uuid AND contact_id=${customer.contactId}::uuid`;
  return listAddressesTx(tx, customer);
}

// ---------------------------------------------------------------------------
// Check out as the signed-in buyer

/**
 * Open checkout for the signed-in buyer without a new code: the ordinary
 * storefront session (issueSessionTx) for the session's own contact, holding
 * this cart and, when picked, one of the buyer's saved addresses. Pricing,
 * stock, coupons and payment stay with the checkout page.
 */
export function checkoutAsCustomer(handle: string, token: unknown, input: { cart: unknown; addressId?: unknown }): Promise<{ url: string } | null> {
  const lines = parseCartLines(input.cart);
  const addressId = input.addressId ?? null;
  if (addressId !== null && !isUuid(addressId)) throw new StoreError('invalid', { field: 'addressId' });
  return withCustomer(handle, token, async (tx, customer) => {
    const { accountId } = customer;
    const row = await openShopRow(tx, accountId);
    await assertSellable(tx, accountId, lines);
    const address = addressId ? (await listAddressesTx(tx, customer)).find((a) => a.id === addressId) : null;
    if (addressId && !address) throw new StoreError('invalid', { field: 'addressId' });
    const sessionId = randomUUID();
    const issued = await issueSessionTx(tx, accountId, {
      sessionId, contactId: customer.contactId, conversationId: null, whatsappConfigId: row.whatsapp_config_id,
      purpose: 'shop', orderId: null, ttlHours: STOREFRONT_TTL.defaultHours, createdBy: null,
    });
    await seedSessionCart(tx, accountId, sessionId, lines);
    if (address) {
      const { id: _id, ...fields } = address;
      void _id;
      await tx.$executeRaw`UPDATE storefront_sessions SET address=${JSON.stringify(parseAddress(fields))}::jsonb
        WHERE account_id=${accountId}::uuid AND id=${sessionId}::uuid AND order_id IS NULL`;
    }
    return { url: issued.url };
  }, { mutate: true });
}
