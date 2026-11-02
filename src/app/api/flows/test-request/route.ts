// POST /api/flows/test-request { config, vars? } — sends an API Request
// step's request once from the server so the editor can check it before
// saving (agent+, rate limited). Same request, SSRF checks and limits as
// a live run; nothing is stored.

import { NextResponse } from 'next/server';
import { z } from 'zod';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { hasMinRole } from '@/lib/auth/roles';
import { runApiRequest } from '@/lib/flows/api-request';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit';
import { workspaceValuesFor } from '@/lib/workspace/attributes';

const t = getT('Api');
const pair = z.object({ key: z.string().max(200), value: z.string().max(2000) });
const Body = z.object({
  config: z.object({
    method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
    url: z.string().trim().min(1).max(2048),
    params: z.array(pair).max(20).optional(),
    headers: z.array(pair).max(20).optional(),
    body: z.string().max(20_000).optional(),
    mappings: z.array(z.object({ path: z.string().max(200), var_key: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/) })).max(20).optional(),
  }),
  /** Sample values for {{vars.x}} and {{contact.x}} placeholders. */
  vars: z.record(z.string(), z.string().max(1000)).optional(),
  contact: z.record(z.string(), z.string().max(1000)).optional(),
});
/** Enough of the reply to check a mapping; the full body stays on the server. */
const PREVIEW_CHARS = 4000;

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('agent');
    const limit = checkRateLimit(`flowTestRequest:${ctx.userId}`, RATE_LIMITS.flowTestRequest);
    if (!limit.success) return rateLimitResponse(limit);
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 });
    const { config, vars = {}, contact = {} } = parsed.data;
    const [workspace, publicWorkspace] = await Promise.all([
      // Secret values are admin-only: an agent's test would send them to a URL of their choosing.
      workspaceValuesFor(ctx.accountId, JSON.stringify([config.headers, config.body]), { secrets: hasMinRole(ctx.role, 'admin') }),
      workspaceValuesFor(ctx.accountId, JSON.stringify([config.url, config.params])),
    ]);
    const outcome = await runApiRequest({ ...config, fallback_next: '' }, { vars, contact, workspace, publicWorkspace });
    const { result } = outcome;
    return NextResponse.json({
      status: result.ok ? result.status : null,
      error: result.ok ? null : result.error,
      duration_ms: outcome.durationMs,
      mapped: outcome.mapped,
      preview: result.ok ? result.body.slice(0, PREVIEW_CHARS) : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
