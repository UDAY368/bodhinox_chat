// HTTP mapping shared by the Phase 12 flow lifecycle routes (activate,
// versions, runs/migrate, runs/cancel). Errors carry fixed, translated
// messages; nothing from the database reaches the browser.
import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse, type AccountContext } from '@/lib/auth/account';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { getT } from '@/lib/i18n/translate';
import { FlowVersionError } from './versions';

const t = getT('Api');

export function flowVersionErrorResponse(err: unknown): NextResponse {
  if (err instanceof FlowVersionError) {
    switch (err.code) {
      case 'not_found':
        return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
      case 'draft_changed':
        return NextResponse.json({ error: t('flows.draftChanged'), draft_hash: err.detail.draft_hash }, { status: 409 });
      case 'invalid':
        return NextResponse.json({ error: t('flows.cannotActivate'), issues: err.detail.issues }, { status: 422 });
      case 'not_published':
        return NextResponse.json({ error: t('flows.notPublished') }, { status: 409 });
      case 'active_runs':
        return NextResponse.json({ error: t('flows.activeRuns', { count: Number(err.detail.active_runs) || 0 }),
          active_runs: err.detail.active_runs }, { status: 409 });
      case 'nothing_to_migrate':
        return NextResponse.json({ error: t('flows.nothingToMigrate') }, { status: 409 });
    }
  }
  const response = toErrorResponse(err);
  // An unexpected failure answers with the translated generic error, never its message.
  if (response.status === 500) return NextResponse.json({ error: t('common.internalServerError') }, { status: 500 });
  return response;
}

/**
 * The caller of a mutating lifecycle route: a live session with role >= agent
 * whose request passed the Origin/CSRF check.
 */
export async function requireFlowMutation(request: Request): Promise<AccountContext> {
  const session = await requireSession(request);
  await assertMutation(request, session);
  return requireRole('agent');
}

export const FLOW_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
