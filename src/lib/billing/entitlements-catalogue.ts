/** Plan switches and caps (no imports, so the browser can use it too). */
export const FEATURES = ['campaign_scheduling', 'contact_export', 'api_campaigns', 'click_tracking', 'retargeting', 'workspace_attributes', 'appointments', 'storefront'] as const;
export const LIMITS = ['seats', 'segments', 'lists', 'campaign_recipients', 'active_flows', 'active_automations',
  'ai_messages', 'monthly_active_contacts', 'storage_bytes', 'whatsapp_numbers', 'appointment_staff'] as const;
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
