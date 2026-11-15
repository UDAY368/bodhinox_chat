// GET /api/commerce/store-site/theme — the theme editor: draft, versions and
// preview data (agents and above).
//   200 ThemeEditorView
// PUT /api/commerce/store-site/theme — save the draft (admins), checked
// against draftVersion. The live shop does not change.
//   body { expectedDraftVersion, document }   200 ThemeEditorView
// POST /api/commerce/store-site/theme — publish, discard the draft, or bring
// an older version back into the draft (admins).
//   body { action: 'publish'|'discard', expectedDraftVersion } | { action: 'restore', number, expectedDraftVersion }
// Errors: 400/403/404/409/413 { error, code, field? }. Session CSRF by the proxy (assertMutation).

import { NextResponse } from 'next/server';
import { BodyTooLargeError, readBoundedBody } from '@/lib/api/bounded-body';
import { requireRole } from '@/lib/auth/account';
import { tenantOf } from '@/lib/audience/http';
import { getThemeEditor, parseDraftInput, parseThemeAction, runThemeAction, saveThemeDraft } from '@/lib/commerce/shop-theme';
import { StoreError, storeErrorResponse } from '@/lib/commerce/store-settings';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';

export const runtime = 'nodejs';

/** A draft is at most ~100 KB of JSON (shop-sections.ts); leave room for the wrapper. */
const MAX_BODY = 160_000;

async function readJson(request: Request): Promise<unknown> {
  try {
    return JSON.parse(new TextDecoder().decode(await readBoundedBody(request, MAX_BODY)));
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw new StoreError('invalid', { field: 'document' });
    return null;
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('agent');
    return NextResponse.json(await getThemeEditor(tenantOf(ctx)), { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:store-theme:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseDraftInput(await readJson(request));
    return NextResponse.json(await saveThemeDraft({ ...tenantOf(ctx), userId: ctx.userId }, input));
  } catch (error) {
    return storeErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    const limit = checkRateLimit(`commerce:store-theme:${ctx.userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);
    const input = parseThemeAction(await readJson(request));
    return NextResponse.json(await runThemeAction({ ...tenantOf(ctx), userId: ctx.userId }, input));
  } catch (error) {
    return storeErrorResponse(error);
  }
}
