import { z } from 'zod';
import type { TenantTransaction } from '@/lib/db/tenant';
import { COMMERCE_EVENTS, isVariableMap, type CommerceEventName } from '@/lib/commerce/event-rules';
import { SHOPIFY_TEMPLATE_FIELDS } from './webhooks';

/**
 * Shopify event rules for the settings card: one rule per event (enabled,
 * template, number, delay, variable map). App-role tenant transactions only;
 * RLS lets members read and admins write.
 */

export interface ShopifyRuleDto {
  event: CommerceEventName;
  enabled: boolean;
  template_name: string;
  template_language: string | null;
  whatsapp_config_id: string | null;
  delay_minutes: number;
  variable_map: Record<string, string>;
}

export interface RuleTemplateDto {
  name: string;
  language: string | null;
  category: string;
  waba_id: string | null;
  variable_count: number;
}

const FIELDS = new Set<string>(SHOPIFY_TEMPLATE_FIELDS);

export const RuleBody = z.object({
  event: z.enum(COMMERCE_EVENTS),
  enabled: z.boolean(),
  template_name: z.string().trim().min(1).max(512),
  template_language: z.string().trim().max(15).nullable().optional(),
  whatsapp_config_id: z.string().uuid().nullable().optional(),
  delay_minutes: z.number().int().min(0).max(10080),
  variable_map: z.record(z.string(), z.string()).refine((m) => isVariableMap(m) && Object.values(m).every((f) => FIELDS.has(f))),
});
export type RuleInput = z.infer<typeof RuleBody>;

export class ShopifyRuleError extends Error {
  constructor(public readonly reason: 'template_not_found' | 'template_not_on_number' | 'number_not_found') {
    super(reason);
    this.name = 'ShopifyRuleError';
  }
}

export async function listShopifyRules(tx: TenantTransaction, accountId: string): Promise<ShopifyRuleDto[]> {
  const rows = await tx.$queryRaw<(Omit<ShopifyRuleDto, 'variable_map'> & { variable_map: unknown })[]>`
    SELECT event,enabled,template_name,template_language,whatsapp_config_id,delay_minutes,variable_map
    FROM commerce_event_rules WHERE account_id=${accountId}::uuid AND source='shopify'`;
  return rows.map((r) => ({ ...r, variable_map: isVariableMap(r.variable_map) ? r.variable_map : {} }));
}

/** Approved templates a rule can send, with how many body variables each has. */
export async function listRuleTemplates(tx: TenantTransaction, accountId: string): Promise<RuleTemplateDto[]> {
  const rows = await tx.$queryRaw<{ name: string; language: string | null; category: string; waba_id: string | null; body_text: string }[]>`
    SELECT name,language,category,waba_id,body_text FROM message_templates
    WHERE account_id=${accountId}::uuid AND upper(status)='APPROVED' AND template_kind='standard'
    ORDER BY name, language LIMIT 500`;
  return rows.map(({ body_text, ...r }) => {
    const indexes = [...(body_text ?? '').matchAll(/\{\{\s*(\d{1,2})\s*\}\}/g)].map((m) => Number(m[1]));
    return { ...r, variable_count: indexes.length ? Math.max(...indexes) : 0 };
  });
}

/** Creates or replaces the rule for one event. Admin only (RLS). */
export async function saveShopifyRule(tx: TenantTransaction, accountId: string, input: RuleInput): Promise<ShopifyRuleDto> {
  const language = input.template_language || null;
  const configId = input.whatsapp_config_id || null;
  const templates = await tx.$queryRaw<{ waba_id: string | null }[]>`
    SELECT waba_id FROM message_templates
    WHERE account_id=${accountId}::uuid AND name=${input.template_name} AND upper(status)='APPROVED'
      AND (${language}::text IS NULL OR lower(language)=lower(${language}::text))`;
  if (!templates.length) throw new ShopifyRuleError('template_not_found');
  if (configId) {
    const [number] = await tx.$queryRaw<{ waba_id: string | null }[]>`
      SELECT waba_id FROM whatsapp_config WHERE account_id=${accountId}::uuid AND id=${configId}::uuid`;
    if (!number) throw new ShopifyRuleError('number_not_found');
    if (number.waba_id && !templates.some((t) => !t.waba_id || t.waba_id === number.waba_id))
      throw new ShopifyRuleError('template_not_on_number');
  }
  const map = JSON.stringify(input.variable_map);
  await tx.$executeRaw`
    INSERT INTO commerce_event_rules(account_id,source,event,enabled,template_name,template_language,whatsapp_config_id,delay_minutes,variable_map)
    VALUES(${accountId}::uuid,'shopify',${input.event},${input.enabled},${input.template_name},${language},${configId}::uuid,${input.delay_minutes},${map}::jsonb)
    ON CONFLICT(account_id,source,event) DO UPDATE SET enabled=EXCLUDED.enabled, template_name=EXCLUDED.template_name,
      template_language=EXCLUDED.template_language, whatsapp_config_id=EXCLUDED.whatsapp_config_id,
      delay_minutes=EXCLUDED.delay_minutes, variable_map=EXCLUDED.variable_map`;
  const rules = await listShopifyRules(tx, accountId);
  const saved = rules.find((r) => r.event === input.event);
  if (!saved) throw new Error('Rule was not saved');
  return saved;
}
