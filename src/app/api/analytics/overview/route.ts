// GET /api/analytics/overview?preset=&from=&to=&number=
// Conversation report for the range and the same-length period before it,
// optionally for one WhatsApp number or one channel (?channel=whatsapp|instagram). Any member who can read conversations
// (viewer and above). `numbers` lists the workspace's numbers for the filter by
// id and display name only: no phone number is returned, so masked members get
// none either.

import { Prisma } from '@prisma/client';

import { analyticsReport, previousRange, rangeSummary } from '@/lib/analytics/http';
import { conversationStats } from '@/lib/analytics/queries';

export async function GET(request: Request) {
  return analyticsReport(request, 'viewer', async ({ tx, accountId, range, params }) => {
    const filters = { whatsappConfigId: params.get('number') || null, channel: (params.get('channel') || null) as 'whatsapp' | 'instagram' | null };
    const previous = previousRange(range);
    const current = await conversationStats(tx, accountId, range, filters);
    const before = await conversationStats(tx, accountId, previous, filters);
    const numbers = await tx.$queryRaw<{ id: string; label: string | null; isDefault: boolean }[]>(Prisma.sql`
      SELECT id, display_name AS label, is_default AS "isDefault" FROM whatsapp_config
      WHERE account_id=${accountId}::uuid ORDER BY is_default DESC, created_at, id LIMIT 50`);
    return { previousRange: rangeSummary(previous), current, previous: before, numbers };
  });
}
