// POST /api/instagram/wizards — Instagram › Quick automations (Stage 2).
// Turns a guided setup's answers into a new draft Instagram flow and returns
// it: 201 { flow: { id, name, status: 'draft', channel_scope: 'instagram' } }.
// Nothing is published or sent to Instagram; the draft is checked again when
// it is published.
//
// Agents and above (as for any new flow); live session plus Origin + CSRF
// proof; per-user rate limit. 503 instagram_not_enabled while the platform
// flag is off (before any session or database work); 402 plan_required and
// 409 channel_disabled when the workspace cannot use Instagram; 400
// invalid_request with the refused `field` and its `problem`.

import { NextResponse } from 'next/server';

import { hasMinRole } from '@/lib/auth/roles';
import { assertMutation, requireSession } from '@/lib/auth/session';
import { getWorkspaceChannels } from '@/lib/channels/workspace';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { instagramConfig } from '@/lib/instagram/config';
import { InstagramError } from '@/lib/instagram/errors';
import { notEnabledResponse } from '@/lib/instagram/http';
import { buildWizardFlow, createWizardFlow, parseWizardInput, WizardInputError } from '@/lib/instagram/wizards';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { NO_STORE, readJson, routeError } from '../_lib/route';

export const runtime = 'nodejs';

/** A few drafts a minute is plenty for a person filling in a form. */
const WIZARD_LIMIT = { limit: 10, windowMs: 60_000 };

const t = getT('Instagram.quickAutomations.errors');

/** The workspace's Instagram section is closed: not on its plan, or turned off. */
class InstagramSectionClosed extends Error {
  constructor(readonly code: 'plan_required' | 'channel_disabled' | 'platform_off') {
    super(`Instagram section: ${code}`);
  }
}

export async function POST(request: Request) {
  try {
    if (!instagramConfig()) return notEnabledResponse();
    const session = await requireSession(request);
    await assertMutation(request, session);
    if (!hasMinRole(session.role, 'agent')) throw new InstagramError('forbidden');
    const limited = checkRateLimit(`instagram:wizards:${session.userId}`, WIZARD_LIMIT);
    if (!limited.success) return rateLimitResponse(limited);

    const body = await readJson(request);
    let draft;
    try {
      draft = buildWizardFlow(parseWizardInput(body));
    } catch (error) {
      if (!(error instanceof WizardInputError)) throw error;
      const message = error.problem === 'invalid' ? t('invalid') : t(error.problem);
      return NextResponse.json({ error: message, code: 'invalid_request', field: error.field, problem: error.problem },
        { status: 400, headers: NO_STORE });
    }

    const tenant = { accountId: session.accountId, userId: session.userId, role: session.role };
    const flow = await withTenant(tenant, async (tx) => {
      const { instagram } = (await getWorkspaceChannels(tx, session.accountId)).channels;
      if (!instagram.enabled) {
        throw new InstagramSectionClosed(instagram.unavailableReason === 'plan' ? 'plan_required'
          : instagram.unavailableReason === 'platform_off' ? 'platform_off' : 'channel_disabled');
      }
      return createWizardFlow(tx, { accountId: session.accountId, userId: session.userId }, draft);
    });
    return NextResponse.json({ flow }, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof InstagramSectionClosed) {
      if (error.code === 'platform_off') return notEnabledResponse();
      const planRequired = error.code === 'plan_required';
      return NextResponse.json({ error: t(planRequired ? 'planRequired' : 'channelDisabled'), code: error.code },
        { status: planRequired ? 402 : 409, headers: NO_STORE });
    }
    return routeError(error);
  }
}
