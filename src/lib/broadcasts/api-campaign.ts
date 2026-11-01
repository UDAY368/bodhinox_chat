// ============================================================
// API campaigns: a named campaign with a template, created in the
// dashboard, that the public API adds recipients to over time
// (POST /api/v1/broadcasts/{id}/recipients). Each batch is committed
// with its dispatch job, and all batches report as one campaign.
// ============================================================

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import type { DataClient } from '@/lib/data/types';
import { assertMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { BroadcastError, resolveApiRecipients, type BroadcastRecipientInput } from '@/lib/whatsapp/broadcast-core';
import { trackedButtonIndex } from './tracking';

export const MAX_API_BATCH = 1000;
const createSchema = z.object({ name: z.string().trim().min(1).max(200), templateId: z.string().uuid() }).strict();

/** Create an empty API campaign for an approved template (agent+). */
export async function createApiCampaign(scope: TenantContext, raw: unknown): Promise<{ id: string }> {
  if (!scope.userId || !scope.role || !hasMinRole(scope.role, 'agent')) throw new ForbiddenError('Campaign creation requires an agent role');
  const parsed = createSchema.safeParse(raw);
  if (!parsed.success) throw new AuthError('Enter a name and choose a template', 400, 'campaign_input');
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<unknown[]>`SELECT * FROM message_templates WHERE account_id=${scope.accountId}::uuid AND id=${parsed.data.templateId}::uuid`;
    if (!rows[0]) throw new AuthError('Template unavailable', 404, 'not_found');
    const template = assertMessageTemplate(rows[0], 'API campaign');
    if (template.status !== 'APPROVED') throw new AuthError('Choose an approved template', 400, 'campaign_input');
    if (trackedButtonIndex(template) >= 0) throw new AuthError('Click-tracked templates cannot be used for API campaigns', 400, 'campaign_input');
    // The API supplies body values only: a header or link button that needs its own value could never send.
    const bodyCount = extractVariableIndices(template.body_text).length;
    try {
      buildSendComponents(template, { body: Array.from({ length: bodyCount }, () => 'x') });
    } catch {
      throw new AuthError('This template needs header media or link-button values the API cannot supply; choose another template', 400, 'campaign_input');
    }
    // 'sent' with no recipients: it settles back to 'sent' after every batch.
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,status,total_recipients,kind)
      VALUES(${scope.accountId}::uuid,${scope.userId}::uuid,${parsed.data.name},${template.name},${template.language || 'en_US'},'sent',0,'api')
      RETURNING id::text`;
    return { id: row.id };
  });
}

/**
 * Add one batch of recipients to an API campaign and queue its dispatch.
 * Invalid numbers, opted-out/blocked contacts and recipients missing a
 * template value are rejected. A contact already in the campaign (a
 * retried or overlapping batch) is counted as a duplicate and not sent again.
 */
export async function addApiCampaignRecipients(
  db: DataClient,
  accountId: string,
  auditUserId: string,
  broadcastId: string,
  recipients: BroadcastRecipientInput[],
): Promise<{ accepted: number; rejected: number; duplicates: number }> {
  if (!Array.isArray(recipients) || recipients.length === 0)
    throw new BroadcastError('bad_request', "'recipients' must be a non-empty array of { to, params? }", 400);
  if (recipients.length > MAX_API_BATCH)
    throw new BroadcastError('bad_request', `At most ${MAX_API_BATCH} recipients per request; send larger lists in batches`, 400);
  const { data: campaign, error } = await db.from('broadcasts')
    .select('id,kind,template_name,template_language').eq('id', broadcastId).eq('account_id', accountId).maybeSingle();
  if (error || !campaign) throw new BroadcastError('not_found', 'Campaign not found', 404);
  if (campaign.kind !== 'api') throw new BroadcastError('conflict', 'Recipients can only be added to an API campaign', 409);
  const { data: config } = await db.from('whatsapp_config').select('id').eq('account_id', accountId).maybeSingle();
  if (!config) throw new BroadcastError('whatsapp_not_configured', 'WhatsApp not configured. Please set up your WhatsApp integration first.', 400);

  // Every recipient needs a non-empty value for each body variable, or Meta would refuse the send.
  const template = await resolveTemplateRow(db, accountId, campaign.template_name, campaign.template_language);
  const needed = extractVariableIndices(template.row?.body_text ?? '').length;
  const resolved = await resolveApiRecipients(db, accountId, auditUserId, recipients);
  const complete = resolved.deduped.filter((r) => r.params.length >= needed && r.params.slice(0, needed).every((p) => p.trim() !== ''));
  const rejected = resolved.rejected + resolved.deduped.length - complete.length;

  let inserted = 0;
  try {
    inserted = await withTenant({ accountId, role: 'owner' }, async (tx) => {
      // Batches of one campaign run one at a time, so the existence check below cannot race.
      await tx.$queryRaw`SELECT id FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid FOR UPDATE`;
      const count = await tx.$executeRaw`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params)
        SELECT ${accountId}::uuid,${broadcastId}::uuid,x.contact_id,'pending',x.params
        FROM jsonb_to_recordset(${JSON.stringify(complete.map((r) => ({ contact_id: r.contactId, params: r.params })))}::jsonb) AS x(contact_id uuid,params jsonb)
        WHERE NOT EXISTS(SELECT 1 FROM broadcast_recipients r
          WHERE r.account_id=${accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid AND r.contact_id=x.contact_id)`;
      if (!count) return 0;
      await tx.$executeRaw`UPDATE broadcasts SET total_recipients=COALESCE(total_recipients,0)+${count}
        WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`;
      // Each batch has its own job; the per-campaign delivery lock keeps passes one at a time.
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES('broadcast.dispatch',${accountId}::uuid,${JSON.stringify({ broadcastId, scope: 'pending' })}::jsonb,${`broadcast:${broadcastId}:api:${randomUUID()}`})`;
      return count;
    }, getWorkerPrisma());
  } catch {
    console.error('[api-campaign] batch persistence failed');
    throw new BroadcastError('internal', 'Failed to add recipients', 500);
  }
  return { accepted: inserted, rejected, duplicates: complete.length - inserted };
}
