/**
 * Collections (store plan Phase 4): a named group of products on the public
 * shop at /s/<handle>/collections/<slug>. A manual collection lists products
 * the admin picked (shop_collection_products); a smart collection holds up to
 * ten rules that choose products by tag, brand, type, category, price or sale.
 *
 * The rules are compiled to SQL here and only here, from a fixed whitelist of
 * fields and operators (collection-rules.ts): every user value is a bound
 * parameter, and the only SQL text is written in this file. The public shop
 * shows published products with a priced, active variant, whatever the rules
 * say.
 *
 * Tenancy: everything runs in the caller's withTenant transaction. Admins
 * write through RLS; agents read; the public pages read through the worker.
 */
import { Prisma } from '@prisma/client';
import type { TenantTransaction } from '@/lib/db/tenant';
import {
  COLLECTION_KINDS, COLLECTION_MATCHES, COLLECTION_SORTS, isSlug, parseRules, readStoredRules, RuleError, slugify,
  type CollectionKind, type CollectionMatch, type CollectionRule, type CollectionSort,
} from './collection-rules';
import { asBody, auditCatalogue, CatalogueError, has, isId } from './products';

export const MAX_MANUAL_PRODUCTS = 200;
/** The most products a collection page or a section ever scans. */
export const COLLECTION_SCAN_LIMIT = 500;
export const MAX_COLLECTIONS = 100;
export const PREVIEW_SAMPLE = 8;

export interface ShopCollection {
  id: string;
  title: string;
  slug: string;
  description: string | null;
  kind: CollectionKind;
  rules: CollectionRule[];
  match: CollectionMatch;
  sort: CollectionSort;
  published: boolean;
  /** Products a visitor would see (published, with a priced active variant). */
  product_count: number;
  created_at: string;
  updated_at: string;
}

export interface ShopCollectionDetail extends ShopCollection {
  /** The picked products, in order (manual collections). */
  products: Array<{ id: string; name: string; status: string }>;
}

// ------------------------------------------------------------ rules to SQL

const MIN_PRICE = Prisma.sql`(SELECT min(v.price_minor) FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id
  AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)`;
const ON_SALE = Prisma.sql`EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id
  AND v.archived_at IS NULL AND v.price_minor IS NOT NULL AND v.compare_at_minor > v.price_minor)`;
/** A product that can be sold now: published and inside its publish/hide window (Phase 8), with a priced active variant. */
export const SELLABLE = Prisma.sql`shop_product_live(p.status, p.publish_at, p.hide_at) AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id
  AND v.product_id=p.id AND v.archived_at IS NULL AND v.price_minor IS NOT NULL)`;

/** One validated rule as a SQL condition on `shop_products p`. Values are parameters; the text below is fixed. */
export function ruleSql(rule: CollectionRule): Prisma.Sql {
  switch (rule.field) {
    case 'tag': {
      const contains = Prisma.sql`p.tags @> ARRAY[${rule.value}]::text[]`;
      return rule.op === 'eq' ? contains : Prisma.sql`NOT (${contains})`;
    }
    case 'brand': {
      const same = Prisma.sql`lower(p.brand) = lower(${rule.value})`;
      return rule.op === 'eq' ? same : Prisma.sql`NOT COALESCE(${same}, false)`;
    }
    case 'product_type': {
      const same = Prisma.sql`lower(p.product_type) = lower(${rule.value})`;
      return rule.op === 'eq' ? same : Prisma.sql`NOT COALESCE(${same}, false)`;
    }
    case 'category': {
      // A category and its sub-categories, as the category pages treat them.
      const inside = Prisma.sql`p.category_id IN (SELECT c.id FROM shop_categories c WHERE c.account_id=p.account_id
        AND (c.id=${rule.value}::uuid OR c.parent_id=${rule.value}::uuid))`;
      return rule.op === 'eq' ? inside : Prisma.sql`NOT COALESCE(${inside}, false)`;
    }
    case 'price':
      return rule.op === 'gt' ? Prisma.sql`${MIN_PRICE} > ${rule.value}::bigint` : Prisma.sql`${MIN_PRICE} < ${rule.value}::bigint`;
    case 'on_sale':
      return rule.value ? ON_SALE : Prisma.sql`NOT ${ON_SALE}`;
  }
}

/** The rules combined with AND (match all) or OR (match any); a smart collection with no rules matches nothing. */
export function rulesWhere(rules: CollectionRule[], match: CollectionMatch): Prisma.Sql {
  if (rules.length === 0) return Prisma.sql`false`;
  return Prisma.sql`(${Prisma.join(rules.map((r) => Prisma.sql`(${ruleSql(r)})`), match === 'any' ? ' OR ' : ' AND ')})`;
}

const ORDER: Record<CollectionSort, Prisma.Sql> = {
  featured: Prisma.sql`lower(p.name), p.id`,
  name: Prisma.sql`lower(p.name), p.id`,
  newest: Prisma.sql`p.created_at DESC, p.id`,
  price_asc: Prisma.sql`${MIN_PRICE} ASC NULLS LAST, lower(p.name), p.id`,
  price_desc: Prisma.sql`${MIN_PRICE} DESC NULLS LAST, lower(p.name), p.id`,
};

export interface CollectionDef { kind: CollectionKind; rules: CollectionRule[]; match: CollectionMatch; sort: CollectionSort; id?: string }

/**
 * Ids of the sellable products of a collection, in its sort order. A manual
 * collection's "featured" order is the order the admin picked.
 */
export async function collectionProductIds(tx: TenantTransaction, accountId: string, def: CollectionDef, limit = COLLECTION_SCAN_LIMIT): Promise<string[]> {
  const cap = Math.min(Math.max(limit, 1), COLLECTION_SCAN_LIMIT);
  if (def.kind === 'manual') {
    if (!def.id) return [];
    const order = def.sort === 'featured' ? Prisma.sql`cp.position, lower(p.name), p.id` : ORDER[def.sort];
    const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p.id::text AS id FROM shop_collection_products cp
      JOIN shop_products p ON p.account_id=cp.account_id AND p.id=cp.product_id
      WHERE cp.account_id=${accountId}::uuid AND cp.collection_id=${def.id}::uuid AND ${SELLABLE}
      ORDER BY ${order} LIMIT ${cap}`);
    return rows.map((r) => r.id);
  }
  const rows = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT p.id::text AS id FROM shop_products p
    WHERE p.account_id=${accountId}::uuid AND ${SELLABLE} AND ${rulesWhere(def.rules, def.match)}
    ORDER BY ${ORDER[def.sort]} LIMIT ${cap}`);
  return rows.map((r) => r.id);
}

// ------------------------------------------------------------ parsing

const CONTROL = /[\u0000-\u001f\u007f]/;

function oneOf<T extends string>(b: Record<string, unknown>, k: string, allowed: readonly T[]): T {
  const v = b[k];
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new CatalogueError('invalid', k);
  return v as T;
}

function parseRulesField(value: unknown): CollectionRule[] {
  try {
    return parseRules(value);
  } catch (error) {
    if (error instanceof RuleError) throw new CatalogueError('invalid', 'rules', error.index === null ? error.part : `${error.index}:${error.part}`);
    throw error;
  }
}

export interface CollectionInput {
  title: string; slug: string; description: string | null; kind: CollectionKind; rules: CollectionRule[]; match: CollectionMatch;
  sort: CollectionSort; published: boolean; productIds: string[];
}

/** Validate a create body (all of title; the rest default) or merge a patch over `current`. */
export function parseCollectionInput(raw: unknown, current: ShopCollectionDetail | null): CollectionInput {
  const b = asBody(raw);
  const title = has(b, 'title') ? b.title : current?.title;
  if (typeof title !== 'string' || CONTROL.test(title) || title.trim().length < 1 || title.trim().length > 120) throw new CatalogueError('invalid', 'title');
  const slug = has(b, 'slug') && b.slug !== '' && b.slug !== null ? b.slug : current?.slug ?? slugify(title);
  if (!isSlug(slug)) throw new CatalogueError('invalid', 'slug');
  let description: string | null = current?.description ?? null;
  if (has(b, 'description')) {
    if (b.description !== null && (typeof b.description !== 'string' || b.description.length > 2000)) throw new CatalogueError('invalid', 'description');
    description = typeof b.description === 'string' ? b.description.replace(/\r\n?/g, '\n').trim() || null : null;
  }
  const kind = has(b, 'kind') ? oneOf(b, 'kind', COLLECTION_KINDS) : current?.kind ?? 'manual';
  const match = has(b, 'match') ? oneOf(b, 'match', COLLECTION_MATCHES) : current?.match ?? 'all';
  const sort = has(b, 'sort') ? oneOf(b, 'sort', COLLECTION_SORTS) : current?.sort ?? 'featured';
  const published = has(b, 'published') ? b.published : current?.published ?? false;
  if (typeof published !== 'boolean') throw new CatalogueError('invalid', 'published');
  const rules = has(b, 'rules') ? parseRulesField(b.rules) : current?.rules ?? [];
  let productIds = current?.products.map((p) => p.id) ?? [];
  if (has(b, 'product_ids')) {
    const ids = b.product_ids;
    if (!Array.isArray(ids) || ids.length > MAX_MANUAL_PRODUCTS || !ids.every(isId)) throw new CatalogueError('invalid', 'product_ids');
    productIds = [...new Set((ids as string[]).map((id) => id.toLowerCase()))];
  }
  // A collection is one kind: a smart one has no picked products, a manual one no rules.
  return {
    title: title.trim(), slug, description, kind, match, sort, published,
    rules: kind === 'smart' ? rules : [],
    productIds: kind === 'manual' ? productIds : [],
  };
}

// ------------------------------------------------------------ reads

type Row = {
  id: string; title: string; slug: string; description: string | null; kind: CollectionKind; rules: unknown; match: CollectionMatch;
  sort: CollectionSort; published: boolean; created_at: Date; updated_at: Date;
};

async function rowsOf(tx: TenantTransaction, accountId: string, id: string | null): Promise<Row[]> {
  return tx.$queryRaw<Row[]>`
    SELECT id::text AS id, title, slug, description, kind, rules, match, sort, published, created_at, updated_at
    FROM shop_collections WHERE account_id=${accountId}::uuid AND (${id}::uuid IS NULL OR id=${id}::uuid)
    ORDER BY lower(title), id LIMIT ${MAX_COLLECTIONS}`;
}

async function count(tx: TenantTransaction, accountId: string, def: CollectionDef): Promise<number> {
  return (await collectionProductIds(tx, accountId, def)).length;
}

async function toCollection(tx: TenantTransaction, accountId: string, r: Row): Promise<ShopCollection> {
  const rules = readStoredRules(r.rules);
  return {
    id: r.id, title: r.title, slug: r.slug, description: r.description, kind: r.kind, rules, match: r.match, sort: r.sort,
    published: r.published, created_at: r.created_at.toISOString(), updated_at: r.updated_at.toISOString(),
    product_count: await count(tx, accountId, { id: r.id, kind: r.kind, rules, match: r.match, sort: r.sort }),
  };
}

export async function listCollections(tx: TenantTransaction, accountId: string): Promise<ShopCollection[]> {
  const out: ShopCollection[] = [];
  for (const r of await rowsOf(tx, accountId, null)) out.push(await toCollection(tx, accountId, r));
  return out;
}

export async function getCollection(tx: TenantTransaction, accountId: string, id: string): Promise<ShopCollectionDetail> {
  if (!isId(id)) throw new CatalogueError('not_found');
  const [row] = await rowsOf(tx, accountId, id);
  if (!row) throw new CatalogueError('not_found');
  const products = await tx.$queryRaw<{ id: string; name: string; status: string }[]>`
    SELECT p.id::text AS id, p.name, p.status FROM shop_collection_products cp
    JOIN shop_products p ON p.account_id=cp.account_id AND p.id=cp.product_id
    WHERE cp.account_id=${accountId}::uuid AND cp.collection_id=${id}::uuid ORDER BY cp.position, lower(p.name), p.id`;
  return { ...(await toCollection(tx, accountId, row)), products };
}

// ------------------------------------------------------------ writes

function mapSlugError(error: unknown): never {
  const e = error as { code?: string; meta?: { code?: string }; message?: string };
  const code = e?.meta?.code ?? e?.code;
  if (code === '23505' || /23505|unique constraint/i.test(e?.message ?? '')) throw new CatalogueError('slug_taken', 'slug');
  if (code === '23503' || code === '23514' || /2350[34]|23514|foreign key|check constraint/i.test(e?.message ?? '')) throw new CatalogueError('invalid');
  throw error;
}

async function setMembers(tx: TenantTransaction, accountId: string, collectionId: string, productIds: string[]) {
  if (productIds.length) {
    const found = await tx.$queryRaw<{ id: string }[]>`SELECT id::text AS id FROM shop_products
      WHERE account_id=${accountId}::uuid AND id = ANY(${productIds}::uuid[])`;
    if (found.length !== productIds.length) throw new CatalogueError('invalid', 'product_ids');
  }
  await tx.$executeRaw`DELETE FROM shop_collection_products WHERE account_id=${accountId}::uuid AND collection_id=${collectionId}::uuid`;
  for (const [position, productId] of productIds.entries())
    await tx.$executeRaw`INSERT INTO shop_collection_products(account_id,collection_id,product_id,position)
      VALUES(${accountId}::uuid,${collectionId}::uuid,${productId}::uuid,${position})`;
}

/** Create (id null) or update a collection (admins). The slug is unique per workspace (slug_taken). */
export async function upsertCollection(tx: TenantTransaction, accountId: string, userId: string, id: string | null, raw: unknown):
  Promise<ShopCollectionDetail> {
  const current = id ? await getCollection(tx, accountId, id) : null;
  const next = parseCollectionInput(raw, current);
  if (!current) {
    const total = await tx.$queryRaw<{ n: bigint }[]>`SELECT count(*) AS n FROM shop_collections WHERE account_id=${accountId}::uuid`;
    if (Number(total[0]?.n ?? 0) >= MAX_COLLECTIONS) throw new CatalogueError('invalid', 'title', 'too_many');
    const rows = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO shop_collections(account_id,title,slug,description,kind,rules,match,sort,published,created_by)
      VALUES(${accountId}::uuid,${next.title},${next.slug},${next.description},${next.kind},${JSON.stringify(next.rules)}::jsonb,${next.match},
        ${next.sort},${next.published},${userId}::uuid)
      RETURNING id::text AS id`.catch(mapSlugError);
    await setMembers(tx, accountId, rows[0].id, next.productIds);
    await auditCatalogue(tx, accountId, userId, 'commerce.collection_created', rows[0].id, { kind: next.kind });
    return getCollection(tx, accountId, rows[0].id);
  }
  // RLS hides the row from a non-admin: no row updated is a refusal, not a silent no-op.
  const changed = await tx.$executeRaw`
    UPDATE shop_collections SET title=${next.title}, slug=${next.slug}, description=${next.description}, kind=${next.kind},
      rules=${JSON.stringify(next.rules)}::jsonb, match=${next.match}, sort=${next.sort}, published=${next.published}
    WHERE account_id=${accountId}::uuid AND id=${current.id}::uuid`.catch(mapSlugError);
  if (changed !== 1) throw new CatalogueError('not_found');
  await setMembers(tx, accountId, current.id, next.productIds);
  await auditCatalogue(tx, accountId, userId, 'commerce.collection_updated', current.id,
    { fields: Object.keys(asBody(raw)).filter((k) => has(asBody(raw), k)) });
  return getCollection(tx, accountId, current.id);
}

export async function deleteCollection(tx: TenantTransaction, accountId: string, userId: string, id: string): Promise<void> {
  if (!isId(id)) throw new CatalogueError('not_found');
  const removed = await tx.$executeRaw`DELETE FROM shop_collections WHERE account_id=${accountId}::uuid AND id=${id}::uuid`;
  if (removed !== 1) throw new CatalogueError('not_found');
  await auditCatalogue(tx, accountId, userId, 'commerce.collection_deleted', id);
}

/** What a draft collection would show: how many products and the first few names (agents and above; nothing is saved). */
export async function previewCollection(tx: TenantTransaction, accountId: string, raw: unknown):
  Promise<{ count: number; sample: Array<{ id: string; name: string }> }> {
  const b = asBody(raw);
  const kind = has(b, 'kind') ? oneOf(b, 'kind', COLLECTION_KINDS) : 'smart';
  const match = has(b, 'match') ? oneOf(b, 'match', COLLECTION_MATCHES) : 'all';
  const rules = kind === 'smart' ? parseRulesField(b.rules) : [];
  let ids: string[];
  if (kind === 'smart') ids = await collectionProductIds(tx, accountId, { kind, rules, match, sort: 'name' });
  else {
    const picked = b.product_ids;
    if (!Array.isArray(picked) || picked.length > MAX_MANUAL_PRODUCTS || !picked.every(isId)) throw new CatalogueError('invalid', 'product_ids');
    ids = (await tx.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT p.id::text AS id FROM shop_products p
      WHERE p.account_id=${accountId}::uuid AND p.id = ANY(${picked as string[]}::uuid[]) AND ${SELLABLE} ORDER BY lower(p.name), p.id`)).map((r) => r.id);
  }
  const sample = ids.length ? await tx.$queryRaw<{ id: string; name: string }[]>`
    SELECT id::text AS id, name FROM shop_products WHERE account_id=${accountId}::uuid AND id = ANY(${ids.slice(0, PREVIEW_SAMPLE)}::uuid[])
    ORDER BY lower(name), id` : [];
  return { count: ids.length, sample };
}
