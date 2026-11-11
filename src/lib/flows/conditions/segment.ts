// The `segment` condition subject (Stage 5): whether the run's contact is in a
// saved segment of this workspace. "true" / "false", or undefined when the
// segment is gone or belongs to another workspace (so only `absent` holds,
// never a guess). Read on the worker connection inside the run's tenant.
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { contactInSegment } from '@/lib/audience/membership';

export async function segmentSubject(run: { account_id: string; contact_id: string | null }, segmentId: string): Promise<string | undefined> {
  if (!run.contact_id) return undefined;
  const member = await withTenant({ accountId: run.account_id, role: 'owner' },
    (tx) => contactInSegment(tx, run.account_id, segmentId, run.contact_id!), getWorkerPrisma());
  return member === null ? undefined : String(member);
}
