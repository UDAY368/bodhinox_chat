/**
 * Store plan Phase 8, batch 6: the shop's email jobs (worker role, inside the workspace).
 *
 *  - shop.email_send: one recipient of a campaign. The recipient row is the dedupe: a settled row ends the job. Consent is checked
 *    again now (emailRefusal: a contact who unsubscribed after the campaign was queued is skipped), nothing leaves without SMTP
 *    (email not connected) or the sender's postal address, and the send goes through dispatchOnce with the key shop-email:<campaign>:<contact>.
 *    An uncertain outcome closes the row as 'unknown' for staff to see and is never sent again; a replayed job finds the row or the intent.
 *  - shop.order_email: the one confirmation email of an order (key shop-order-email:<order>), only when the shop turned it on, the
 *    buyer's contact has an email address and email is connected. It is a transactional message: no marketing consent is needed and an
 *    unsubscribe does not stop it. The result is one row of shop_order_emails.
 *  - unsubscribeByToken: the public unsubscribe page. Idempotent, never reveals whether the contact exists.
 *
 * Logs carry ids and codes only: no addresses, subjects, bodies or provider answers.
 */
import { withTenant } from '@/lib/db/tenant';
import { getWorkerPrisma } from '@/lib/db/prisma';
import type { TenantTransaction } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { dispatchOnce, UncertainDispatchError } from '@/lib/jobs/dispatch';
import { campaignIntentKey, campaignText, emailRefusal, isEmailAddress, orderEmailIntentKey, orderEmailJobKey } from './email-rules';
import { emailConnected, readUnsubscribeToken, sendShopMail, unsubscribeToken, unsubscribeUrl } from './email-send';
import { loadMarketingSettingsTx } from './marketing-settings';
import { minorFromDb, minorToDecimalString } from './money';
import { isUuid } from './store-settings';

export const ORDER_EMAIL_JOB = 'shop.order_email';

const worker = <T,>(accountId: string, fn: (tx: TenantTransaction) => Promise<T>) => withTenant({ accountId, role: 'owner' }, fn, getWorkerPrisma());

type RecipientStatus = 'sent' | 'skipped' | 'failed' | 'unknown';

async function shopHandle(tx: TenantTransaction, accountId: string): Promise<string | null> {
  const [row] = await tx.$queryRaw<{ handle: string }[]>`SELECT handle FROM shop_storefronts WHERE account_id=${accountId}::uuid`;
  return row?.handle ?? null;
}

export async function handleEmailSendJob(accountId: string, payload: { campaignId: string; contactId: string }): Promise<RecipientStatus | 'done'> {
  const { campaignId, contactId } = payload;
  if (!isUuid(campaignId) || !isUuid(contactId)) throw new Error('Invalid email job');
  const settle = (status: RecipientStatus, reason: string | null) => worker(accountId, (tx) => tx.$executeRaw`
    UPDATE shop_email_recipients SET status=${status}, reason=${reason}, settled_at=now()
    WHERE account_id=${accountId}::uuid AND campaign_id=${campaignId}::uuid AND contact_id=${contactId}::uuid AND status IN ('queued','sending')`);

  const plan = await worker(accountId, async (tx) => {
    const [recipient] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM shop_email_recipients
      WHERE account_id=${accountId}::uuid AND campaign_id=${campaignId}::uuid AND contact_id=${contactId}::uuid`;
    if (!recipient || !['queued', 'sending'].includes(recipient.status)) return { kind: 'done' as const };
    const [campaign] = await tx.$queryRaw<{ subject: string; body: string; status: string }[]>`SELECT subject, body, status FROM shop_email_campaigns
      WHERE account_id=${accountId}::uuid AND id=${campaignId}::uuid`;
    if (!campaign) return { kind: 'close' as const, reason: 'campaign_missing' };
    if (campaign.status === 'cancelled') return { kind: 'close' as const, reason: 'cancelled' };
    const [contact] = await tx.$queryRaw<{ email: string | null; blocked_at: Date | null }[]>`SELECT email, blocked_at FROM contacts
      WHERE account_id=${accountId}::uuid AND id=${contactId}::uuid`;
    const [prefs] = await tx.$queryRaw<{ opted_in_at: Date | null; unsubscribed_at: Date | null }[]>`SELECT opted_in_at, unsubscribed_at FROM shop_email_prefs
      WHERE account_id=${accountId}::uuid AND contact_id=${contactId}::uuid`;
    const refusal = contact ? emailRefusal(contact, prefs ?? null) : 'contact_missing';
    if (refusal) return { kind: 'close' as const, reason: refusal };
    if (!emailConnected()) return { kind: 'close' as const, reason: 'email_not_connected' };
    const settings = await loadMarketingSettingsTx(tx, accountId);
    if (!settings.sender_address) return { kind: 'close' as const, reason: 'sender_details_required' };
    await tx.$executeRaw`UPDATE shop_email_recipients SET status='sending' WHERE account_id=${accountId}::uuid AND campaign_id=${campaignId}::uuid
      AND contact_id=${contactId}::uuid AND status='queued'`;
    return {
      kind: 'send' as const, to: contact!.email!.trim().toLowerCase(), subject: campaign.subject, body: campaign.body,
      senderName: settings.sender_name, senderAddress: settings.sender_address, replyTo: settings.reply_to, handle: await shopHandle(tx, accountId),
    };
  });
  if (plan.kind === 'done') return 'done';
  if (plan.kind === 'close') { await settle('skipped', plan.reason); return 'skipped'; }

  const link = unsubscribeUrl(plan.handle, unsubscribeToken(accountId, contactId));
  const text = campaignText({
    body: plan.body, senderName: plan.senderName, senderAddress: plan.senderAddress, unsubscribeUrl: link,
    unsubscribeLine: getT('ShopMarketing.email')('unsubscribeLine'),
  });
  try {
    await dispatchOnce(accountId, campaignIntentKey(campaignId, contactId), async () => {
      await sendShopMail({ to: plan.to, subject: plan.subject, text, senderName: plan.senderName, replyTo: plan.replyTo, unsubscribe: link });
      return { sent: true };
    });
  } catch (error) {
    // Any failure may have reached the server: surfaced for staff, never sent again.
    if (error instanceof UncertainDispatchError) { await settle('unknown', 'outcome_unknown'); return 'unknown'; }
    await settle('failed', 'send_failed');
    console.error('[shop-email] campaign send failed', { campaignId });
    return 'failed';
  }
  await settle('sent', null);
  return 'sent';
}

// ---------------------------------------------------------------------------
// Order confirmation

/**
 * The optional email typed at checkout (worker role, inside the placing transaction). It is kept on the order (confirmations go to
 * it); the contact takes it only when the contact has no address yet, so a stranger typing an address can never replace a customer's
 * own. "Email me offers" (unticked by default) records consent, source 'checkout', only when the address is the contact's own address,
 * because campaigns go to the contact's address. An unsubscribe always wins: the row is never touched once unsubscribed, and an
 * earlier consent keeps its first time.
 */
export async function recordCheckoutEmailTx(tx: TenantTransaction, accountId: string,
  input: { orderId: string; contactId: string; email: string; offers: boolean; now: Date }): Promise<void> {
  await tx.$executeRaw`UPDATE orders SET buyer_email=${input.email} WHERE account_id=${accountId}::uuid AND id=${input.orderId}::uuid`;
  await tx.$executeRaw`UPDATE contacts SET email=${input.email} WHERE account_id=${accountId}::uuid AND id=${input.contactId}::uuid AND COALESCE(btrim(email),'')=''`;
  if (!input.offers) return;
  await tx.$executeRaw`INSERT INTO shop_email_prefs(account_id,contact_id,opted_in_at,opt_in_source)
    SELECT c.account_id, c.id, ${input.now}, 'checkout' FROM contacts c
    WHERE c.account_id=${accountId}::uuid AND c.id=${input.contactId}::uuid AND lower(btrim(c.email))=${input.email}
    ON CONFLICT (account_id, contact_id) DO UPDATE SET opted_in_at=EXCLUDED.opted_in_at, opt_in_source=EXCLUDED.opt_in_source
      WHERE shop_email_prefs.unsubscribed_at IS NULL AND shop_email_prefs.opted_in_at IS NULL`;
}

/**
 * Called in the transaction that places an order (worker role): queues the one confirmation job (key oemail:<order>) when the shop
 * turned the email on and the buyer's contact has an address. Nothing is queued otherwise; a replay changes nothing.
 */
export async function queueOrderEmailTx(tx: TenantTransaction, accountId: string, orderId: string): Promise<void> {
  const settings = await loadMarketingSettingsTx(tx, accountId);
  if (!settings.order_emails_enabled) return;
  const [buyer] = await tx.$queryRaw<{ email: string | null }[]>`SELECT COALESCE(NULLIF(btrim(o.buyer_email),''), c.email) AS email FROM orders o JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id
    WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid`;
  if (!isEmailAddress(buyer?.email?.trim())) return;
  await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key) VALUES(${ORDER_EMAIL_JOB},${accountId}::uuid,${JSON.stringify({ orderId })}::jsonb,${orderEmailJobKey(orderId)})
    ON CONFLICT(dedupe_key) DO NOTHING`;
}

const reference = (orderId: string) => orderId.replace(/-/g, '').slice(0, 8).toUpperCase();

export async function handleOrderEmailJob(accountId: string, payload: { orderId: string }): Promise<RecipientStatus | 'done'> {
  const { orderId } = payload;
  if (!isUuid(orderId)) throw new Error('Invalid order email job');
  const record = (status: RecipientStatus, reason: string | null) => worker(accountId, (tx) => tx.$executeRaw`
    INSERT INTO shop_order_emails(account_id,order_id,status,reason) VALUES(${accountId}::uuid,${orderId}::uuid,${status},${reason})
    ON CONFLICT (account_id, order_id) DO NOTHING`);
  const plan = await worker(accountId, async (tx) => {
    const [done] = await tx.$queryRaw<{ status: string }[]>`SELECT status FROM shop_order_emails WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid`;
    if (done) return { kind: 'done' as const };
    // An order of another workspace (or one that is gone) is nothing to record.
    const [exists] = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM orders WHERE account_id=${accountId}::uuid AND id=${orderId}::uuid`;
    if (!exists) return { kind: 'done' as const };
    const settings = await loadMarketingSettingsTx(tx, accountId);
    if (!settings.order_emails_enabled) return { kind: 'close' as const, reason: 'switched_off' };
    if (!emailConnected()) return { kind: 'close' as const, reason: 'email_not_connected' };
    const [order] = await tx.$queryRaw<{ email: string | null; status: string; currency: string; total_minor: bigint | null; subtotal_minor: bigint; payment_method: string | null }[]>`
      SELECT COALESCE(NULLIF(btrim(o.buyer_email),''), c.email) AS email, o.status, o.currency, o.total_minor, o.subtotal_minor, o.payment_method FROM orders o
      LEFT JOIN contacts c ON c.account_id=o.account_id AND c.id=o.contact_id WHERE o.account_id=${accountId}::uuid AND o.id=${orderId}::uuid`;
    if (!order || !isEmailAddress(order.email?.trim())) return { kind: 'close' as const, reason: 'no_email' };
    if (order.status === 'cancelled' || order.status === 'expired') return { kind: 'close' as const, reason: 'order_closed' };
    const items = await tx.$queryRaw<{ name: string; quantity: number }[]>`SELECT name, quantity FROM order_items
      WHERE account_id=${accountId}::uuid AND order_id=${orderId}::uuid ORDER BY id LIMIT 30`;
    const [shop] = await tx.$queryRaw<{ name: string | null }[]>`SELECT COALESCE(NULLIF(cs.storefront_title,''), a.name) AS name FROM accounts a
      LEFT JOIN commerce_settings cs ON cs.account_id=a.id WHERE a.id=${accountId}::uuid`;
    return {
      kind: 'send' as const, to: order.email!.trim().toLowerCase(), shop: shop?.name ?? '', items, currency: order.currency,
      total: minorToDecimalString(minorFromDb(order.total_minor ?? order.subtotal_minor) ?? 0, order.currency), cod: order.payment_method === 'cod',
      senderName: settings.sender_name, replyTo: settings.reply_to,
    };
  });
  if (plan.kind === 'done') return 'done';
  if (plan.kind === 'close') { await record('skipped', plan.reason); return 'skipped'; }

  const t = getT('ShopMarketing.orderEmail');
  const lines = plan.items.map((i) => `- ${i.quantity} x ${i.name}`);
  const text = [t('intro', { shop: plan.shop }), '', `${t('reference')}: ${reference(orderId)}`, ...lines, '', `${t('total')}: ${plan.currency} ${plan.total}`,
    plan.cod ? t('cod') : '', '', t('thanks', { shop: plan.shop })].filter((l, i, all) => l !== '' || all[i - 1] !== '').join('\n') + '\n';
  try {
    await dispatchOnce(accountId, orderEmailIntentKey(orderId), async () => {
      await sendShopMail({ to: plan.to, subject: t('subject', { shop: plan.shop, reference: reference(orderId) }), text, senderName: plan.senderName || plan.shop || null, replyTo: plan.replyTo });
      return { sent: true };
    });
  } catch (error) {
    if (error instanceof UncertainDispatchError) { await record('unknown', 'outcome_unknown'); return 'unknown'; }
    await record('failed', 'send_failed');
    console.error('[shop-email] order confirmation failed', { orderId });
    return 'failed';
  }
  await record('sent', null);
  return 'sent';
}

// ---------------------------------------------------------------------------
// Unsubscribe (public)

/**
 * Record an unsubscribe for the contact a token names. Idempotent; the first time stays on record. Returns false for a token that
 * was not made by us (the page says the link is not valid), true otherwise, even when the contact no longer exists.
 */
export async function unsubscribeByToken(token: unknown): Promise<boolean> {
  const ids = readUnsubscribeToken(token);
  if (!ids) return false;
  try {
    await withTenant({ accountId: ids.accountId, role: 'owner' }, (tx) => tx.$executeRaw`
      INSERT INTO shop_email_prefs(account_id,contact_id,unsubscribed_at) VALUES(${ids.accountId}::uuid,${ids.contactId}::uuid,now())
      ON CONFLICT (account_id, contact_id) DO UPDATE SET unsubscribed_at=COALESCE(shop_email_prefs.unsubscribed_at, now())`, getWorkerPrisma());
  } catch (error) {
    // The contact was erased (foreign key) or the workspace is gone: nothing left to email either way.
    if (!String((error as { meta?: { code?: string } })?.meta?.code ?? (error as Error).message).includes('23503')) throw error;
  }
  return true;
}
