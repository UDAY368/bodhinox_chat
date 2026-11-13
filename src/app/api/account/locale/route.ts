// GET /api/account/locale — the signed-in member's interface language. Any member.
//   200 { language, workspace_language, effective, changed } and sets the bodhinox_locale cookie to
//   `effective` (the member's choice, else the workspace default, else the deployment default).
//   `changed` is true when the browser's cookie differed, so the client reloads its messages.
// PUT /api/account/locale — { language: 'en'|'es'|'ko'|'pt'|null } stores the member's own choice
//   (null follows the workspace default). 200 same shape; 400 invalid.

import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { effectiveLocale, isAppLocale, LOCALE_COOKIE, type AppLocale } from '@/lib/i18n/locales';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { getMemberPreferences, saveMemberLanguage } from '@/lib/settings/member-preferences';
import { getWorkspaceSettings } from '@/lib/settings/workspace-settings';

const PRIVATE = { 'Cache-Control': 'private, no-store' };
const YEAR = 365 * 24 * 60 * 60;

async function respond(language: AppLocale | null, workspace: AppLocale | null) {
  const effective = effectiveLocale(language, workspace);
  const current = (await cookies()).get(LOCALE_COOKIE)?.value;
  const response = NextResponse.json(
    { language, workspace_language: workspace, effective, changed: current !== effective },
    { headers: PRIVATE },
  );
  response.cookies.set(LOCALE_COOKIE, effective, {
    path: '/', sameSite: 'lax', httpOnly: true, secure: process.env.NODE_ENV === 'production', maxAge: YEAR,
  });
  return response;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const tenant = tenantOf(ctx);
    const [member, workspace] = await Promise.all([getMemberPreferences(tenant), getWorkspaceSettings(tenant)]);
    return respond(member.language, workspace.default_language);
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await getCurrentAccount();
    const limit = checkRateLimit(`locale:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const body = (await request.json().catch(() => null)) as { language?: unknown } | null;
    const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body) : null;
    if (!keys || keys.length !== 1 || keys[0] !== 'language' || (body!.language !== null && !isAppLocale(body!.language)))
      return NextResponse.json({ error: 'invalid_language', code: 'invalid_language' }, { status: 400 });
    const tenant = tenantOf(ctx);
    const member = await saveMemberLanguage(tenant, body!.language as AppLocale | null);
    const workspace = await getWorkspaceSettings(tenant);
    return respond(member.language, workspace.default_language);
  } catch (error) {
    return toErrorResponse(error);
  }
}
