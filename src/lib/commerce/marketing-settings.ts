/**
 * The shop's marketing settings (store plan Phase 8, batch 6): the order confirmation email switch, the sender details every
 * marketing email carries, and the referral program. One row per workspace, written by admins only (RLS and the route both
 * check); agents read it, and the jobs read it through the worker inside the workspace. Defaults: everything off.
 */
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { emailConnected } from './email-send';
import type { MarketingSettingsInput } from './email-rules';
import { minorFromDb } from './money';
import { auditStoreChange } from './store-settings';

export interface MarketingSettings extends MarketingSettingsInput {
  /** The platform's SMTP is configured, so emails can leave. False: "not connected"; nothing is sent. */
  email_connected: boolean;
}

export const DEFAULT_MARKETING_SETTINGS: MarketingSettingsInput = {
  order_emails_enabled: false, sender_name: null, sender_address: null, reply_to: null,
  referral_enabled: false, referral_reward_minor: 0, referral_hold_days: 14,
};

export async function loadMarketingSettingsTx(tx: TenantTransaction, accountId: string): Promise<MarketingSettings> {
  const [row] = await tx.$queryRaw<{ order_emails_enabled: boolean; sender_name: string | null; sender_address: string | null; reply_to: string | null;
    referral_enabled: boolean; referral_reward_minor: bigint; referral_hold_days: number }[]>`
    SELECT order_emails_enabled, sender_name, sender_address, reply_to, referral_enabled, referral_reward_minor, referral_hold_days
    FROM shop_marketing_settings WHERE account_id=${accountId}::uuid`;
  const base = row ? { ...row, referral_reward_minor: minorFromDb(row.referral_reward_minor) ?? 0 } : DEFAULT_MARKETING_SETTINGS;
  return { ...base, email_connected: emailConnected() };
}

export function getMarketingSettings(ctx: TenantContext): Promise<MarketingSettings> {
  return withTenant(ctx, (tx) => loadMarketingSettingsTx(tx, ctx.accountId));
}

export async function saveMarketingSettings(ctx: TenantContext & { userId: string }, input: MarketingSettingsInput): Promise<MarketingSettings> {
  return withTenant(ctx, async (tx) => {
    await tx.$executeRaw`INSERT INTO shop_marketing_settings(account_id,order_emails_enabled,sender_name,sender_address,reply_to,referral_enabled,
        referral_reward_minor,referral_hold_days)
      VALUES(${ctx.accountId}::uuid,${input.order_emails_enabled},${input.sender_name},${input.sender_address},${input.reply_to},${input.referral_enabled},
        ${BigInt(input.referral_reward_minor)},${input.referral_hold_days})
      ON CONFLICT (account_id) DO UPDATE SET order_emails_enabled=EXCLUDED.order_emails_enabled, sender_name=EXCLUDED.sender_name,
        sender_address=EXCLUDED.sender_address, reply_to=EXCLUDED.reply_to, referral_enabled=EXCLUDED.referral_enabled,
        referral_reward_minor=EXCLUDED.referral_reward_minor, referral_hold_days=EXCLUDED.referral_hold_days`;
    // Switches and the reward only: the sender's words and address stay out of the audit trail.
    await auditStoreChange(tx, ctx, 'commerce.marketing_settings_updated', ctx.accountId, {
      order_emails: input.order_emails_enabled, referral: input.referral_enabled, reward_minor: input.referral_reward_minor, hold_days: input.referral_hold_days,
    });
    return loadMarketingSettingsTx(tx, ctx.accountId);
  });
}
