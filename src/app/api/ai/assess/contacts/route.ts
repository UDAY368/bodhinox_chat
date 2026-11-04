// GET /api/ai/assess/contacts?ids=<up to 100 comma-separated uuids> (agents
//   and above, 'ai.assist') — the newest current advisory assessment of each
//   listed contact in the caller's workspace: 200 { enabled, assessments:
//   { [contactId]: { conversation_id, intent, intent_confidence, lead_score,
//   source, route_to_staff, created_at } } }. Contacts without one are absent.
//   Read-only; ids of other workspaces simply match nothing (RLS).

import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { requirePermission } from '@/lib/auth/permissions';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { readAiSettings } from '@/lib/ai/settings';
import { readContactAssessments } from '@/lib/ai/assess/repo';
import { getT } from '@/lib/i18n/translate';

const t = getT('Api');
const noStore = { 'Cache-Control': 'private, no-store' };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_CONTACT_IDS = 100;

/** The distinct ids in `raw`, or null when any is not a uuid or there are too many. */
function parseIds(raw: string | null): string[] | null {
  if (!raw) return [];
  const ids = [...new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
  if (ids.length > MAX_CONTACT_IDS || ids.some((id) => !UUID.test(id))) return null;
  return ids;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent');
    await requirePermission(tenantOf(ctx), 'ai.assist');
    const ids = parseIds(new URL(request.url).searchParams.get('ids'));
    if (!ids) return NextResponse.json({ error: t('common.invalidRequestBody'), code: 'invalid' }, { status: 400 });
    const view = await withTenant(tenantOf(ctx), async (tx) => {
      const enabled = (await readAiSettings(tx, ctx.accountId)).assessment_enabled;
      const rows = await readContactAssessments(tx, ctx.accountId, ids);
      return {
        enabled,
        assessments: Object.fromEntries(rows.map((r) => [r.contact_id, {
          conversation_id: r.conversation_id, intent: r.intent, intent_confidence: r.intent_confidence,
          lead_score: r.lead_score, source: r.source, route_to_staff: !!r.qualification?.route_to_staff, created_at: r.created_at,
        }])),
      };
    });
    return NextResponse.json(view, { headers: noStore });
  } catch (error) {
    return toErrorResponse(error);
  }
}
