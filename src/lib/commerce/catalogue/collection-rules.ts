/**
 * Smart collection rules (store plan Phase 4): the fixed shape, the
 * whitelist of fields and operators, and the validator. Client-safe (no
 * database): the editor draws its form from RULE_FIELDS, the server parses
 * what the browser sends with parseRules, and collections.ts compiles the
 * parsed rules to parameterised SQL. A rule never carries SQL: an unknown
 * field, operator or value shape is refused.
 */
import { MAX_MINOR } from '../money';

export const MAX_RULES = 10;
export const MAX_RULE_TEXT = 80;
export const COLLECTION_KINDS = ['manual', 'smart'] as const;
export type CollectionKind = (typeof COLLECTION_KINDS)[number];
export const COLLECTION_MATCHES = ['all', 'any'] as const;
export type CollectionMatch = (typeof COLLECTION_MATCHES)[number];
export const COLLECTION_SORTS = ['featured', 'price_asc', 'price_desc', 'name', 'newest'] as const;
export type CollectionSort = (typeof COLLECTION_SORTS)[number];

export type RuleValueKind = 'text' | 'id' | 'minor' | 'flag';
/** field -> allowed operators and the shape of its value. */
export const RULE_FIELDS = {
  tag: { ops: ['eq', 'neq'], value: 'text' },
  brand: { ops: ['eq', 'neq'], value: 'text' },
  product_type: { ops: ['eq', 'neq'], value: 'text' },
  category: { ops: ['eq', 'neq'], value: 'id' },
  /** The lowest price of the product's active priced variants, in minor units of the store currency. */
  price: { ops: ['gt', 'lt'], value: 'minor' },
  on_sale: { ops: ['is'], value: 'flag' },
} as const satisfies Record<string, { ops: readonly string[]; value: RuleValueKind }>;
export type RuleField = keyof typeof RULE_FIELDS;
export const RULE_FIELD_NAMES = Object.keys(RULE_FIELDS) as RuleField[];

export type CollectionRule =
  | { field: 'tag' | 'brand' | 'product_type'; op: 'eq' | 'neq'; value: string }
  | { field: 'category'; op: 'eq' | 'neq'; value: string }
  | { field: 'price'; op: 'gt' | 'lt'; value: number }
  | { field: 'on_sale'; op: 'is'; value: boolean };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A refusal naming the rule (its index and what is wrong), never echoing the value. */
export class RuleError extends Error {
  constructor(readonly index: number | null, readonly part: 'rules' | 'field' | 'op' | 'value') {
    super(`invalid_rule_${part}`);
    this.name = 'RuleError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** A tag as stored and matched: trimmed, whitespace folded, lowercased. Null when it is empty or unusable. */
export function normaliseTag(value: unknown): string | null {
  if (typeof value !== 'string' || CONTROL.test(value)) return null;
  const tag = value.replace(/\s+/g, ' ').trim().toLowerCase();
  return tag.length >= 1 && tag.length <= 40 && !tag.includes(',') ? tag : null;
}

function parseOne(raw: unknown, index: number): CollectionRule {
  if (!isObject(raw)) throw new RuleError(index, 'rules');
  const field = raw.field;
  if (typeof field !== 'string' || !Object.hasOwn(RULE_FIELDS, field)) throw new RuleError(index, 'field');
  const spec = RULE_FIELDS[field as RuleField];
  const op = raw.op;
  if (typeof op !== 'string' || !(spec.ops as readonly string[]).includes(op)) throw new RuleError(index, 'op');
  const value = raw.value;
  switch (spec.value) {
    case 'text': {
      if (typeof value !== 'string' || CONTROL.test(value)) throw new RuleError(index, 'value');
      const text = field === 'tag' ? normaliseTag(value) : value.replace(/\s+/g, ' ').trim();
      if (!text || text.length > MAX_RULE_TEXT) throw new RuleError(index, 'value');
      return { field, op, value: text } as CollectionRule;
    }
    case 'id':
      if (typeof value !== 'string' || !UUID.test(value)) throw new RuleError(index, 'value');
      return { field: 'category', op: op as 'eq' | 'neq', value: value.toLowerCase() };
    case 'minor':
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > MAX_MINOR) throw new RuleError(index, 'value');
      return { field: 'price', op: op as 'gt' | 'lt', value };
    case 'flag':
      if (typeof value !== 'boolean') throw new RuleError(index, 'value');
      return { field: 'on_sale', op: 'is', value };
  }
}

/** Validate the rules the browser sent: at most MAX_RULES, each from the whitelist. Unknown keys are dropped. */
export function parseRules(raw: unknown): CollectionRule[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > MAX_RULES) throw new RuleError(null, 'rules');
  return raw.map(parseOne);
}

/** "Summer Sale 2026!" -> "summer-sale-2026" (at most 60 characters); "" when nothing usable is left. */
export function slugify(title: string): string {
  return title.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    .slice(0, 60).replace(/-+$/g, '');
}
export const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const isSlug = (value: unknown): value is string => typeof value === 'string' && value.length <= 60 && SLUG.test(value);

/** Stored rules read back leniently: a rule that no longer validates is dropped, never compiled. */
export function readStoredRules(value: unknown): CollectionRule[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_RULES).flatMap((r, i) => { try { return [parseOne(r, i)]; } catch { return []; } });
}
