// The approved WhatsApp template a sequence step sends when the 24-hour
// window is closed (batch 7). Checked when the step is saved (store.ts) and
// again when it falls due (worker.ts), with the same rule as automation
// send_template steps (automationTemplateRefusal): the step fills body values
// only, so a template needing another send-time value is refused.
import { Prisma } from '@prisma/client';
import { automationTemplateRefusal } from '@/lib/automations/template-check';
import type { TenantTransaction } from '@/lib/db/tenant';
import type { MessageTemplate } from '@/types';

export type StepTemplateRow = Pick<MessageTemplate,
  'name' | 'body_text' | 'header_type' | 'header_content' | 'header_media_url' | 'buttons' | 'template_kind' | 'cards' | 'lto'> & {
  language: string | null; status: string | null; waba_id: string | null;
};

/** The workspace's template by name (and language when given), an approved one first; null when there is none. */
export async function loadStepTemplate(tx: TenantTransaction, accountId: string, name: string, language: string | null):
  Promise<StepTemplateRow | null> {
  const rows = await tx.$queryRaw<StepTemplateRow[]>(Prisma.sql`
    SELECT name, language, status, body_text, header_type, header_content, header_media_url, buttons, template_kind, cards, lto,
      waba_id
    FROM message_templates WHERE account_id = ${accountId}::uuid AND name = ${name}
      AND (${language}::text IS NULL OR lower(language) = lower(${language}::text))
    ORDER BY (upper(coalesce(status,'')) = 'APPROVED') DESC, language LIMIT 1`);
  return rows[0] ?? null;
}

/** Why a sequence step cannot send this template (not approved, or it needs more than body values), or null. */
export function stepTemplateRefusal(template: StepTemplateRow | null): 'template_not_found' | 'template_not_approved' | 'template_refused' | null {
  if (!template) return 'template_not_found';
  if (String(template.status ?? '').toUpperCase() !== 'APPROVED') return 'template_not_approved';
  return automationTemplateRefusal(template) ? 'template_refused' : null;
}
