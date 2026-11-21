// ============================================================
// Campaign drafts that keep every field (batch 7). Saving from any wizard
// step writes the draft's broadcasts row (status 'draft', what the list
// shows) and its full state in broadcast_drafts: CSV rows, header media,
// tracked link, extras, schedule, send-from number, skip-recent and quiet
// hours. Server-side only: CSV rows never sit in the browser's storage and
// never reach realtime events (broadcast_drafts has no outbox trigger).
// Nothing sends from a draft; creating the campaign validates everything again.
// Runs on the app role, so RLS decides who may write (agent and above).
// ============================================================

import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { CAMPAIGN_SEND_EXTRAS_KEY } from '@/lib/whatsapp/template-send-params';
import { audienceBaseSchema, sendWindowSchema, variableMapping, CAMPAIGN_LIMITS } from './create-campaign';

const draftAudience = audienceBaseSchema.extend({
  /** The CSV file's name, shown again when the draft reopens. */
  csvFileName: z.string().trim().max(255).optional(),
});

export const draftSchema = z.object({
  name: z.string().trim().min(1).max(200),
  channel: z.enum(['whatsapp', 'instagram']),
  text: z.string().max(1000).optional(),
  templateId: z.string().uuid().nullish(),
  variables: z.record(z.string().max(16), variableMapping).refine((v) => Object.keys(v).length <= CAMPAIGN_LIMITS.variables, 'Too many variables').optional(),
  headerMediaUrl: z.string().trim().max(2048).optional(),
  trackedUrl: z.string().trim().max(2048).optional(),
  /** Location, offer end, coupon and card values; checked when the campaign is created. */
  sendExtras: z.record(z.string().max(64), z.unknown()).optional(),
  /** The wizard's schedule (ISO); checked when the campaign is created. */
  scheduledAt: z.string().max(64).optional(),
  whatsappConfigId: z.string().uuid().nullish(),
  sendWindow: sendWindowSchema.nullish(),
  audience: draftAudience,
}).strict();
export type CampaignDraft = z.infer<typeof draftSchema>;

/** The draft row's fields shown in lists; CSV rows travel separately. */
function stateOf(draft: CampaignDraft) {
  const { csvContacts: _rows, ...audience } = draft.audience;
  void _rows;
  return {
    templateId: draft.templateId ?? null,
    headerMediaUrl: draft.headerMediaUrl ?? '',
    trackedUrl: draft.trackedUrl ?? '',
    sendExtras: draft.sendExtras ?? {},
    scheduledAt: draft.scheduledAt ?? '',
    whatsappConfigId: draft.whatsappConfigId ?? null,
    sendWindow: draft.sendWindow ?? null,
    audience,
  };
}

function invalid(message: string): never {
  throw new AuthError(message, 400, 'campaign_input');
}

/**
 * Create a draft (no id) or replace one (its id). Returns the draft's id.
 * Only a row still in 'draft' can be replaced; another workspace's id is 404.
 */
export async function saveCampaignDraft(scope: TenantContext, raw: unknown, draftId?: string): Promise<{ id: string }> {
  if (!scope.userId || !scope.role || !hasMinRole(scope.role, 'agent')) throw new ForbiddenError('Saving a campaign draft requires an agent role');
  const parsed = draftSchema.safeParse(raw);
  if (!parsed.success) invalid(parsed.error.issues[0]?.message ?? 'Invalid campaign draft');
  const draft = parsed.data;
  if (draft.channel === 'instagram' && draft.audience.type === 'csv') invalid('Instagram campaigns cannot use a CSV audience');
  if (JSON.stringify(stateOf(draft)).length > 60_000) invalid('This draft is too large to save');
  return withTenant(scope, async (tx) => {
    let template = { name: '', language: 'en_US' };
    if (draft.channel === 'whatsapp' && draft.templateId) {
      const rows = await tx.$queryRaw<{ name: string; language: string | null }[]>`
        SELECT name, language FROM message_templates WHERE account_id=${scope.accountId}::uuid AND id=${draft.templateId}::uuid`;
      if (!rows[0]) invalid('Template unavailable');
      template = { name: rows[0].name, language: rows[0].language || 'en_US' };
    }
    const { csvContacts: _csv, csvFileName: _file, ...audienceFilter } = draft.audience;
    void _csv; void _file;
    const variables = draft.channel === 'instagram' ? {} : draft.variables ?? {};
    const text = draft.channel === 'instagram' ? (draft.text ?? '').slice(0, 1000) : null;
    let id: string;
    if (draftId) {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        UPDATE broadcasts SET name=${draft.name}, template_name=${template.name}, template_language=${template.language},
          template_variables=${JSON.stringify(variables)}::jsonb, audience_filter=${JSON.stringify(audienceFilter)}::jsonb,
          channel=${draft.channel}, message_text=${text}, updated_at=now()
        WHERE account_id=${scope.accountId}::uuid AND id=${draftId}::uuid AND status='draft' RETURNING id::text`;
      if (!rows[0]) throw new AuthError('Draft unavailable', 404, 'not_found');
      id = rows[0].id;
    } else {
      const rows = await tx.$queryRaw<{ id: string }[]>`
        INSERT INTO broadcasts(account_id,user_id,name,template_name,template_language,template_variables,audience_filter,status,channel,message_text)
        VALUES(${scope.accountId}::uuid,${scope.userId}::uuid,${draft.name},${template.name},${template.language},
          ${JSON.stringify(variables)}::jsonb,${JSON.stringify(audienceFilter)}::jsonb,'draft',${draft.channel},${text})
        RETURNING id::text`;
      id = rows[0].id;
    }
    const csvRows = draft.audience.type === 'csv' && draft.audience.csvContacts?.length ? JSON.stringify(draft.audience.csvContacts) : null;
    const state = { ...stateOf(draft), audience: { ...stateOf(draft).audience, ...(draft.audience.csvFileName ? { csvFileName: draft.audience.csvFileName } : {}) } };
    await tx.$executeRaw`
      INSERT INTO broadcast_drafts(account_id,broadcast_id,state,csv_rows,updated_by)
      VALUES(${scope.accountId}::uuid,${id}::uuid,${JSON.stringify(state)}::jsonb,${csvRows}::jsonb,${scope.userId}::uuid)
      ON CONFLICT (account_id,broadcast_id) DO UPDATE SET state=EXCLUDED.state, csv_rows=EXCLUDED.csv_rows, updated_by=EXCLUDED.updated_by`;
    return { id };
  });
}

/** Everything a saved draft holds, for the wizard to reopen it; null when it is not a draft of this workspace. */
export async function loadCampaignDraft(scope: TenantContext, draftId: string): Promise<CampaignDraft | null> {
  return withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<{
      name: string; channel: string; message_text: string | null; template_variables: unknown; audience_filter: unknown;
      state: Record<string, unknown> | null; csv_rows: unknown; named_template_id: string | null;
    }[]>`
      SELECT b.name, b.channel, b.message_text, b.template_variables, b.audience_filter, d.state, d.csv_rows,
        -- A draft saved before broadcast_drafts existed names its template only; find the approved one.
        (SELECT t.id::text FROM message_templates t WHERE t.account_id=b.account_id AND b.template_name<>''
          AND t.name=b.template_name AND COALESCE(t.language,'en_US')=COALESCE(b.template_language,'en_US') AND t.status='APPROVED'
          ORDER BY t.created_at DESC LIMIT 1) AS named_template_id
      FROM broadcasts b LEFT JOIN broadcast_drafts d ON d.account_id=b.account_id AND d.broadcast_id=b.id
      WHERE b.account_id=${scope.accountId}::uuid AND b.id=${draftId}::uuid AND b.status='draft'`;
    const row = rows[0];
    if (!row) return null;
    const state = row.state ?? {};
    const audience = { ...((state.audience as object | undefined) ?? (row.audience_filter as object | null) ?? { type: 'all' }) } as Record<string, unknown>;
    if (audience.type === 'csv' && Array.isArray(row.csv_rows)) audience.csvContacts = row.csv_rows;
    const draft = {
      name: row.name,
      channel: row.channel === 'instagram' ? 'instagram' : 'whatsapp',
      ...(row.channel === 'instagram' ? { text: row.message_text ?? '' } : {}),
      templateId: (state.templateId as string | null | undefined) ?? (row.channel === 'instagram' ? null : row.named_template_id),
      variables: Object.fromEntries(Object.entries((row.template_variables as Record<string, unknown> | null) ?? {}).filter(([key]) => key !== CAMPAIGN_SEND_EXTRAS_KEY)),
      headerMediaUrl: (state.headerMediaUrl as string | undefined) ?? '',
      trackedUrl: (state.trackedUrl as string | undefined) ?? '',
      sendExtras: (state.sendExtras as Record<string, unknown> | undefined) ?? {},
      scheduledAt: (state.scheduledAt as string | undefined) ?? '',
      whatsappConfigId: (state.whatsappConfigId as string | null | undefined) ?? null,
      sendWindow: (state.sendWindow as { start: number; end: number } | null | undefined) ?? null,
      audience,
    };
    // Rows saved before this module (or edited since) are read leniently: unknown fields are dropped, not fatal.
    const parsed = draftSchema.safeParse(draft);
    if (parsed.success) return parsed.data;
    const loose = { ...draft, variables: {}, sendExtras: {}, audience: { type: 'all' } };
    const fallback = draftSchema.safeParse(loose);
    return fallback.success ? fallback.data : null;
  });
}

/**
 * Remove a draft (its broadcast_drafts row goes with it, ON DELETE CASCADE). Used once the
 * wizard created the campaign it was finishing. Only a row still in 'draft' is removed;
 * false when there is none in this workspace.
 */
export async function deleteCampaignDraft(scope: TenantContext, draftId: string): Promise<boolean> {
  if (!scope.userId || !scope.role || !hasMinRole(scope.role, 'agent')) throw new ForbiddenError('Removing a campaign draft requires an agent role');
  return withTenant(scope, async (tx) => {
    const removed = await tx.$executeRaw`
      DELETE FROM broadcasts WHERE account_id=${scope.accountId}::uuid AND id=${draftId}::uuid AND status='draft'`;
    return removed > 0;
  });
}
