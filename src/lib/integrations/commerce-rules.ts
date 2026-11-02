import { Prisma } from '@prisma/client';

import { COMMERCE_EVENTS, COMMERCE_SOURCES, isVariableMap, type CommerceEventName, type CommerceSource } from '@/lib/commerce/event-rules';
import type { TenantTransaction } from '@/lib/db/tenant';

/**
 * Store event → WhatsApp template rules (table commerce_event_rules), shared by
 * every store integration's settings (WooCommerce, Shopify). `tx` is an
 * app-role tenant transaction; RLS lets members read and only admins write.
 */

export interface CommerceRulePublic {
  id: string;
  source: CommerceSource;
  event: CommerceEventName;
  enabled: boolean;
  template_name: string;
  template_language: string | null;
  whatsapp_config_id: string | null;
  delay_minutes: number;
  variable_map: Record<string, string>;
  updated_at: string;
}

export type CommerceRuleErrorCode =
  | 'source_invalid' | 'event_invalid' | 'template_invalid' | 'language_invalid'
  | 'number_invalid' | 'delay_invalid' | 'variables_invalid';

export class CommerceRuleInputError extends Error {
  constructor(public readonly code: CommerceRuleErrorCode) {
    super(code);
    this.name = 'CommerceRuleInputError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCommerceSource(v: unknown): v is CommerceSource {
  return typeof v === 'string' && (COMMERCE_SOURCES as readonly string[]).includes(v);
}
export function isCommerceEvent(v: unknown): v is CommerceEventName {
  return typeof v === 'string' && (COMMERCE_EVENTS as readonly string[]).includes(v);
}

const select = {
  id: true, source: true, event: true, enabled: true, template_name: true, template_language: true,
  whatsapp_config_id: true, delay_minutes: true, variable_map: true, updated_at: true,
} as const;

type Row = Prisma.commerce_event_rulesGetPayload<{ select: typeof select }>;
const toPublic = (r: Row): CommerceRulePublic => ({
  ...r,
  source: r.source as CommerceSource,
  event: r.event as CommerceEventName,
  variable_map: isVariableMap(r.variable_map) ? r.variable_map : {},
  updated_at: r.updated_at.toISOString(),
});

export async function listCommerceRules(tx: TenantTransaction, accountId: string, source: CommerceSource): Promise<CommerceRulePublic[]> {
  const rows = await tx.commerce_event_rules.findMany({ where: { account_id: accountId, source }, select, orderBy: { event: 'asc' } });
  return rows.map(toPublic);
}

export interface CommerceRuleInput {
  source: CommerceSource;
  event: CommerceEventName;
  enabled: boolean;
  templateName: string;
  templateLanguage: string | null;
  whatsappConfigId: string | null;
  delayMinutes: number;
  variableMap: Record<string, string>;
}

/** Validates a browser body into a rule; throws CommerceRuleInputError with a code the UI translates. */
export function parseCommerceRuleInput(body: unknown): CommerceRuleInput {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  if (!isCommerceSource(b.source)) throw new CommerceRuleInputError('source_invalid');
  if (!isCommerceEvent(b.event)) throw new CommerceRuleInputError('event_invalid');
  if (b.source === 'woocommerce' && b.event === 'checkout_abandoned') throw new CommerceRuleInputError('event_invalid');
  const templateName = typeof b.templateName === 'string' ? b.templateName.trim() : '';
  if (!/^[a-z0-9_]{1,512}$/.test(templateName)) throw new CommerceRuleInputError('template_invalid');
  const lang = b.templateLanguage === null || b.templateLanguage === undefined || b.templateLanguage === '' ? null : b.templateLanguage;
  if (lang !== null && (typeof lang !== 'string' || !/^[A-Za-z]{2,3}(_[A-Za-z0-9]{2,8})?$/.test(lang))) throw new CommerceRuleInputError('language_invalid');
  const number = b.whatsappConfigId === null || b.whatsappConfigId === undefined || b.whatsappConfigId === '' ? null : b.whatsappConfigId;
  if (number !== null && (typeof number !== 'string' || !UUID.test(number))) throw new CommerceRuleInputError('number_invalid');
  const delay = b.delayMinutes === undefined ? 0 : b.delayMinutes;
  if (typeof delay !== 'number' || !Number.isInteger(delay) || delay < 0 || delay > 10080) throw new CommerceRuleInputError('delay_invalid');
  const map = b.variableMap === undefined ? {} : b.variableMap;
  if (!isVariableMap(map)) throw new CommerceRuleInputError('variables_invalid');
  return {
    source: b.source, event: b.event, enabled: b.enabled === true, templateName, templateLanguage: lang as string | null,
    whatsappConfigId: number as string | null, delayMinutes: delay, variableMap: map,
  };
}

/** Creates or replaces the account's rule for (source, event). Admin only (RLS). */
export async function saveCommerceRule(tx: TenantTransaction, accountId: string, input: CommerceRuleInput): Promise<CommerceRulePublic> {
  if (input.whatsappConfigId) {
    const found = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM whatsapp_config WHERE id=${input.whatsappConfigId}::uuid AND account_id=${accountId}::uuid`;
    if (!found.length) throw new CommerceRuleInputError('number_invalid');
  }
  const data = {
    enabled: input.enabled,
    template_name: input.templateName,
    template_language: input.templateLanguage,
    whatsapp_config_id: input.whatsappConfigId,
    delay_minutes: input.delayMinutes,
    variable_map: input.variableMap,
  };
  const row = await tx.commerce_event_rules.upsert({
    where: { account_id_source_event: { account_id: accountId, source: input.source, event: input.event } },
    create: { account_id: accountId, source: input.source, event: input.event, ...data },
    update: data,
    select,
  });
  return toPublic(row);
}

export async function deleteCommerceRule(tx: TenantTransaction, accountId: string, source: CommerceSource, event: CommerceEventName): Promise<boolean> {
  const { count } = await tx.commerce_event_rules.deleteMany({ where: { account_id: accountId, source, event } });
  return count > 0;
}
