/**
 * The optional reply sent when a WhatsApp cart arrives (order_settings): a
 * free-form text (the customer just wrote, so the service window is open) or
 * an approved template. Runs in the inbound.actions job, inside the
 * "order_confirmation" stage checkpoint, and sends through an outbound intent
 * keyed by the order id: an ambiguous outcome is left for reconciliation and
 * never sent again. Refusals Meta would never see (paused bot, disconnected
 * number, unusable template) are decided before the intent exists.
 */

import { createAdminClient } from '@/lib/data/admin';
import { getWorkerPrisma } from '@/lib/db/prisma';
import { withTenant } from '@/lib/db/tenant';
import { engineSendTemplate, engineSendText } from '@/lib/automations/meta-send';
import { automationTemplateRefusal } from '@/lib/automations/template-check';
import { dispatchOnce } from '@/lib/jobs/dispatch';
import { botRepliesPaused } from '@/lib/whatsapp/bot-pause';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import { assertWhatsAppConversation, getNumberConfig, isNumberDisconnected, NoNumberError } from '@/lib/whatsapp/numbers';
import { assertTemplateOnNumber } from '@/lib/whatsapp/sender-config';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import { templateSendRefusal } from '@/lib/whatsapp/template-send-params';
import { resolveTemplateVariables } from './event-rules';
import { fillOrderPlaceholders, orderFlowVars, type OrderMessagePayload } from './order-format';
import { loadOrderSettingsForWorker } from './orders';

export type OrderConfirmationOutcome =
  | 'off' | 'sent' | 'bot_paused' | 'number_unavailable' | 'template_not_found' | 'template_refused' | 'provider_rejected';

export interface OrderConfirmationInput {
  accountId: string;
  userId: string;
  conversationId: string;
  contactId: string;
  order: OrderMessagePayload;
}

/** The intent key; one confirmation per order, ever. */
export const orderConfirmationKey = (orderId: string) => `order_confirm:${orderId}`;

export async function sendOrderConfirmation(input: OrderConfirmationInput): Promise<OrderConfirmationOutcome> {
  const { accountId, conversationId } = input;
  const settings = await loadOrderSettingsForWorker(accountId);
  if (settings.confirmation_mode === 'off') return 'off';
  if (await botRepliesPaused(accountId, conversationId)) return 'bot_paused';

  const number = await withTenant({ accountId, role: 'owner' }, async (tx) => {
    const conversation = await tx.conversations.findFirst({ where: { account_id: accountId, id: conversationId }, select: { whatsapp_config_id: true, channel: true } });
    try {
      // An order that arrived on Instagram is never confirmed over WhatsApp.
      if (conversation) assertWhatsAppConversation(conversation);
      const config = await getNumberConfig(tx, accountId, conversation?.whatsapp_config_id ?? null);
      return isNumberDisconnected(config) ? null : config;
    } catch (error) {
      if (error instanceof NoNumberError) return null;
      throw error;
    }
  }, getWorkerPrisma());
  if (!number) return 'number_unavailable';

  const contact = await withTenant({ accountId, role: 'owner' }, (tx) => tx.contacts.findFirst({
    where: { account_id: accountId, id: input.contactId }, select: { name: true },
  }), getWorkerPrisma());
  const values = { ...orderFlowVars(input.order), customer_name: contact?.name?.trim() || '' };
  const common = { accountId, userId: input.userId, conversationId, contactId: input.contactId };

  let send: () => Promise<{ whatsapp_message_id: string }>;
  if (settings.confirmation_mode === 'text') {
    const text = fillOrderPlaceholders(settings.confirmation_text ?? '', values).trim().slice(0, 4096);
    if (!text) return 'template_refused';
    send = () => engineSendText({ ...common, text });
  } else {
    const db = createAdminClient({ accountId, role: 'owner' });
    const template = await resolveTemplateRow(db, accountId, settings.template_name ?? '', settings.template_language);
    if (!template.row) return 'template_not_found';
    const row = template.row as { status?: string | null };
    if ((row.status ?? '').toUpperCase() !== 'APPROVED') return 'template_refused';
    if (templateSendRefusal(template.row, 'automation') || automationTemplateRefusal(template.row)) return 'template_refused';
    try {
      assertTemplateOnNumber(template.row, number);
    } catch {
      return 'template_refused';
    }
    send = () => engineSendTemplate({
      ...common, templateName: settings.template_name!, language: template.language,
      params: resolveTemplateVariables(settings.variable_map, values), bodyValuesOnly: true,
    });
  }

  try {
    await dispatchOnce(accountId, orderConfirmationKey(input.order.order_id), send);
  } catch (error) {
    // UncertainDispatchError propagates: the stage checkpoint records it for reconciliation.
    if (error instanceof MetaApiError && error.httpStatus >= 400 && error.httpStatus < 500) return 'provider_rejected';
    throw error;
  }
  return 'sent';
}
