// Whether one contact is in a saved segment (Stage 5: the flow condition
// subject `segment`). The segment's stored filter is compiled exactly as the
// contact list and campaigns compile it, then tested for this one contact, so
// a condition and the Contacts page always agree. Runs inside the caller's
// tenant transaction: RLS and the explicit account filter keep it in the
// workspace, and a segment id from another workspace reads as "not found".
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import { AudienceFilterError, compileAudienceFilter } from './filter';
import { loadSegmentFilter } from './segments';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * True or false for a segment of this workspace; null when the segment does not
 * exist here (deleted, or another workspace's id) or its stored filter no longer
 * parses. Never throws for those cases, so a condition can treat null as
 * "unknown" rather than failing the run.
 */
export async function contactInSegment(tx: TenantTransaction, accountId: string, segmentId: string, contactId: string): Promise<boolean | null> {
  if (!UUID.test(segmentId) || !UUID.test(contactId)) return null;
  let filter;
  try {
    filter = await loadSegmentFilter(tx, accountId, segmentId);
  } catch (error) {
    if (error instanceof AudienceFilterError) return null;
    throw error;
  }
  const [row] = await tx.$queryRaw<{ member: boolean }[]>(Prisma.sql`
    SELECT EXISTS(SELECT 1 FROM contacts c WHERE c.id=${contactId}::uuid AND ${compileAudienceFilter(accountId, filter)}) AS member`);
  return row?.member === true;
}
