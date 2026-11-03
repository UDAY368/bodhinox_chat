// Meta's per-message rate card (rate_cards): price of one message by template
// category and destination country, and campaign cost estimates from it.
// Platform data, not tenant data; seeded empty. Platform admins
// (PLATFORM_ADMIN_EMAILS) load it through PUT /api/analytics/admin/rate-cards;
// writes go through the worker role, reads through the app role.
//
// Destination country comes from the E.164 calling code (CALLING_CODES below).
// +1 numbers are all mapped to US: NANP countries share the code and are told
// apart only by area code, so give Canada and the Caribbean the US price or
// expect them to land under US.

import type { Prisma } from '@prisma/client';
import { getPrisma, getWorkerPrisma } from '@/lib/db/prisma';

export const RATE_CATEGORIES = ['marketing', 'utility', 'authentication', 'service'] as const;
export type RateCategory = (typeof RATE_CATEGORIES)[number];
export const MAX_RATE_CARDS_PER_WRITE = 1000;

export interface RateCard {
  category: RateCategory;
  countryCode: string;
  currency: string;
  /** Price of one message in the currency's minor unit (may be fractional). */
  priceMinor: number;
}

/** A write: priceMinor null removes the row. */
export type RateCardInput = Omit<RateCard, 'priceMinor'> & { priceMinor: number | null };

export class RateCardInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RateCardInputError';
  }
}

export function isRateCategory(value: unknown): value is RateCategory {
  return typeof value === 'string' && (RATE_CATEGORIES as readonly string[]).includes(value);
}

/** Validates one rate card row from a request body. Throws RateCardInputError. */
export function parseRateCard(raw: unknown): RateCardInput {
  const r = (raw ?? {}) as Record<string, unknown>;
  const category = r.category, country = r.country_code, currency = r.currency, price = r.price_minor;
  if (!isRateCategory(category)) throw new RateCardInputError('Invalid category');
  if (typeof country !== 'string' || !/^[A-Z]{2}$/.test(country)) throw new RateCardInputError('Invalid country');
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) throw new RateCardInputError('Invalid currency');
  // numeric(14,4): at most 4 decimal places, below 1e10.
  if (price !== null && (typeof price !== 'number' || !Number.isFinite(price) || price < 0 || price >= 1e10
    || Math.abs(price * 1e4 - Math.round(price * 1e4)) > 1e-6))
    throw new RateCardInputError('Invalid price');
  return { category, countryCode: country, currency, priceMinor: price as number | null };
}

type Reader = Prisma.TransactionClient | ReturnType<typeof getPrisma>;

/** Rate cards, optionally for one category and currency. Any signed-in user. */
export async function listRateCards(filter: { category?: RateCategory; currency?: string } = {}, db: Reader = getPrisma()): Promise<RateCard[]> {
  const rows = await db.$queryRaw<{ category: RateCategory; country_code: string; currency: string; price_minor: number }[]>`
    SELECT category, country_code, currency, price_minor::float8 AS price_minor FROM rate_cards
    WHERE (${filter.category ?? null}::text IS NULL OR category=${filter.category ?? null})
      AND (${filter.currency ?? null}::text IS NULL OR currency=${filter.currency ?? null})
    ORDER BY category, country_code, currency`;
  return rows.map((r) => ({ category: r.category, countryCode: r.country_code, currency: r.currency, priceMinor: Number(r.price_minor) }));
}

/** Upserts or removes rate cards (worker role). Call only after isPlatformAdmin. */
export async function upsertRateCards(cards: RateCardInput[]): Promise<number> {
  if (cards.length > MAX_RATE_CARDS_PER_WRITE) throw new RateCardInputError('Too many rate cards');
  await getWorkerPrisma().$transaction(async (tx) => {
    for (const c of cards) {
      if (c.priceMinor === null)
        await tx.$executeRaw`DELETE FROM rate_cards WHERE category=${c.category} AND country_code=${c.countryCode} AND currency=${c.currency}`;
      else
        await tx.$executeRaw`
          INSERT INTO rate_cards (category, country_code, currency, price_minor)
          VALUES (${c.category}, ${c.countryCode}, ${c.currency}, ${c.priceMinor})
          ON CONFLICT (category, country_code, currency) DO UPDATE SET price_minor = EXCLUDED.price_minor`;
    }
  });
  return cards.length;
}

export interface CampaignCostEstimate {
  currency: string;
  /** Sum over priced countries, in minor units (rounded to 4 places). */
  total: number;
  byCountry: { countryCode: string; recipients: number; unitPriceMinor: number; totalMinor: number }[];
  /** Countries with recipients but no price for this category and currency (not in total). */
  missingCountries: { countryCode: string; recipients: number }[];
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * Estimates a campaign's Meta charges from the rate card. Pass the cards for
 * the campaign's category and currency (listRateCards); other rows are ignored.
 * Recipients under an unknown country ('ZZ' from countryForPhone) are missing.
 */
export function estimateCampaignCost(input: { category: RateCategory; currency: string; recipientsByCountry: Record<string, number> },
  cards: RateCard[]): CampaignCostEstimate {
  const prices = new Map(cards.filter((c) => c.category === input.category && c.currency === input.currency)
    .map((c) => [c.countryCode, c.priceMinor]));
  const byCountry: CampaignCostEstimate['byCountry'] = [];
  const missingCountries: CampaignCostEstimate['missingCountries'] = [];
  let total = 0;
  for (const [countryCode, recipients] of Object.entries(input.recipientsByCountry).sort(([a], [b]) => a.localeCompare(b))) {
    if (!Number.isSafeInteger(recipients) || recipients <= 0) continue;
    const unit = prices.get(countryCode);
    if (unit === undefined) {
      missingCountries.push({ countryCode, recipients });
      continue;
    }
    const totalMinor = round4(unit * recipients);
    total += totalMinor;
    byCountry.push({ countryCode, recipients, unitPriceMinor: unit, totalMinor });
  }
  return { currency: input.currency, total: round4(total), byCountry, missingCountries };
}

// ITU calling codes -> ISO 3166 country. Longest prefix wins (1-4 digits).
const CALLING_CODES: Record<string, string> = {
  '1': 'US', '7': 'RU', '76': 'KZ', '77': 'KZ', '20': 'EG', '27': 'ZA', '30': 'GR', '31': 'NL', '32': 'BE', '33': 'FR',
  '34': 'ES', '36': 'HU', '39': 'IT', '40': 'RO', '41': 'CH', '43': 'AT', '44': 'GB', '45': 'DK', '46': 'SE', '47': 'NO',
  '48': 'PL', '49': 'DE', '51': 'PE', '52': 'MX', '53': 'CU', '54': 'AR', '55': 'BR', '56': 'CL', '57': 'CO', '58': 'VE',
  '60': 'MY', '61': 'AU', '62': 'ID', '63': 'PH', '64': 'NZ', '65': 'SG', '66': 'TH', '81': 'JP', '82': 'KR', '84': 'VN',
  '86': 'CN', '90': 'TR', '91': 'IN', '92': 'PK', '93': 'AF', '94': 'LK', '95': 'MM', '98': 'IR',
  '211': 'SS', '212': 'MA', '213': 'DZ', '216': 'TN', '218': 'LY', '220': 'GM', '221': 'SN', '222': 'MR', '223': 'ML',
  '224': 'GN', '225': 'CI', '226': 'BF', '227': 'NE', '228': 'TG', '229': 'BJ', '230': 'MU', '231': 'LR', '232': 'SL',
  '233': 'GH', '234': 'NG', '235': 'TD', '236': 'CF', '237': 'CM', '238': 'CV', '239': 'ST', '240': 'GQ', '241': 'GA',
  '242': 'CG', '243': 'CD', '244': 'AO', '245': 'GW', '248': 'SC', '249': 'SD', '250': 'RW', '251': 'ET', '252': 'SO',
  '253': 'DJ', '254': 'KE', '255': 'TZ', '256': 'UG', '257': 'BI', '258': 'MZ', '260': 'ZM', '261': 'MG', '262': 'RE',
  '263': 'ZW', '264': 'NA', '265': 'MW', '266': 'LS', '267': 'BW', '268': 'SZ', '269': 'KM', '291': 'ER',
  '297': 'AW', '298': 'FO', '299': 'GL', '350': 'GI', '351': 'PT', '352': 'LU', '353': 'IE', '354': 'IS', '355': 'AL',
  '356': 'MT', '357': 'CY', '358': 'FI', '359': 'BG', '370': 'LT', '371': 'LV', '372': 'EE', '373': 'MD', '374': 'AM',
  '375': 'BY', '376': 'AD', '377': 'MC', '378': 'SM', '380': 'UA', '381': 'RS', '382': 'ME', '383': 'XK', '385': 'HR',
  '386': 'SI', '387': 'BA', '389': 'MK', '420': 'CZ', '421': 'SK', '423': 'LI',
  '501': 'BZ', '502': 'GT', '503': 'SV', '504': 'HN', '505': 'NI', '506': 'CR', '507': 'PA', '509': 'HT',
  '591': 'BO', '592': 'GY', '593': 'EC', '595': 'PY', '597': 'SR', '598': 'UY',
  '670': 'TL', '673': 'BN', '675': 'PG', '679': 'FJ', '852': 'HK', '853': 'MO', '855': 'KH', '856': 'LA', '880': 'BD',
  '886': 'TW', '960': 'MV', '961': 'LB', '962': 'JO', '963': 'SY', '964': 'IQ', '965': 'KW', '966': 'SA', '967': 'YE',
  '968': 'OM', '970': 'PS', '971': 'AE', '972': 'IL', '973': 'BH', '974': 'QA', '975': 'BT', '976': 'MN', '977': 'NP',
  '992': 'TJ', '993': 'TM', '994': 'AZ', '995': 'GE', '996': 'KG', '998': 'UZ',
};

/** ISO country of an E.164 number ('+' and separators allowed), or 'ZZ' when unknown. */
export function countryForPhone(phone: string): string {
  const digits = phone.replace(/[\s()+.-]/g, '');
  if (!/^\d{8,15}$/.test(digits)) return 'ZZ';
  for (let len = 4; len >= 1; len--) {
    const country = CALLING_CODES[digits.slice(0, len)];
    if (country) return country;
  }
  return 'ZZ';
}

/** Recipient counts per country for a list of E.164 numbers. */
export function recipientsByCountry(phones: Iterable<string>): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const phone of phones) {
    const country = countryForPhone(phone);
    counts[country] = (counts[country] ?? 0) + 1;
  }
  return counts;
}
