// ============================================================
// "Create segment from this result" on a finished campaign report (batch 7).
// The segment is a saved filter (lib/audience/segments) with one Campaign
// condition, so it stays live: a person who reads later joins "Delivered, not
// read" no more and moves to "Read, no reply". Built server-side; the
// campaign must be this workspace's (assertFilterReferences, in createSegment).
// ============================================================

import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { AudienceFilterError, AudienceNotFoundError } from '@/lib/audience/filter';
import { createSegment, type Segment } from '@/lib/audience/segments';
import { SEGMENT_RESULTS, type SegmentResult } from '@/lib/audience/outcomes';

const LABELS: Record<SegmentResult, string> = {
  read_not_replied: 'Read, no reply',
  delivered_not_read: 'Delivered, not read',
  failed: 'Failed',
  clicked: 'Clicked',
};

export function isSegmentResult(value: unknown): value is SegmentResult {
  return typeof value === 'string' && (SEGMENT_RESULTS as readonly string[]).includes(value);
}

/** "<campaign> – <result>", cut to the 100-character segment name limit (pure; unit-tested). */
export function resultSegmentName(campaign: string, result: SegmentResult, attempt = 0): string {
  const suffix = ` – ${LABELS[result]}${attempt ? ` (${attempt + 1})` : ''}`;
  return `${campaign.trim().slice(0, 100 - suffix.length)}${suffix}`;
}

/** Only a campaign that started can be split by its results. */
const FINISHED = new Set(['sending', 'paused', 'sent', 'failed', 'cancelled']);

/**
 * Create the segment. AudienceNotFoundError when the campaign is not this
 * workspace's; AudienceFilterError when it never started or the result is
 * unknown. A taken name gets " (2)", " (3)"… up to five tries.
 */
export async function createResultSegment(ctx: TenantContext, broadcastId: string, result: unknown): Promise<Segment> {
  if (!isSegmentResult(result)) throw new AudienceFilterError('Choose a campaign result');
  const rows = await withTenant(ctx, (tx) => tx.$queryRaw<{ name: string; status: string }[]>`
    SELECT name, status FROM broadcasts WHERE account_id=${ctx.accountId}::uuid AND id=${broadcastId}::uuid`);
  if (!rows[0]) throw new AudienceNotFoundError('Campaign unavailable');
  if (!FINISHED.has(rows[0].status)) throw new AudienceFilterError('This campaign has not sent yet');
  const filter = { conditions: [{ field: 'campaign', broadcastId, op: result }] };
  for (let attempt = 0; ; attempt++) {
    try {
      return await createSegment(ctx, { name: resultSegmentName(rows[0].name, result, attempt), filter });
    } catch (error) {
      if (attempt < 4 && error instanceof AudienceFilterError && /already exists/.test(error.message)) continue;
      throw error;
    }
  }
}
