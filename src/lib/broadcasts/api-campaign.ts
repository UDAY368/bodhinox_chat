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
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import type { DataClient } from '@/lib/data/types';
import { assertMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { buildSendComponents } from '@/lib/whatsapp/template-send-builder';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { templateSendRefusal } from '@/lib/whatsapp/template-send-params';
import { BroadcastError, broadcastNumberError, resolveApiRecipients, type BroadcastRecipientInput } from '@/lib/whatsapp/broadcast-core';
import { NoNumberError } from '@/lib/whatsapp/numbers';
import {
  assertTemplateOnNumber,
  loadSenderConfig,
  numberErrorText,
  pickDefaultNumber,
  TemplateNumberMismatchError,
} from '@/lib/whatsapp/sender-config';
import { trackedButtonIndex } from './tracking';
import { PlanLimitError, requireFeature, requireWithinLimit } from '@/lib/billing/entitlements';

export const MAX_API_BATCH = 1000;
const createSchema = z.object({
  name: z.string().trim().min(1).max(200),
  templateId: z.string().uuid(),
  /** The number to send from; the workspace default when omitted. */
  whatsappConfigId: z.string().uuid().nullish(),
}).strict();

/**
 * The number a new campaign sends from, inside its tenant transaction: the one
 * asked for (it must be this workspace's), else the default. Null when the
 * workspace has no number yet, which creation has always allowed. Refuses a
 * template synced from another WABA than the number's.
 */
export async function campaignNumberId(
  tx: TenantTransaction,
  accountId: string,
  requested: string | null | undefined,
  template: { waba_id?: string | null },
): Promise<string | null> {
  // `removed` is computed in SQL, so the token itself is never read.
  const numbers = await tx.$queryRaw<{ id: string; waba_id: string | null; is_default: boolean; created_at: Date | null; removed: boolean }[]>`
    SELECT id::text AS id,waba_id,is_default,created_at,(status='disconnected' AND access_token='') AS removed
    FROM whatsapp_config WHERE account_id=${accountId}::uuid`;
  let config: { id: string; waba_id: string | null; removed?: boolean } | null;
  try {
    if (requested) {
      config = numbers.find((row) => row.id === requested.toLowerCase()) ?? null;
      if (!config) throw new NoNumberError('not_found');
      if (config.removed) throw new NoNumberError('disconnected');
    } else {
      // No connected number yet (none, or all disconnected): creation has always allowed this.
      if (!numbers.some((row) => !row.removed)) return null;
      config = pickDefaultNumber(numbers);
      if (!config) throw new NoNumberError('no_default');
    }
    assertTemplateOnNumber(template, config);
  } catch (error) {
    if (error instanceof NoNumberError && error.reason === 'disconnected')
      throw new AuthError(numberErrorText(error), 409, 'whatsapp_number_disconnected');
    if (error instanceof NoNumberError) throw new AuthError(numberErrorText(error), 400, 'whatsapp_number_unavailable');
    if (error instanceof TemplateNumberMismatchError) throw new AuthError(numberErrorText(error), 422, error.code);
    throw error;
  }
  return config.id;
}

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
    const refusal = templateSendRefusal(template, 'campaign');
    if (refusal) throw new AuthError(refusal, 400, 'template_kind_not_allowed');
    await requireFeature(tx, scope.accountId, 'api_campaigns');
    if (trackedButtonIndex(template) >= 0) throw new AuthError('Click-tracked templates cannot be used for API campaigns', 400, 'campaign_input');
    const numberId = await campaignNumberId(tx, scope.accountId, parsed.data.whatsappConfigId, template as { waba_id?: string | null });
    // The API supplies body values only: a header or link button that needs its own value could never send.
    const bodyCount = extractVariableIndices(template.body_text).length;
    try {
      buildSendComponents(template, { body: Array.from({ length: bodyCount }, () => 'x') });
    } catch {
      throw new AuthError('This template needs header media or link-button values the API cannot supply; choose another template', 400, 'campaign_input');
    }
    // 'sent' with no recipients: it settles back to 'sent' after every batch.
    const [row] = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,status,total_recipients,kind,whatsapp_config_id)
      VALUES(${scope.accountId}::uuid,${scope.userId}::uuid,${parsed.data.name},${template.name},${template.language || 'en_US'},'sent',0,'api',${numberId}::uuid)
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
    .select('id,kind,status,template_name,template_language,whatsapp_config_id').eq('id', broadcastId).eq('account_id', accountId).maybeSingle();
  if (error || !campaign) throw new BroadcastError('not_found', 'Campaign not found', 404);
  if (campaign.kind !== 'api') throw new BroadcastError('conflict', 'Recipients can only be added to an API campaign', 409);
  // Cancelled (for example when its number was disconnected): never fall back to another number.
  if (campaign.status === 'cancelled') throw new BroadcastError('conflict', 'This campaign was cancelled', 409);
  // The campaign's number (the default when it has none) must still be connected:
  // checked before any contact is resolved or recipient stored, so a batch for a
  // disconnected number is refused (409 whatsapp_number_disconnected) with nothing kept.
  const config = await loadSenderConfig(db, accountId, campaign.whatsapp_config_id ?? null).catch((error: unknown) => {
    throw broadcastNumberError(error);
  });

  // Every recipient needs a non-empty value for each body variable, or Meta would refuse the send.
  const template = await resolveTemplateRow(db, accountId, campaign.template_name, campaign.template_language);
  try {
    assertTemplateOnNumber(template.row, config);
  } catch (error) {
    throw broadcastNumberError(error);
  }
  const needed = extractVariableIndices(template.row?.body_text ?? '').length;
  const resolved = await resolveApiRecipients(db, accountId, auditUserId, recipients);
  const complete = resolved.deduped.filter((r) => r.params.length >= needed && r.params.slice(0, needed).every((p) => p.trim() !== ''));
  const rejected = resolved.rejected + resolved.deduped.length - complete.length;

  let inserted = 0;
  try {
    inserted = await withTenant({ accountId, role: 'owner' }, async (tx) => {
      // Batches of one campaign run one at a time, so the existence check below cannot race.
      const [locked] = await tx.$queryRaw<{ total: number | null }[]>`SELECT total_recipients AS total FROM broadcasts WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid FOR UPDATE`;
      // A downgraded workspace keeps its campaign but cannot add to it beyond the plan.
      await requireFeature(tx, accountId, 'api_campaigns');
      const count = await tx.$executeRaw`INSERT INTO broadcast_recipients(account_id,broadcast_id,contact_id,status,template_params)
        SELECT ${accountId}::uuid,${broadcastId}::uuid,x.contact_id,'pending',x.params
        FROM jsonb_to_recordset(${JSON.stringify(complete.map((r) => ({ contact_id: r.contactId, params: r.params })))}::jsonb) AS x(contact_id uuid,params jsonb)
        WHERE NOT EXISTS(SELECT 1 FROM broadcast_recipients r
          WHERE r.account_id=${accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid AND r.contact_id=x.contact_id)`;
      if (!count) return 0;
      // Only contacts new to the campaign count; going over rolls this batch back.
      await requireWithinLimit(tx, accountId, 'campaign_recipients', (locked?.total ?? 0) + count);
      await tx.$executeRaw`UPDATE broadcasts SET total_recipients=COALESCE(total_recipients,0)+${count}
        WHERE account_id=${accountId}::uuid AND id=${broadcastId}::uuid`;
      // Each batch has its own job; the per-campaign delivery lock keeps passes one at a time.
      await tx.$executeRaw`INSERT INTO jobs(type,tenant_id,payload,dedupe_key)
        VALUES('broadcast.dispatch',${accountId}::uuid,${JSON.stringify({ broadcastId, scope: 'pending' })}::jsonb,${`broadcast:${broadcastId}:api:${randomUUID()}`})`;
      return count;
    }, getWorkerPrisma());
  } catch (error) {
    if (error instanceof PlanLimitError) throw new BroadcastError('plan_limit', error.message, 402);
    console.error('[api-campaign] batch persistence failed');
    throw new BroadcastError('internal', 'Failed to add recipients', 500);
  }
  return { accepted: inserted, rejected, duplicates: complete.length - inserted };
}
