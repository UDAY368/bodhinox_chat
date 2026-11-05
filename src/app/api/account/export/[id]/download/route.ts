// GET /api/account/export/[id]/download: streams one ready workspace export (zip).
// Signed-in owners and admins of the export's workspace only; every download is
// audit-logged before the file is sent. The file is private, never cached and never
// served from a public URL. 404 unknown or another workspace's export, 409 not
// ready, failed or expired.

import { getExportFile, openWorkspaceExportDownload } from '@/lib/account/export';
import { accountActionResponse } from '@/lib/account/deletion';
import { requireSession } from '@/lib/auth/session';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(request);
    const limit = checkRateLimit(`account:exportDownload:${session.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    const { id } = await params;
    const opened = await openWorkspaceExportDownload(session, id);
    const file = await getExportFile(session.accountId, opened.objectKey);
    return new Response(file, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${opened.filename}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return accountActionResponse(error);
  }
}
