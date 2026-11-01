/**
 * Retargeting outcomes for a "Campaign" audience condition. Shared by the
 * filter engine and the segment builder (client), so it imports nothing.
 *
 * Recipient statuses only move forward (sent → delivered → read → replied),
 * so "delivered" also covers read and replied. `not_read` = received but
 * never read; `not_received` = in the campaign but never got it (failed or
 * still pending), or not in it at all.
 */
export const CAMPAIGN_OUTCOMES = ['received', 'delivered', 'read', 'replied', 'failed', 'not_read', 'not_received'] as const;
export type CampaignOutcome = (typeof CAMPAIGN_OUTCOMES)[number];

/** Recipient statuses that match each outcome (`not_received` is the negation of `received`). */
export const OUTCOME_STATUSES: Record<CampaignOutcome, readonly string[]> = {
  received: ['sent', 'delivered', 'read', 'replied'],
  delivered: ['delivered', 'read', 'replied'],
  read: ['read', 'replied'],
  replied: ['replied'],
  failed: ['failed'],
  not_read: ['sent', 'delivered'],
  not_received: ['sent', 'delivered', 'read', 'replied'],
};
