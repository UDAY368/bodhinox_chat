/**
 * Store plan Phase 8, batch 6: the referral and affiliate program (rules and decisions in referral-rules.ts).
 *
 *  - A shop link carries ?ref=<code>. The browser keeps it and sends it with the cart (Order on WhatsApp, or the phone code); the
 *    cart code or challenge stores the code's id (lookupReferralCodeTx). Placing the order (checkout.ts) records the referral
 *    when the code is active, the buyer is not the referrer, and the buyer has no referral yet (attributeReferralTx).
 *  - When the order is paid (settle.ts) the reward job is queued for the end of the hold (onOrderPaidTx), and a paying customer
 *    gets a code of their own. The job (handleReferralRewardJob) settles once: store credit for a customer's code (ledger key
 *    referral:<order>), a commission figure for an affiliate's. Nothing is paid out to affiliates: the report is the output.
 *  - Staff (admins) make affiliates and switch codes off; agents read the codes and the report.
 *
 * Logs carry ids and codes only: no names, emails or amounts.
 */
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { appOrigin } from '@/lib/auth/csrf';
import { ledgerLockTx } from './customer-ledger';
import { referralJobKey } from './email-rules';
import { minorFromDb } from './money';
import {
  AFFILIATE_LIMIT, attributionRefusal, holdDays, MAX_COMMISSION_BPS, newReferralCode, parseReferralParam, referralCreditKey, rewardDueAt, settleReferral,
} from './referral-rules';
import { loadMarketingSettingsTx } from './marketing-settings';
import { auditStoreChange, isUuid, StoreError } from './store-settings';

export const REFERRAL_REWARD_JOB = 'shop.referral_reward';

const worker = <T,>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

/** The id of an active code in this workspace for the ?ref value a visitor's link carried; null when unknown or off (never an error). */
export async function lookupReferralCodeTx(tx: TenantTransaction, accountId: string, ref: unknown): Promise<string | null> {
  const code = parseReferralParam(ref);
  if (!code) return null;
  const [row] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_referral_codes
    WHERE account_id=${accountId}::uuid AND code=${code} AND active`;
  return row?.id ?? null;
}

/**
 * Called when an order is placed (worker role). Records the referral of the cart this session came from, if any. Nothing happens
 * when the program is off, the order came from no coded cart, the code is off, or the buyer is the referrer. A replay changes
 * nothing (one row per order and per buyer).
 */
export async function attributeReferralTx(tx: TenantTransaction, accountId: string, orderId: string, sessionId: string, buyerContactId: string): Promise<void> {
  const settings = await loadMarketingSettingsTx(tx, accountId);
  if (!settings.referral_enabled) return;
  const [hit] = await tx.$queryRaw<{ id: string; active: boolean; kind: 'contact' | 'affiliate'; contact_id: string | null; email: string | null }[]>`
    SELECT rc.id::text AS id, rc.active, rc.kind, rc.contact_id::text AS contact_id, ref.email
    FROM shop_referral_codes rc LEFT JOIN contacts ref ON ref.account_id=rc.account_id AND ref.id=rc.contact_id
    WHERE rc.account_id=${accountId}::uuid AND rc.id IN (
      SELECT referral_code_id FROM shop_cart_codes WHERE account_id=${accountId}::uuid AND session_id=${sessionId}::uuid AND referral_code_id IS NOT NULL
      UNION ALL SELECT referral_code_id FROM shop_otp_challenges WHERE account_id=${accountId}::uuid AND session_id=${sessionId}::uuid AND referral_code_id IS NOT NULL)
    LIMIT 1`;
  if (!hit) return;
  const [buyer] = await tx.$queryRaw<{ email: string | null }[]>`SELECT email FROM contacts WHERE account_id=${accountId}::uuid AND id=${buyerContactId}::uuid`;
  if (attributionRefusal({ code: { active: hit.active, kind: hit.kind, contactId: hit.contact_id, email: hit.email }, buyer: { contactId: buyerContactId, email: buyer?.email ?? null } })) return;
  await tx.$executeRaw`INSERT INTO shop_referrals(account_id,order_id,code_id,kind,referrer_contact_id,buyer_contact_id)
    VALUES(${accountId}::uuid,${orderId}::uuid,${hit.id}::uuid,${hit.kind},${hit.contact_id}::uuid,${buyerContactId}::uuid)
    ON CONFLICT DO NOTHING`;
}

/** A contact's own code, made once (a collision picks another code). */
async function ensureContactCodeTx(tx: TenantTransaction, accountId: string, contactId: string): Promise<void> {
  const [existing] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_referral_codes
    WHERE account_id=${accountId}::uuid AND kind='contact' AND contact_id=${contactId}::uuid`;
  if (existing) return;
  for (let attempt = 0; attempt < 5; attempt++) {
    const made = await tx.$executeRaw`INSERT INTO shop_referral_codes(account_id,code,kind,contact_id)
      VALUES(${accountId}::uuid,${newReferralCode()},'contact',${contactId}::uuid) ON CONFLICT DO NOTHING`;
    if (made) return;
    const [again] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_referral_codes
      WHERE account_id=${accountId}::uuid AND kind='contact' AND contact_id=${contactId}::uuid`;
    if (again) return;
  }
}

/**
 * Called in the transaction that confirms an order paid (settle.ts, worker role, order row locked). Queues the one reward job
 * (key referral:<order>) for the end of the hold, and gives the paying customer a code. A replay changes nothing.
 */
export async function onOrderPaidTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  const settings = await loadMarketingSettingsTx(tx, accountId);
  if (!settings.referral_enabled) return;
  const [order] = await tx.$queryRaw<{ contact_id: string | null; paid_at: Date | null }[]>`
    SELECT contact_id::text AS contact_id, paid_at FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
  if (!order?.paid_at) return;
  if (order.contact_id) await ensureContactCodeTx(tx, accountId, order.contact_id);
  const [referral] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_referrals
    WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid AND status='pending'`;
  if (!referral) return;
  const [buyer] = await tx.$queryRaw<{ return_window: number | null }[]>`
    SELECT CASE WHEN b.buyer_returns_enabled THEN b.window_days END AS return_window FROM (SELECT 1) x
    LEFT JOIN shop_buyer_settings b ON b.account_id=${accountId}::uuid`;
  const days = holdDays(settings.referral_hold_days, buyer?.return_window ?? null);
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key,run_at)
    VALUES(${REFERRAL_REWARD_JOB},${accountId}::uuid,${JSON.stringify({ orderId })}::jsonb,${referralJobKey(orderId)},${rewardDueAt(order.paid_at, days)})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

/**
 * The reward job: settle one referral. Settles once (the row leaves 'pending' in the same transaction as the ledger entry, and the
 * ledger key is unique too), so a replayed or duplicate job changes nothing.
 */
export async function handleReferralRewardJob(accountId: string, payload: { orderId: string }, now = new Date()): Promise<'rewarded' | 'skipped' | 'none'> {
  if (!isUuid(payload.orderId)) throw new Error('Invalid referral job');
  return worker(accountId, async (tx) => {
    const [referral] = await tx.$queryRaw<{ id: string; kind: 'contact' | 'affiliate'; referrer_contact_id: string | null; commission_bps: number | null }[]>`
      SELECT r.id::text AS id, r.kind, r.referrer_contact_id::text AS referrer_contact_id, c.commission_bps FROM shop_referrals r
      LEFT JOIN shop_referral_codes c ON c.account_id=r.account_id AND c.id=r.code_id
      WHERE r.account_id=${accountId}::uuid AND r.order_id=${payload.orderId}::uuid AND r.status='pending' FOR UPDATE OF r`;
    if (!referral) return 'none';
    const [order] = await tx.$queryRaw<{ status: string; paid_at: Date | null; currency: string; total_minor: bigint | null; subtotal_minor: bigint; amount_refunded_minor: bigint }[]>`
      SELECT status, paid_at, currency, total_minor, subtotal_minor, amount_refunded_minor FROM orders
      WHERE account_id=${accountId}::uuid AND id=${payload.orderId}::uuid FOR UPDATE`;
    const settings = await loadMarketingSettingsTx(tx, accountId);
    const settle = (reason: string) => tx.$executeRaw`UPDATE shop_referrals SET status='skipped', reason=${reason}, settled_at=${now}
      WHERE account_id=${accountId}::uuid AND id=${referral.id}::uuid`;
    if (!order) { await settle('order_missing'); return 'skipped'; }
    if (!settings.referral_enabled) { await settle('program_off'); return 'skipped'; }
    const result = settleReferral({
      kind: referral.kind, orderStatus: order.status, paid: order.paid_at !== null,
      totalMinor: minorFromDb(order.total_minor ?? order.subtotal_minor) ?? 0, refundedMinor: minorFromDb(order.amount_refunded_minor) ?? 0,
      rewardMinor: settings.referral_reward_minor, commissionBps: referral.commission_bps, hasReferrer: referral.referrer_contact_id !== null,
    });
    if (result.status === 'skipped') { await settle(result.reason); return 'skipped'; }
    if (referral.kind === 'contact' && referral.referrer_contact_id) {
      await ledgerLockTx(tx, accountId, referral.referrer_contact_id);
      await tx.$executeRaw`INSERT INTO shop_credit_ledger(account_id,contact_id,amount_minor,currency,kind,order_id,reason,dedupe_key)
        VALUES(${accountId}::uuid,${referral.referrer_contact_id}::uuid,${BigInt(result.rewardMinor)},${order.currency},'referral',${payload.orderId}::uuid,
          'Referral reward',${referralCreditKey(payload.orderId)})
        ON CONFLICT (account_id, dedupe_key) DO NOTHING`;
    }
    await tx.$executeRaw`UPDATE shop_referrals SET status='rewarded', currency=${order.currency}, net_minor=${BigInt(result.netMinor)},
        reward_minor=${BigInt(result.rewardMinor)}, commission_minor=${BigInt(result.commissionMinor)}, settled_at=${now}
      WHERE account_id=${accountId}::uuid AND id=${referral.id}::uuid`;
    return 'rewarded';
  });
}

// ---------------------------------------------------------------------------
// Staff: codes, affiliates and the report (agents read, admins write)

export interface ReferralCodeView {
  id: string;
  code: string;
  kind: 'contact' | 'affiliate';
  name: string | null;
  contact_name: string | null;
  commission_bps: number | null;
  active: boolean;
  link: string | null;
  orders: number;
  rewarded: number;
  pending: number;
  net_minor: number;
  credit_minor: number;
  commission_minor: number;
}

export interface ReferralOverview { enabled: boolean; currency: string | null; codes: ReferralCodeView[] }

/** Codes with what each brought in (affiliates first, then customers by most orders). */
export async function listReferralCodes(ctx: TenantContext): Promise<ReferralOverview> {
  return withTenant(ctx, async (tx) => {
    const settings = await loadMarketingSettingsTx(tx, ctx.accountId);
    const [shop] = await tx.$queryRaw<{ handle: string; published: boolean }[]>`SELECT handle, published FROM shop_storefronts WHERE account_id=${ctx.accountId}::uuid`;
    const [store] = await tx.$queryRaw<{ currency: string | null }[]>`SELECT currency FROM commerce_settings WHERE account_id=${ctx.accountId}::uuid`;
    const rows = await tx.$queryRaw<{ id: string; code: string; kind: 'contact' | 'affiliate'; name: string | null; contact_name: string | null; commission_bps: number | null;
      active: boolean; orders: number; rewarded: number; pending: number; net: bigint; credit: bigint; commission: bigint }[]>`
      SELECT c.id::text AS id, c.code, c.kind, c.name, ct.name AS contact_name, c.commission_bps, c.active,
        count(r.id)::int AS orders, count(r.id) FILTER (WHERE r.status='rewarded')::int AS rewarded, count(r.id) FILTER (WHERE r.status='pending')::int AS pending,
        COALESCE(sum(r.net_minor) FILTER (WHERE r.status='rewarded'), 0)::bigint AS net,
        COALESCE(sum(r.reward_minor) FILTER (WHERE r.status='rewarded'), 0)::bigint AS credit,
        COALESCE(sum(r.commission_minor) FILTER (WHERE r.status='rewarded'), 0)::bigint AS commission
      FROM shop_referral_codes c LEFT JOIN contacts ct ON ct.account_id=c.account_id AND ct.id=c.contact_id
      LEFT JOIN shop_referrals r ON r.account_id=c.account_id AND r.code_id=c.id
      WHERE c.account_id=${ctx.accountId}::uuid GROUP BY c.id, ct.name
      ORDER BY (c.kind='affiliate') DESC, count(r.id) DESC, c.created_at DESC LIMIT 500`;
    const origin = shop?.published ? appOrigin() : null;
    return {
      enabled: settings.referral_enabled, currency: store?.currency ?? null,
      codes: rows.map((r) => ({
        id: r.id, code: r.code, kind: r.kind, name: r.name, contact_name: r.contact_name, commission_bps: r.commission_bps, active: r.active,
        link: origin && shop ? `${origin}/s/${shop.handle}?ref=${r.code}` : null, orders: r.orders, rewarded: r.rewarded, pending: r.pending,
        net_minor: minorFromDb(r.net) ?? 0, credit_minor: minorFromDb(r.credit) ?? 0, commission_minor: minorFromDb(r.commission) ?? 0,
      })),
    };
  });
}

export interface AffiliateInput { name: string; commissionBps: number }

export function parseAffiliate(body: unknown): AffiliateInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!name || name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) throw new StoreError('invalid', { field: 'name' });
  const bps = b.commission_bps;
  if (typeof bps !== 'number' || !Number.isInteger(bps) || bps < 0 || bps > MAX_COMMISSION_BPS) throw new StoreError('invalid', { field: 'commission_bps' });
  return { name, commissionBps: bps };
}

export async function createAffiliate(ctx: TenantContext & { userId: string }, input: AffiliateInput): Promise<{ id: string; code: string }> {
  return withTenant(ctx, async (tx) => {
    const [count] = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM shop_referral_codes WHERE account_id=${ctx.accountId}::uuid AND kind='affiliate'`;
    if (count.n >= AFFILIATE_LIMIT) throw new StoreError('affiliate_limit');
    for (let attempt = 0; attempt < 5; attempt++) {
      const rows = await tx.$queryRaw<{ id: string; code: string }[]>`INSERT INTO shop_referral_codes(account_id,code,kind,name,commission_bps,created_by)
        VALUES(${ctx.accountId}::uuid,${newReferralCode()},'affiliate',${input.name},${input.commissionBps},${ctx.userId}::uuid)
        ON CONFLICT DO NOTHING RETURNING id::text AS id, code`;
      if (rows[0]) {
        // The name is the seller's own words: it stays out of the audit trail.
        await auditStoreChange(tx, ctx, 'commerce.affiliate_created', rows[0].id, { commission_bps: input.commissionBps });
        return rows[0];
      }
    }
    throw new StoreError('conflict');
  });
}

export interface CodePatch { active?: boolean; commissionBps?: number }

export function parseCodePatch(body: unknown): CodePatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const patch: CodePatch = {};
  if (b.active !== undefined) { if (typeof b.active !== 'boolean') throw new StoreError('invalid', { field: 'active' }); patch.active = b.active; }
  if (b.commission_bps !== undefined) {
    if (typeof b.commission_bps !== 'number' || !Number.isInteger(b.commission_bps) || b.commission_bps < 0 || b.commission_bps > MAX_COMMISSION_BPS) throw new StoreError('invalid', { field: 'commission_bps' });
    patch.commissionBps = b.commission_bps;
  }
  if (patch.active === undefined && patch.commissionBps === undefined) throw new StoreError('invalid');
  return patch;
}

export async function updateReferralCode(ctx: TenantContext & { userId: string }, id: string, patch: CodePatch): Promise<void> {
  if (!isUuid(id)) throw new StoreError('not_found');
  await withTenant(ctx, async (tx) => {
    // A customer's code has no commission: the table CHECK refuses it, and so does this filter.
    const updated = await tx.$executeRaw`UPDATE shop_referral_codes SET active=COALESCE(${patch.active ?? null}::boolean, active),
        commission_bps=CASE WHEN kind='affiliate' THEN COALESCE(${patch.commissionBps ?? null}::integer, commission_bps) ELSE commission_bps END
      WHERE account_id=${ctx.accountId}::uuid AND id=${id}::uuid`;
    if (!updated) throw new StoreError('not_found');
    await auditStoreChange(tx, ctx, 'commerce.referral_code_updated', id, { active: patch.active ?? null, commission_bps: patch.commissionBps ?? null });
  });
}
