/** Plan switches and caps (no imports, so the browser can use it too). */
export const FEATURES = ['campaign_scheduling', 'contact_export', 'api_campaigns', 'click_tracking', 'retargeting', 'workspace_attributes', 'appointments', 'storefront', 'online_meetings', 'courier_shipping', 'instagram'] as const;
export const LIMITS = ['seats', 'segments', 'lists', 'campaign_recipients', 'active_flows', 'active_automations',
  'ai_messages', 'monthly_active_contacts', 'storage_bytes', 'whatsapp_numbers', 'appointment_staff', 'instagram_accounts',
  // Phase 13: AI tokens per IST month across every AI feature (usage_counters metric 'ai_tokens').
  'ai_tokens_monthly',
  // Phase 14. contacts: every contacts row; integrations: connected payment, store, meeting, courier and ads
  // connections (src/lib/billing/integration-count.ts); messages_monthly: outbound messages this IST month
  // (campaign sends are gated, see limits.ts). A missing key or JSON null is unlimited, so no plan row needed changing.
  'contacts', 'integrations', 'messages_monthly'] as const;
export type Feature = (typeof FEATURES)[number];
export type LimitKey = (typeof LIMITS)[number];

/** Subscription lifecycle (account_subscriptions.status). */
export const SUBSCRIPTION_STATUSES = ['trialing', 'active', 'past_due', 'grace', 'suspended', 'cancelled', 'incomplete'] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];
/** Statuses that do not grant the subscribed plan: the workspace gets 'free'. */
export const NON_GRANTING_STATUSES: readonly SubscriptionStatus[] = ['suspended', 'cancelled', 'incomplete'];

export const ADDON_KINDS = ['extra_seats', 'ai_messages', 'extra_numbers'] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];
/** The limit each add-on raises, by its quantity. */
export const ADDON_LIMIT: Record<AddonKind, LimitKey> = { extra_seats: 'seats', ai_messages: 'ai_messages', extra_numbers: 'whatsapp_numbers' };

/**
 * What happens at and over each limit (docs/billing-limits.md):
 *  - hard: new additions are refused (402); existing items are kept.
 *  - hard_inbound_exempt: manual, import and API creates are refused; inbound (customers writing in) never is.
 *  - hard_addon: refused before the provider call; add-on packs raise the limit.
 *  - hard_per_campaign: checked per campaign, not as a running total.
 *  - hard_campaign: campaign and scheduled-automation sends are refused (requireCampaignSendRoom);
 *    manual replies, bot replies to customers and inbound never are.
 *  - soft: shown and warned about, never blocks.
 */
export const LIMIT_POLICIES = ['hard', 'hard_inbound_exempt', 'hard_addon', 'hard_per_campaign', 'hard_campaign', 'soft'] as const;
export type LimitPolicy = (typeof LIMIT_POLICIES)[number];
export const LIMIT_POLICY: Record<LimitKey, LimitPolicy> = {
  seats: 'hard',
  segments: 'hard',
  lists: 'hard',
  campaign_recipients: 'hard_per_campaign',
  active_flows: 'hard',
  active_automations: 'hard',
  ai_messages: 'hard_addon',
  monthly_active_contacts: 'hard_campaign',
  storage_bytes: 'hard',
  whatsapp_numbers: 'hard',
  appointment_staff: 'hard',
  instagram_accounts: 'hard',
  ai_tokens_monthly: 'hard_addon',
  contacts: 'hard_inbound_exempt',
  integrations: 'hard',
  messages_monthly: 'hard_campaign',
};
/** Limits counted per IST calendar month (reset on the 1st, India time). */
export const MONTHLY_LIMITS: readonly LimitKey[] = ['ai_messages', 'ai_tokens_monthly', 'monthly_active_contacts', 'messages_monthly'];
/** Usage-warning thresholds, percent of a finite limit (usage_notices.threshold). */
export const USAGE_NOTICE_THRESHOLDS = [80, 100] as const;
