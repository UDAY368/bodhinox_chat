/**
 * "Send as new arrivals" (store plan Phase 3): turn chosen catalogue products
 * into the cards of an approved carousel template and start an ordinary
 * campaign. This file only validates and maps; the campaign itself is made by
 * createCampaign, the path the broadcast wizard uses, so consent, plan limits,
 * scheduling, the audience rules and the durable send job are the same.
 */
import { z } from 'zod';
import { AuthError, ForbiddenError } from '@/lib/auth/errors';
import { hasMinRole } from '@/lib/auth/roles';
import { audienceSchema, createCampaign } from '@/lib/broadcasts/create-campaign';
import { withTenant, type TenantContext } from '@/lib/db/tenant';
import { assertMessageTemplate } from '@/lib/whatsapp/template-row-guard';
import { cardVariableKey, templateSendNeeds, type CampaignCardExtras } from '@/lib/whatsapp/template-send-params';
import { templateKindOf } from '@/lib/whatsapp/template-validators';
import type { MessageTemplate } from '@/types';
import { formatMoney } from './money';
import { loadProductsWith, resolvePublicShop } from './public-shop';

export const NEW_ARRIVALS_MAX_CARDS = 10;

const inputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  templateId: z.string().uuid(),
  productIds: z.array(z.string().uuid()).min(1).max(NEW_ARRIVALS_MAX_CARDS),
  audience: audienceSchema,
  /** Values for the template's own (top) body variables, in order. */
  bodyValues: z.array(z.string().trim().min(1).max(1024)).max(20).optional(),
  scheduledAt: z.string().datetime({ offset: true }).optional(),
  whatsappConfigId: z.string().uuid().nullish(),
}).strict();
export type NewArrivalsInput = z.infer<typeof inputSchema>;

/** A product as the cards need it: name, cheapest price and its first image link. */
export interface CardProduct { id: string; name: string; priceMinor: number; currency: string; imageUrl: string }

export interface MappedCards {
  variables: Record<string, { type: 'static'; value: string }>;
  cards: CampaignCardExtras[];
}

const refuse = (message: string, code = 'new_arrivals'): never => { throw new AuthError(message, 400, code); };

/**
 * Fill each card of `template` from the product in the same position: header
 * image, body variables ({{1}} name, {{2}} price) and the URL button suffix
 * `p/<productId>`. Refuses a mismatch instead of guessing.
 */
export function mapNewArrivalCards(
  template: Pick<MessageTemplate, 'body_text' | 'header_type' | 'header_content' | 'buttons' | 'template_kind' | 'cards' | 'lto'>,
  products: CardProduct[], locale = 'en',
): MappedCards {
  if (templateKindOf(template) !== 'carousel') refuse('Choose a carousel template');
  const needs = templateSendNeeds(template);
  if (needs.cards.length !== products.length) refuse(`This template has ${needs.cards.length} cards: pick exactly ${needs.cards.length} products`);
  const variables: MappedCards['variables'] = {};
  const cards: CampaignCardExtras[] = [];
  needs.cards.forEach((card, i) => {
    const product = products[i];
    if ((template.cards?.[i]?.header_type ?? 'image') !== 'image') refuse(`Card ${i + 1} must have an image header`);
    if (card.bodyVars.length > 2) refuse(`Card ${i + 1} uses more than a name and a price`);
    const values = [product.name.slice(0, 200), formatMoney(product.priceMinor, product.currency, locale)];
    card.bodyVars.forEach((n, at) => { variables[cardVariableKey(i, n)] = { type: 'static', value: values[at] }; });
    const buttonParams: Record<number, string> = {};
    for (const button of card.urlButtons) buttonParams[button.index] = `p/${product.id}`;
    cards.push({ headerMediaUrl: product.imageUrl, ...(Object.keys(buttonParams).length ? { buttonParams } : {}) });
  });
  return { variables, cards };
}

/** The public image link of a product: our own public route on APP_URL (the shop must be published). */
export const publicImageLink = (origin: string, handle: string, imageId: string) => `${origin.replace(/\/$/, '')}/api/public/store/${handle}/images/${imageId}`;

/** Validate and start the campaign. The route applies the same role and permission rule as POST /api/broadcasts/create. */
export async function createNewArrivalsCampaign(scope: TenantContext, raw: unknown, now = new Date()): Promise<{ id: string }> {
  if (!scope.userId || !scope.role || !hasMinRole(scope.role, 'agent')) throw new ForbiddenError('Campaign creation requires an agent role');
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return refuse('Invalid new-arrivals request', 'invalid');
  const input = parsed.data;
  if (new Set(input.productIds).size !== input.productIds.length) refuse('Pick each product once', 'invalid');
  const origin = process.env.APP_URL || process.env.NEXT_PUBLIC_SITE_URL;
  if (!origin || !/^https:\/\//.test(origin)) refuse('The app address must be a public https URL to send product images', 'no_public_url');

  const prepared = await withTenant(scope, async (tx) => {
    const [shop] = await tx.$queryRaw<{ handle: string }[]>`SELECT handle FROM shop_storefronts WHERE account_id=${scope.accountId}::uuid`;
    if (!shop || (await resolvePublicShop(shop.handle)) !== scope.accountId) refuse('Publish your shop first: product images are sent from its public address', 'shop_not_published');
    const rows = await tx.$queryRaw<unknown[]>`SELECT * FROM message_templates WHERE account_id=${scope.accountId}::uuid AND id=${input.templateId}::uuid`;
    if (!rows[0]) throw new AuthError('Template unavailable', 404, 'not_found');
    const template = assertMessageTemplate(rows[0], 'new arrivals');
    if (template.status !== 'APPROVED') refuse('Choose an approved template');
    const [currencyRow] = await tx.$queryRaw<{ currency: string }[]>`SELECT currency FROM commerce_settings WHERE account_id=${scope.accountId}::uuid`;
    if (!currencyRow) refuse('Set up the store currency first', 'store_not_configured');
    const found = await loadProductsWith(tx, scope.accountId, { productIds: input.productIds, limit: NEW_ARRIVALS_MAX_CARDS },
      (image) => publicImageLink(origin!, shop.handle, image.id));
    // Only published products of this workspace come back; anything else is refused.
    if (found.length !== input.productIds.length) refuse('Some products are not published in this workspace', 'products_unavailable');
    const products: CardProduct[] = input.productIds.map((id) => {
      const p = found.find((f) => f.id === id)!;
      if (!p.images[0]) refuse(`"${p.name}" has no image to send`, 'product_no_image');
      return { id: p.id, name: p.name, priceMinor: Math.min(...p.variants.map((v) => v.priceMinor)), currency: currencyRow.currency, imageUrl: p.images[0] };
    });
    return { template, products };
  });

  const mapped = mapNewArrivalCards(prepared.template, prepared.products);
  const top = templateSendNeeds(prepared.template).bodyVars;
  const bodyValues = input.bodyValues ?? [];
  if (bodyValues.length !== top.length) refuse(`Give a value for each of the template's ${top.length} message variables`, 'body_values');
  const variables: Record<string, { type: 'static'; value: string }> = { ...mapped.variables };
  top.forEach((n, i) => { variables[String(n)] = { type: 'static', value: bodyValues[i] }; });
  return createCampaign(scope, {
    name: input.name, templateId: input.templateId, audience: input.audience, variables, scheduledAt: input.scheduledAt,
    whatsappConfigId: input.whatsappConfigId, sendExtras: { cards: mapped.cards },
  }, now);
}
