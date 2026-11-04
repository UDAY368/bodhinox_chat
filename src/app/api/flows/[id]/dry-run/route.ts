import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { tenantOf } from '@/lib/audience/http';
import { withTenant } from '@/lib/db/tenant';
import { getT } from '@/lib/i18n/translate';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import { DryRunError, parseDryRunRequest, runDryRun } from '@/lib/flows/dry-run';
import { FLOW_ID, flowVersionErrorResponse, requireFlowMutation } from '@/lib/flows/version-http';

const t = getT('Api');

/**
 * POST /api/flows/[id]/dry-run (agent+, CSRF-checked, 20 a minute per member)
 *
 * { source: 'draft' | 'published' | <versionId>, contact_id?, inputs: [{ option_id?, text? }] (≤50),
 *   api_ports?: { <node_key>: 'route:<i>' | 'fallback' } }
 *
 * Walks the flow for an optional sample contact and returns what would
 * happen: { trace, waiting, ended, applied, rejected_input, notes, issues,
 * version, contact }. Nothing is sent, saved, queued or fetched (see
 * src/lib/flows/dry-run.ts); one audit row records that it ran, with no content.
 */
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  try {
    const caller = await requireFlowMutation(request);
    const limit = checkRateLimit(`flows-dry-run:${caller.userId}`, { limit: 20, windowMs: 60_000 });
    if (!limit.success) return rateLimitResponse(limit);
    if (!FLOW_ID.test(id)) return NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    const body = parseDryRunRequest(await request.json().catch(() => null));
    if (!body) return NextResponse.json({ error: t('common.invalidRequestBody') }, { status: 400 });

    const result = await runDryRun(tenantOf(caller), id, body);

    // After the dry run, in a normal transaction: who ran it, on what, how far. Never content.
    const source = typeof body.source === 'string' ? body.source : 'version';
    await withTenant(tenantOf(caller), (tx) => tx.$executeRaw(Prisma.sql`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
      VALUES(${caller.accountId}::uuid,${caller.userId}::uuid,'flows.dry_run',${id},
        ${JSON.stringify({ flow_id: id, source, version: result.version, steps: result.trace.length, with_contact: !!body.contactId })}::jsonb)`));

    return NextResponse.json(result, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    if (err instanceof DryRunError) {
      return err.code === 'not_published'
        ? NextResponse.json({ error: t('flows.dryRunNotPublished') }, { status: 409 })
        : NextResponse.json({ error: t('common.notFound') }, { status: 404 });
    }
    return flowVersionErrorResponse(err);
  }
}
