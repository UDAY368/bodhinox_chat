/**
 * The public shop's theme editor (store plan Phase 2): a draft of the
 * template, brand settings, sections, menu, footer and store pages; publish;
 * and the last versions to bring back.
 *
 * Browser routes call these with the caller's live session (withTenant, app
 * role): agents read, admins write (RLS and the column grants enforce the
 * same rule). Every draft is validated to the fixed shapes in
 * shop-sections.ts before it is stored. Saving the draft never changes the
 * live shop; publishing copies it into template, theme and document in one
 * transaction, keeps a copy in shop_theme_versions and is audited (version
 * number only). Draft changes are checked against draft_version, so two
 * editors never overwrite each other silently.
 */
import { requireFeature } from '@/lib/billing/entitlements';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { mediaObjectUrl } from '@/lib/storage/client';
import { collectionProductIds, MAX_COLLECTIONS } from './catalogue/collections';
import { readStoredRules, type CollectionKind, type CollectionMatch, type CollectionSort } from './catalogue/collection-rules';
import { loadCategoryTree, loadPolicyFacts, loadProductsWith, type PublicProduct, type ShopPolicyFacts } from './public-shop';
import {
  contentMediaIds, contentOf, parseShopDocument, readShopDocument, type ShopDocument,
} from './shop-sections';
import { ShopThemeError } from './shop-templates';
import { loadCatalogueCategories } from './storefront';
import { StoreError } from './store-settings';

/** Published versions kept for "go back". */
export const THEME_VERSIONS_KEPT = 20;
/** Products the editor's preview draws from. */
export const PREVIEW_PRODUCTS = 60;

export interface ThemeEditorView {
  /** False until the shop's address is saved (Commerce → Online store). */
  ready: boolean;
  draft: ShopDocument;
  draftVersion: number;
  /** The draft differs from the live shop. */
  hasDraft: boolean;
  publishedAt: string | null;
  versions: Array<{ number: number; createdAt: string; publishedBy: string | null }>;
  /** Signed-in URLs for the media library images the draft uses (the preview shows them before they are public). */
  mediaUrls: Record<string, string>;
  preview: {
    handle: string;
    name: string;
    currency: string | null;
    whatsappPhone: string | null;
    products: PublicProduct[];
    /** Categories with products (the categories section). */
    categories: Array<{ id: string; name: string }>;
    /** Every category, for pickers and "featured collection". */
    tree: Array<{ id: string; name: string; parentId: string | null }>;
    /** Every collection (published or not), for "featured collection" sections and links. */
    collections: Array<{ id: string; title: string; slug: string; published: boolean; productIds: string[] }>;
    facts: ShopPolicyFacts;
  };
}

interface Row {
  handle: string; template: string; theme: unknown; document: unknown; draft: unknown; draft_version: number;
  published_at: Date | null; whatsapp_phone: string | null;
}

async function loadRow(tx: TenantTransaction, accountId: string, lock = false): Promise<Row | null> {
  const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT handle, template, theme, document, draft, draft_version, published_at, whatsapp_phone
    FROM shop_storefronts WHERE account_id=$1::uuid${lock ? ' FOR UPDATE' : ''}`, accountId);
  return rows[0] ?? null;
}

const documentOf = (row: Row): ShopDocument => readShopDocument(row.draft, { template: row.template, theme: row.theme, document: row.document });

/** Every media id a draft names, hidden sections included (the editor shows them). */
function draftMediaIds(doc: ShopDocument): string[] {
  return contentMediaIds(doc.theme, { ...contentOf(doc), sections: doc.sections.map((s) => ({ ...s, hidden: false })) });
}

export async function getThemeEditor(ctx: TenantContext): Promise<ThemeEditorView> {
  return withTenant(ctx, async (tx) => {
    await requireFeature(tx, ctx.accountId, 'storefront');
    const row = await loadRow(tx, ctx.accountId);
    const draft = row ? documentOf(row) : readShopDocument(null, { template: 'wellness', theme: {}, document: {} });
    const ids = draftMediaIds(draft);
    const media = ids.length ? await tx.$queryRaw<{ id: string; bucket: string; object_key: string }[]>`
      SELECT id::text AS id, bucket, object_key FROM media_objects
      WHERE account_id=${ctx.accountId}::uuid AND id = ANY(${ids}::uuid[]) AND deleted_at IS NULL` : [];
    const versions = row ? await tx.$queryRaw<{ number: number; created_at: Date; full_name: string | null }[]>`
      SELECT v.number, v.created_at, (SELECT p.full_name FROM profiles p WHERE p.user_id=v.published_by AND p.account_id=v.account_id LIMIT 1) AS full_name
      FROM shop_theme_versions v
      WHERE v.account_id=${ctx.accountId}::uuid ORDER BY v.number DESC LIMIT ${THEME_VERSIONS_KEPT}` : [];
    const [account] = await tx.$queryRaw<{ name: string; title: string | null; currency: string | null }[]>`
      SELECT a.name, s.storefront_title AS title, s.currency FROM accounts a
      LEFT JOIN commerce_settings s ON s.account_id=a.id WHERE a.id=${ctx.accountId}::uuid`;
    const [products, categories, tree, names, facts] = await Promise.all([
      loadProductsWith(tx, ctx.accountId, { limit: PREVIEW_PRODUCTS },
        (image) => image.url ?? (image.bucket && image.object_key ? mediaObjectUrl(image.bucket, image.object_key) : null)),
      loadCatalogueCategories(tx, ctx.accountId),
      loadCategoryTree(tx, ctx.accountId),
      tx.$queryRaw<{ id: string; name: string }[]>`SELECT id::text AS id, name FROM shop_categories
        WHERE account_id=${ctx.accountId}::uuid AND archived_at IS NULL ORDER BY position, name LIMIT 500`,
      loadPolicyFacts(tx, ctx.accountId),
    ]);
    const nameOf = new Map(names.map((n) => [n.id, n.name]));
    const collectionRows = await tx.$queryRaw<{ id: string; title: string; slug: string; published: boolean; kind: CollectionKind; rules: unknown;
      match: CollectionMatch; sort: CollectionSort }[]>`
      SELECT id::text AS id, title, slug, published, kind, rules, match, sort FROM shop_collections
      WHERE account_id=${ctx.accountId}::uuid ORDER BY lower(title), id LIMIT ${MAX_COLLECTIONS}`;
    const collections: ThemeEditorView['preview']['collections'] = [];
    for (const c of collectionRows) {
      collections.push({ id: c.id, title: c.title, slug: c.slug, published: c.published,
        productIds: await collectionProductIds(tx, ctx.accountId, { id: c.id, kind: c.kind, rules: readStoredRules(c.rules), match: c.match, sort: c.sort }, PREVIEW_PRODUCTS) });
    }
    return {
      ready: !!row, draft, draftVersion: row?.draft_version ?? 0, hasDraft: !!row?.draft,
      publishedAt: row?.published_at?.toISOString() ?? null,
      versions: versions.map((v) => ({ number: v.number, createdAt: v.created_at.toISOString(), publishedBy: v.full_name })),
      mediaUrls: Object.fromEntries(media.map((m) => [m.id, mediaObjectUrl(m.bucket, m.object_key)])),
      preview: {
        handle: row?.handle ?? 'preview', name: account?.title || account?.name || '', currency: account?.currency ?? null,
        whatsappPhone: row?.whatsapp_phone ?? null, products, categories,
        tree: tree.map((c) => ({ ...c, name: nameOf.get(c.id) ?? '' })), collections, facts,
      },
    };
  });
}

/** Validate the editor's draft. Throws StoreError('invalid', { field }). */
export function parseDraftInput(body: unknown): { expectedDraftVersion: number; document: ShopDocument } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const expectedDraftVersion = parseVersion(b.expectedDraftVersion);
  try {
    return { expectedDraftVersion, document: parseShopDocument(b.document) };
  } catch (error) {
    if (error instanceof ShopThemeError) throw new StoreError('invalid', { field: error.field });
    throw error;
  }
}

function parseVersion(value: unknown): number {
  if (!Number.isInteger(value) || (value as number) < 0) throw new StoreError('invalid', { field: 'expectedDraftVersion' });
  return value as number;
}

export type ThemeAction =
  | { action: 'publish'; expectedDraftVersion: number }
  | { action: 'discard'; expectedDraftVersion: number }
  | { action: 'restore'; expectedDraftVersion: number; number: number };

export function parseThemeAction(body: unknown): ThemeAction {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  const expectedDraftVersion = parseVersion(b.expectedDraftVersion);
  if (b.action === 'publish' || b.action === 'discard') return { action: b.action, expectedDraftVersion };
  if (b.action === 'restore') {
    if (!Number.isInteger(b.number) || (b.number as number) < 1) throw new StoreError('invalid', { field: 'number' });
    return { action: 'restore', expectedDraftVersion, number: b.number as number };
  }
  throw new StoreError('invalid', { field: 'action' });
}

/** Lock the shop row and check the editor saw the latest draft. */
async function lockForDraft(tx: TenantTransaction, accountId: string, expected: number): Promise<Row> {
  await requireFeature(tx, accountId, 'storefront');
  const row = await loadRow(tx, accountId, true);
  if (!row) throw new StoreError('shop_not_set_up');
  if (row.draft_version !== expected) throw new StoreError('conflict');
  return row;
}

async function audit(tx: TenantTransaction, ctx: TenantContext & { userId: string }, action: string, metadata: Record<string, unknown>) {
  await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
    VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,${action},${ctx.accountId},${JSON.stringify(metadata)}::jsonb)`;
}

/** Save the draft (admins). The live shop does not change. */
export async function saveThemeDraft(ctx: TenantContext & { userId: string }, input: { expectedDraftVersion: number; document: ShopDocument }) {
  await withTenant(ctx, async (tx) => {
    await lockForDraft(tx, ctx.accountId, input.expectedDraftVersion);
    await tx.$executeRaw`UPDATE shop_storefronts SET draft=${JSON.stringify(input.document)}::jsonb, draft_version=draft_version+1
      WHERE account_id=${ctx.accountId}::uuid`;
  });
  return getThemeEditor(ctx);
}

/** Publish, discard the draft, or bring an older version back into the draft (admins). */
export async function runThemeAction(ctx: TenantContext & { userId: string }, input: ThemeAction) {
  await withTenant(ctx, async (tx) => {
    const row = await lockForDraft(tx, ctx.accountId, input.expectedDraftVersion);
    if (input.action === 'discard') {
      await tx.$executeRaw`UPDATE shop_storefronts SET draft=NULL, draft_version=draft_version+1 WHERE account_id=${ctx.accountId}::uuid`;
      return;
    }
    if (input.action === 'restore') {
      const [version] = await tx.$queryRaw<{ template: string; theme: unknown; document: unknown }[]>`
        SELECT template, theme, document FROM shop_theme_versions WHERE account_id=${ctx.accountId}::uuid AND number=${input.number}`;
      if (!version) throw new StoreError('not_found');
      const doc = readShopDocument(null, version);
      await tx.$executeRaw`UPDATE shop_storefronts SET draft=${JSON.stringify(doc)}::jsonb, draft_version=draft_version+1
        WHERE account_id=${ctx.accountId}::uuid`;
      await audit(tx, ctx, 'commerce.shop_theme_restored', { number: input.number });
      return;
    }
    if (!row.draft) throw new StoreError('no_draft');
    // Validated again: a draft stored by an older build must still fit today's shapes.
    let doc: ShopDocument;
    try {
      doc = parseShopDocument(row.draft);
    } catch (error) {
      if (error instanceof ShopThemeError) throw new StoreError('invalid', { field: error.field });
      throw error;
    }
    const content = JSON.stringify(contentOf(doc));
    const theme = JSON.stringify(doc.theme);
    const [{ next }] = await tx.$queryRaw<{ next: number }[]>`SELECT COALESCE(MAX(number),0)+1 AS next FROM shop_theme_versions
      WHERE account_id=${ctx.accountId}::uuid`;
    await tx.$executeRaw`INSERT INTO shop_theme_versions(account_id,number,template,theme,document,published_by)
      VALUES(${ctx.accountId}::uuid,${next},${doc.template},${theme}::jsonb,${content}::jsonb,${ctx.userId}::uuid)`;
    await tx.$executeRaw`UPDATE shop_storefronts SET template=${doc.template}, theme=${theme}::jsonb, document=${content}::jsonb, draft=NULL,
      draft_version=draft_version+1, version=version+1, published_at=now() WHERE account_id=${ctx.accountId}::uuid`;
    await tx.$executeRaw`DELETE FROM shop_theme_versions WHERE account_id=${ctx.accountId}::uuid AND number <= ${next - THEME_VERSIONS_KEPT}`;
    await audit(tx, ctx, 'commerce.shop_theme_published', { number: next, sections: doc.sections.length });
  });
  return getThemeEditor(ctx);
}

