/**
 * Retargeting outcomes for a "Campaign" audience condition. Shared by the
 * filter engine and the segment builder (client), so it imports nothing.
 *
 * Recipient statuses only move forward (sent → delivered → read → replied),
 * so "delivered" also covers read and replied. `not_read` = received but
 * never read; `not_received` = in the campaign but never got it (failed or
 * still pending), or not in it at all. `read_not_replied` and
 * `delivered_not_read` are exactly one status; `clicked` = tapped the
 * campaign's tracked link (any status).
 */
export const CAMPAIGN_OUTCOMES = [
  'received', 'delivered', 'read', 'replied', 'failed', 'not_read', 'not_received', 'read_not_replied', 'delivered_not_read', 'clicked',
] as const;
export type CampaignOutcome = (typeof CAMPAIGN_OUTCOMES)[number];

/** Recipient statuses that match each outcome (`not_received` is the negation of `received`; `clicked` is any status with a click). */
export const OUTCOME_STATUSES: Record<CampaignOutcome, readonly string[]> = {
  received: ['sent', 'delivered', 'read', 'replied'],
  delivered: ['delivered', 'read', 'replied'],
  read: ['read', 'replied'],
  replied: ['replied'],
  failed: ['failed'],
  not_read: ['sent', 'delivered'],
  not_received: ['sent', 'delivered', 'read', 'replied'],
  read_not_replied: ['read'],
  delivered_not_read: ['delivered'],
  clicked: ['sent', 'delivered', 'read', 'replied', 'failed'],
};

/** The "Create segment from this result" buttons on a finished campaign report. */
export const SEGMENT_RESULTS = ['read_not_replied', 'delivered_not_read', 'failed', 'clicked'] as const satisfies readonly CampaignOutcome[];
export type SegmentResult = (typeof SEGMENT_RESULTS)[number];
