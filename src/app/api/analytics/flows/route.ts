// GET /api/analytics/flows?preset=&from=&to=[&flow=<id>]
// Flow run outcomes and the node where unfinished runs stopped
// (viewer and above). `flows` names the workspace's flows for the filter
// and for labelling drop-off rows.

import { Prisma } from '@prisma/client';

import { analyticsReport } from '@/lib/analytics/http';
import { flowStats } from '@/lib/analytics/queries';

const FLOW_OPTION_LIMIT = 200;

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const stats = await flowStats(tx, accountId, range, params.get('flow') || null);
    const flows = await tx.$queryRaw<{ id: string; name: string }[]>(Prisma.sql`
      SELECT id, name FROM flows WHERE account_id=${accountId}::uuid
      ORDER BY name, id LIMIT ${FLOW_OPTION_LIMIT}`);
    return { stats, flows };
  });
}
