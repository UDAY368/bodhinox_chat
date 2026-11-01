// ============================================================
// Campaign test send: the chosen template, with the campaign's
// variable mappings, to up to 3 numbers before launch. A number that
// belongs to a contact uses that contact's values; otherwise (and for
// CSV columns) the variable shows as "[name]" so gaps are visible.
// Nothing is recorded against a campaign, and opted-out or blocked
// numbers are refused like any other marketing send.
// ============================================================

import { z } from 'zod';
import { AuthError } from '@/lib/auth/errors';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { databaseAdmin } from '@/lib/flows/admin-client';
import { loadAccountMetaCredentials } from '@/lib/flows/meta-send';
import { providerMediaUrl } from '@/lib/storage/server';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import { parseInternationalPhone } from '@/lib/whatsapp/phone-utils';
import { assertMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { extractVariableIndices } from '@/lib/whatsapp/template-validators';
import { marketingSuppression } from '@/lib/contacts/consent';
import { assertMedia, variableMapping } from './create-campaign';

export const MAX_TEST_NUMBERS = 3;
const inputSchema = z.object({
  templateId: z.string().uuid(),
  phones: z.array(z.string().trim().min(1).max(64)).min(1).max(MAX_TEST_NUMBERS),
  variables: z.record(z.string().regex(/^[1-9]\d?$/), variableMapping),
  headerMediaUrl: z.string().trim().min(1).max(2048).optional(),
}).strict();

export interface TestSendResult { phone: string; ok: boolean; error?: string }
type ContactRow = { id: string; name: string | null; phone: string; email: string | null; company: string | null; opted_out_at: string | null; blocked_at: string | null };

type Target = { phone: string; error: string } | { phone: string; to: string; params: string[] };

function invalid(message: string): never { throw new AuthError(message, 400, 'campaign_input'); }

/** Resolve the body values for one test number (exported for tests). */
export function testParams(
  keys: string[],
  variables: z.infer<typeof inputSchema>['variables'],
  contact: ContactRow | null,
  custom: Map<string, string>,
): string[] {
  return keys.map((key) => {
    const v = variables[key];
    if (v.type === 'static') return v.value;
    if (v.type === 'field') return contact?.[v.value] || `[${v.value}]`;
    if (v.type === 'custom_field') return custom.get(v.value) || `[${key}]`;
    return `[${v.value}]`;
  });
}

export async function sendCampaignTest(scope: TenantContext, raw: unknown): Promise<TestSendResult[]> {
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) invalid('Choose a template and up to 3 numbers in international format');
  const input = parsed.data;
  const accountId = scope.accountId;

  const prepared = await withTenant(scope, async (tx) => {
    const rows = await tx.$queryRaw<unknown[]>`SELECT * FROM message_templates WHERE account_id=${accountId}::uuid AND id=${input.templateId}::uuid`;
    if (!rows[0]) throw new AuthError('Template unavailable', 404, 'not_found');
    const template = assertMessageTemplate(rows[0], 'campaign test');
    if (template.status !== 'APPROVED') invalid('Choose an approved template');
    const keys = Object.keys(input.variables).sort((a, b) => Number(a) - Number(b));
    const expected = extractVariableIndices(template.body_text).map(String);
    if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) invalid('Map every template variable before sending a test');
    const headerMediaUrl = input.headerMediaUrl ?? (template.header_media_url?.trim() || undefined);
    await assertMedia(tx, accountId, headerMediaUrl);
    const fieldIds = keys.flatMap((key) => (input.variables[key].type === 'custom_field' ? [input.variables[key].value] : []));

    const targets: Target[] = [];
    for (const raw of input.phones) {
      const digits = parseInternationalPhone(raw);
      if (!digits) { targets.push({ phone: raw, error: 'Use international format with + and country code' }); continue; }
      const [contact] = await tx.$queryRaw<ContactRow[]>`SELECT id::text, name, phone, email, company, opted_out_at, blocked_at
        FROM contacts WHERE account_id=${accountId}::uuid AND phone_normalized=${digits} LIMIT 1`;
      if (contact && marketingSuppression(contact)) { targets.push({ phone: raw, error: 'This number has opted out or is blocked' }); continue; }
      const values = contact && fieldIds.length
        ? await tx.$queryRaw<{ custom_field_id: string; value: string | null }[]>`SELECT custom_field_id::text, value FROM contact_custom_values
            WHERE account_id=${accountId}::uuid AND contact_id=${contact.id}::uuid AND custom_field_id = ANY(${fieldIds}::uuid[])`
        : [];
      const custom = new Map(values.map((row) => [row.custom_field_id, row.value ?? '']));
      targets.push({ phone: raw, to: digits, params: testParams(keys, input.variables, contact ?? null, custom) });
    }
    return { template, headerMediaUrl, targets };
  });

  const sendable = prepared.targets.some((t) => 'to' in t);
  // A setup problem is reported on each number rather than as a server error.
  let credentials: { phoneNumberId: string; accessToken: string } | null = null;
  let media: string | undefined;
  let setupError = '';
  if (sendable) {
    try { credentials = await loadAccountMetaCredentials(databaseAdmin({ accountId, role: 'owner' }), accountId); }
    catch { setupError = 'WhatsApp is not connected for this workspace'; }
    if (credentials && prepared.headerMediaUrl) {
      try { media = await providerMediaUrl(accountId, prepared.headerMediaUrl); }
      catch { credentials = null; setupError = 'The header media is unavailable'; }
    }
  }

  const results: TestSendResult[] = [];
  for (const target of prepared.targets) {
    if (!('to' in target) || !credentials) { results.push({ phone: target.phone, ok: false, error: 'error' in target ? target.error : setupError }); continue; }
    try {
      // A deliberate one-off by the agent, like an inbox send: not queued, not retried.
      await sendTemplateMessage({
        phoneNumberId: credentials.phoneNumberId,
        accessToken: credentials.accessToken,
        to: target.to,
        templateName: prepared.template.name,
        language: prepared.template.language || 'en_US',
        template: prepared.template,
        params: target.params,
        ...(media ? { messageParams: { headerMediaUrl: media } } : {}),
      });
      results.push({ phone: target.phone, ok: true });
    } catch (error) {
      results.push({ phone: target.phone, ok: false, error: error instanceof Error ? error.message : 'Send failed' });
    }
  }
  return results;
}
