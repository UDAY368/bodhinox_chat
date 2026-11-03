// Campaign cost from the rate card (lib/analytics/rate-card): an estimate for
// the wizard's audience before sending, and estimated vs actual by country for
// a campaign already created. Estimates only: Meta's invoice is the record.
//
// Destination countries come from phone calling codes. Audiences are counted in
// SQL grouped by a 4-digit phone prefix (at most 10,000 groups), never loaded as
// contact lists, using the same audience SQL as campaign creation.
// "Actual" prices delivered messages (Meta charges per delivered message).

import { Prisma } from '@prisma/client';
import { z } from 'zod';

import { AuthError } from '@/lib/auth/errors';
import { audienceSchema, audienceSource, CAMPAIGN_LIMITS } from '@/lib/broadcasts/create-campaign';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { isValidE164, normalizePhone } from '@/lib/whatsapp/phone-utils';
import { countryForPhone, estimateCampaignCost, listRateCards, type RateCard, type RateCategory } from './rate-card';

const CURRENCY = /^[A-Z]{3}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** message_templates.category ('Marketing' | 'Utility' | 'Authentication') as a rate category. */
export function templateRateCategory(category: string | null | undefined): RateCategory {
  const c = (category ?? '').toLowerCase();
  return c === 'utility' || c === 'authentication' ? c : 'marketing';
}

/**
 * The currency to price in: the requested one when cards exist for it, else
 * INR (the platform's billing currency), else the first alphabetically.
 */
export function pickCurrency(cards: RateCard[], requested?: string | null): { currency: string | null; currencies: string[] } {
  const currencies = [...new Set(cards.map((c) => c.currency))].sort();
  const currency = requested && currencies.includes(requested) ? requested
    : currencies.includes('INR') ? 'INR' : currencies[0] ?? null;
  return { currency, currencies };
}

/** Counts per 4-digit phone prefix ('' = not a valid number) to counts per country. */
export function prefixesToCountries(rows: { prefix: string; n: number }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const { prefix, n } of rows) {
    const country = prefix ? countryForPhone(prefix.padEnd(8, '0')) : 'ZZ';
    out[country] = (out[country] ?? 0) + Number(n);
  }
  return out;
}

const PREFIX = Prisma.sql`CASE WHEN c.phone_normalized ~ '^[0-9]{8,15}$' THEN left(c.phone_normalized,4) ELSE '' END`;

const estimateInput = z.object({
  templateId: z.string().uuid(),
  audience: audienceSchema,
  currency: z.string().regex(CURRENCY).optional(),
}).strict();

export interface AudienceCostEstimate {
  category: RateCategory;
  /** Recipients counted, at most CAMPAIGN_LIMITS.recipients + 1. */
  recipients: number;
  /** The audience is over the campaign limit; campaign creation will refuse it. */
  capped: boolean;
  currency: string | null;
  currencies: string[];
  total: number;
  byCountry: { countryCode: string; recipients: number; unitPriceMinor: number; totalMinor: number }[];
  missingCountries: { countryCode: string; recipients: number }[];
}

function invalid(message: string): never {
  throw new AuthError(message, 400, 'campaign_input');
}

/** CSV audiences: count the rows that campaign creation would send to, without writing contacts. */
async function csvCountries(tx: TenantTransaction, accountId: string, rows: { phone: string }[], allowDuplicates: boolean) {
  const seen = new Set<string>();
  const phones: string[] = [];
  let invalidRows = 0;
  for (const row of rows) {
    const phone = normalizePhone(row.phone);
    if (!isValidE164(phone)) { invalidRows++; continue; }
    if (seen.has(phone) && !allowDuplicates) continue;
    seen.add(phone);
    phones.push(phone);
  }
  // Opted-out and blocked contacts are skipped at creation too.
  const suppressed = seen.size ? new Set((await tx.$queryRaw<{ phone: string }[]>`
    SELECT phone_normalized AS phone FROM contacts
    WHERE account_id=${accountId}::uuid AND phone_normalized IN (SELECT jsonb_array_elements_text(${JSON.stringify([...seen])}::jsonb))
      AND (opted_out_at IS NOT NULL OR blocked_at IS NOT NULL)`).map((r) => r.phone)) : new Set<string>();
  const counts: Record<string, number> = {};
  for (const phone of phones) {
    if (suppressed.has(phone)) continue;
    const country = countryForPhone(phone);
    counts[country] = (counts[country] ?? 0) + 1;
  }
  return { counts, invalidRows };
}

/** Recipients by country for a wizard audience (same rules as createCampaign). */
async function audienceCountries(tx: TenantTransaction, scope: TenantContext, audience: z.infer<typeof audienceSchema>) {
  if (audience.type === 'csv')
    return (await csvCountries(tx, scope.accountId, audience.csvContacts ?? [], Boolean(audience.allowDuplicates))).counts;
  if (audience.allowDuplicates) invalid('Duplicates can only be allowed for a CSV audience');
  const { from, where } = await audienceSource(tx, scope, { audience });
  const rows = await tx.$queryRaw<{ prefix: string; n: number }[]>(Prisma.sql`
    SELECT prefix, count(*)::int AS n FROM (SELECT ${PREFIX} AS prefix FROM ${from} WHERE ${where} LIMIT ${CAMPAIGN_LIMITS.recipients + 1}) m
    GROUP BY prefix`);
  return prefixesToCountries(rows);
}

/** Cost estimate for the campaign wizard's template and audience. Caller checks the agent role. */
export async function estimateAudienceCost(scope: TenantContext, raw: unknown): Promise<AudienceCostEstimate> {
  const parsed = estimateInput.safeParse(raw);
  if (!parsed.success) invalid('Invalid campaign configuration');
  const input = parsed.data;
  return withTenant(scope, async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = 15000`;
    const [template] = await tx.$queryRaw<{ category: string | null }[]>`
      SELECT category FROM message_templates WHERE account_id=${scope.accountId}::uuid AND id=${input.templateId}::uuid`;
    if (!template) throw new AuthError('Template unavailable', 404, 'not_found');
    const category = templateRateCategory(template.category);
    const recipientsByCountry = await audienceCountries(tx, scope, input.audience);
    const recipients = Object.values(recipientsByCountry).reduce((a, b) => a + b, 0);
    const cards = await listRateCards({ category }, tx);
    const { currency, currencies } = pickCurrency(cards, input.currency);
    const estimate = estimateCampaignCost({ category, currency: currency ?? '', recipientsByCountry }, cards);
    return { category, recipients, capped: recipients > CAMPAIGN_LIMITS.recipients, currency, currencies,
      total: estimate.total, byCountry: estimate.byCountry, missingCountries: estimate.missingCountries };
  });
}

export interface CampaignCostCountry {
  countryCode: string;
  recipients: number;
  sent: number;
  delivered: number;
  /** null: no rate configured for this country. */
  unitPriceMinor: number | null;
  estimatedMinor: number | null;
  actualMinor: number | null;
}

export interface CampaignCostComparison {
  category: RateCategory;
  currency: string | null;
  currencies: string[];
  countries: CampaignCostCountry[];
  estimatedTotal: number;
  actualTotal: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Estimated (all recipients) vs actual (delivered) cost by country for one campaign; null if not found. */
export async function campaignCostComparison(scope: TenantContext, broadcastId: string, requestedCurrency?: string | null)
  : Promise<CampaignCostComparison | null> {
  if (!UUID.test(broadcastId)) invalid('Invalid campaign');
  if (requestedCurrency && !CURRENCY.test(requestedCurrency)) invalid('Invalid currency');
  return withTenant(scope, async (tx) => {
    await tx.$executeRaw`SET LOCAL statement_timeout = 15000`;
    const [broadcast] = await tx.$queryRaw<{ category: string | null }[]>`
      SELECT (SELECT t.category FROM message_templates t WHERE t.account_id=b.account_id AND t.name=b.template_name
                ORDER BY (t.language=b.template_language) DESC, t.updated_at DESC NULLS LAST LIMIT 1) AS category
      FROM broadcasts b WHERE b.account_id=${scope.accountId}::uuid AND b.id=${broadcastId}::uuid`;
    if (!broadcast) return null;
    const category = templateRateCategory(broadcast.category);
    // A campaign has at most CAMPAIGN_LIMITS.recipients rows (broadcast_recipients_status_idx).
    const rows = await tx.$queryRaw<{ prefix: string; n: number; sent: number; delivered: number }[]>(Prisma.sql`
      SELECT ${PREFIX} AS prefix, count(*)::int AS n,
        count(*) FILTER (WHERE r.sent_at IS NOT NULL OR r.status IN ('sent','delivered','read','replied'))::int AS sent,
        count(*) FILTER (WHERE r.status IN ('delivered','read','replied'))::int AS delivered
      FROM broadcast_recipients r LEFT JOIN contacts c ON c.account_id=r.account_id AND c.id=r.contact_id
      WHERE r.account_id=${scope.accountId}::uuid AND r.broadcast_id=${broadcastId}::uuid
      GROUP BY 1`);
    const byCountry = new Map<string, { recipients: number; sent: number; delivered: number }>();
    for (const row of rows) {
      const country = row.prefix ? countryForPhone(row.prefix.padEnd(8, '0')) : 'ZZ';
      const acc = byCountry.get(country) ?? { recipients: 0, sent: 0, delivered: 0 };
      acc.recipients += Number(row.n); acc.sent += Number(row.sent); acc.delivered += Number(row.delivered);
      byCountry.set(country, acc);
    }
    const cards = await listRateCards({ category }, tx);
    const { currency, currencies } = pickCurrency(cards, requestedCurrency);
    const prices = new Map(cards.filter((c) => c.currency === currency).map((c) => [c.countryCode, c.priceMinor]));
    let estimatedTotal = 0, actualTotal = 0;
    const countries = [...byCountry.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([countryCode, c]) => {
      const unit = prices.get(countryCode) ?? null;
      const estimatedMinor = unit === null ? null : round4(unit * c.recipients);
      const actualMinor = unit === null ? null : round4(unit * c.delivered);
      estimatedTotal += estimatedMinor ?? 0;
      actualTotal += actualMinor ?? 0;
      return { countryCode, ...c, unitPriceMinor: unit, estimatedMinor, actualMinor };
    });
    return { category, currency, currencies, countries, estimatedTotal: round4(estimatedTotal), actualTotal: round4(actualTotal) };
  });
}
