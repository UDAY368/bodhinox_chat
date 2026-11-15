/**
 * Admin side of the public shop (store plan Phase 1): the shop's address,
 * template, brand settings and how buyers order, plus the setup checklist.
 * Browser routes call these with the caller's live session (withTenant, app
 * role): agents read, admins write (RLS and the column grants enforce the
 * same rule). Changes are version-checked and audited with field names only.
 */
import { requireFeature } from '@/lib/billing/entitlements';
import { appOrigin } from '@/lib/auth/csrf';
import { withTenant, type TenantContext, type TenantTransaction } from '@/lib/db/tenant';
import { isUniqueViolation } from './returns';
import {
  isShopTemplateId, normaliseHandle, parseThemeSettings, PUBLIC_SHOP_PATH, readThemeSettings, ShopThemeError, suggestHandle,
  type ShopTemplateId, type ShopThemeSettings,
} from './shop-templates';
import { isUuid, onlinePaymentReady, StoreError } from './store-settings';

export interface ShopSiteSettings {
  /** False until the first save: the values are suggestions. */
  saved: boolean;
  handle: string;
  published: boolean;
  template: ShopTemplateId;
  theme: ShopThemeSettings;
  whatsappConfigId: string | null;
  whatsappPhone: string | null;
  otpTemplateId: string | null;
  version: number;
  url: string;
}

export type ChecklistKey = 'settings' | 'product' | 'template' | 'payments' | 'shipping' | 'checkout' | 'ordering' | 'published';
export interface ChecklistItem { key: ChecklistKey; done: boolean; href: string }

export interface ShopSiteView {
  site: ShopSiteSettings;
  checklist: ChecklistItem[];
  numbers: Array<{ id: string; name: string | null; wabaId: string | null; connected: boolean }>;
  otpTemplates: Array<{ id: string; name: string; language: string | null; wabaId: string | null }>;
}

interface Row {
  handle: string; published: boolean; template: string; theme: unknown; whatsapp_config_id: string | null;
  whatsapp_phone: string | null; otp_template_id: string | null; version: number;
}

const shopUrl = (handle: string) => `${appOrigin()}${PUBLIC_SHOP_PATH}${handle}`;

async function loadRow(tx: TenantTransaction, accountId: string, lock = false): Promise<Row | null> {
  const rows = await tx.$queryRawUnsafe<Row[]>(`SELECT handle, published, template, theme, whatsapp_config_id::text AS whatsapp_config_id,
    whatsapp_phone, otp_template_id::text AS otp_template_id, version FROM shop_storefronts WHERE account_id=$1::uuid${lock ? ' FOR UPDATE' : ''}`,
  accountId);
  return rows[0] ?? null;
}

async function siteOf(tx: TenantTransaction, accountId: string): Promise<ShopSiteSettings> {
  const row = await loadRow(tx, accountId);
  if (row) return {
    saved: true, handle: row.handle, published: row.published, template: isShopTemplateId(row.template) ? row.template : 'wellness',
    theme: readThemeSettings(row.theme), whatsappConfigId: row.whatsapp_config_id, whatsappPhone: row.whatsapp_phone,
    otpTemplateId: row.otp_template_id, version: row.version, url: shopUrl(row.handle),
  };
  const [account] = await tx.$queryRaw<{ name: string }[]>`SELECT name FROM accounts WHERE id=${accountId}::uuid`;
  const handle = suggestHandle(account?.name ?? '');
  return {
    saved: false, handle, published: false, template: 'wellness', theme: readThemeSettings({}), whatsappConfigId: null,
    whatsappPhone: null, otpTemplateId: null, version: 0, url: shopUrl(handle),
  };
}

export async function checklistOf(tx: TenantTransaction, accountId: string, site: ShopSiteSettings): Promise<ChecklistItem[]> {
  const [row] = await tx.$queryRaw<{ settings: boolean; checkout: boolean; cod: boolean; product: boolean; shipping: boolean }[]>`SELECT
    EXISTS (SELECT 1 FROM commerce_settings WHERE account_id=${accountId}::uuid) AS settings,
    COALESCE((SELECT checkout_enabled FROM commerce_settings WHERE account_id=${accountId}::uuid), false) AS checkout,
    COALESCE((SELECT cod_enabled FROM commerce_settings WHERE account_id=${accountId}::uuid), false) AS cod,
    EXISTS (SELECT 1 FROM shop_products p WHERE p.account_id=${accountId}::uuid AND p.status='published'
      AND EXISTS (SELECT 1 FROM shop_variants v WHERE v.account_id=p.account_id AND v.product_id=p.id AND v.archived_at IS NULL
        AND v.price_minor IS NOT NULL)) AS product,
    EXISTS (SELECT 1 FROM shipping_rates WHERE account_id=${accountId}::uuid AND active) AS shipping`;
  const online = await onlinePaymentReady(tx, accountId);
  const ordering = !!site.whatsappConfigId && (!!site.otpTemplateId || !!site.whatsappPhone);
  return [
    { key: 'settings', done: !!row?.settings, href: '/commerce/settings' },
    { key: 'product', done: !!row?.product, href: '/commerce/catalogue' },
    { key: 'template', done: site.saved, href: '/commerce/store/editor' },
    { key: 'payments', done: online || !!row?.cod, href: '/commerce/payments' },
    { key: 'shipping', done: !!row?.shipping, href: '/commerce/settings' },
    { key: 'checkout', done: !!row?.checkout, href: '/commerce/settings' },
    { key: 'ordering', done: ordering, href: '#ordering' },
    { key: 'published', done: site.saved && site.published, href: '#publish' },
  ];
}

export async function getShopSite(ctx: TenantContext): Promise<ShopSiteView> {
  return withTenant(ctx, async (tx) => {
    await requireFeature(tx, ctx.accountId, 'storefront');
    const site = await siteOf(tx, ctx.accountId);
    // Never the access token: status alone says whether the number can send.
    const numbers = await tx.$queryRaw<{ id: string; display_name: string | null; waba_id: string | null; status: string }[]>`
      SELECT id::text AS id, display_name, waba_id, status FROM whatsapp_config
      WHERE account_id=${ctx.accountId}::uuid ORDER BY is_default DESC, created_at, id LIMIT 50`;
    const templates = await tx.$queryRaw<{ id: string; name: string; language: string | null; waba_id: string | null }[]>`
      SELECT id::text AS id, name, language, waba_id FROM message_templates
      WHERE account_id=${ctx.accountId}::uuid AND template_kind='authentication' AND upper(coalesce(status,''))='APPROVED'
      ORDER BY name, language LIMIT 100`;
    return {
      site, checklist: await checklistOf(tx, ctx.accountId, site),
      numbers: numbers.map((n) => ({ id: n.id, name: n.display_name, wabaId: n.waba_id, connected: n.status !== 'disconnected' })),
      otpTemplates: templates.map((t) => ({ id: t.id, name: t.name, language: t.language, wabaId: t.waba_id })),
    };
  });
}

export interface ShopSiteInput {
  expectedVersion: number;
  handle: string;
  published: boolean;
  /** Absent: unchanged. The theme editor (shop-theme.ts) publishes template and brand changes through its draft. */
  template?: ShopTemplateId;
  theme?: ShopThemeSettings;
  whatsappConfigId: string | null;
  whatsappPhone: string | null;
  otpTemplateId: string | null;
}

/** Validate the admin form. Throws StoreError('invalid', { field }) or ('invalid_handle'). */
export function parseShopSiteInput(body: unknown): ShopSiteInput {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new StoreError('invalid');
  const b = body as Record<string, unknown>;
  if (!Number.isInteger(b.expectedVersion) || (b.expectedVersion as number) < 0) throw new StoreError('invalid', { field: 'expectedVersion' });
  const handle = normaliseHandle(b.handle);
  if (!handle) throw new StoreError('invalid_handle', { field: 'handle' });
  if (typeof b.published !== 'boolean') throw new StoreError('invalid', { field: 'published' });
  if (b.template !== undefined && !isShopTemplateId(b.template)) throw new StoreError('invalid', { field: 'template' });
  let theme: ShopThemeSettings | undefined;
  try {
    theme = b.theme === undefined ? undefined : parseThemeSettings(b.theme);
  } catch (error) {
    if (error instanceof ShopThemeError) throw new StoreError('invalid', { field: `theme.${error.field}` });
    throw error;
  }
  const optionalId = (value: unknown, field: string): string | null => {
    if (value === null || value === undefined || value === '') return null;
    if (!isUuid(value)) throw new StoreError('invalid', { field });
    return value;
  };
  let whatsappPhone: string | null = null;
  if (b.whatsappPhone !== null && b.whatsappPhone !== undefined && b.whatsappPhone !== '') {
    const digits = typeof b.whatsappPhone === 'string' ? b.whatsappPhone.replace(/[\s()+.-]/g, '') : '';
    if (!/^[1-9][0-9]{7,14}$/.test(digits)) throw new StoreError('invalid', { field: 'whatsappPhone' });
    whatsappPhone = digits;
  }
  return {
    expectedVersion: b.expectedVersion as number, handle, published: b.published, template: b.template as ShopTemplateId | undefined, theme,
    whatsappConfigId: optionalId(b.whatsappConfigId, 'whatsappConfigId'), whatsappPhone,
    otpTemplateId: optionalId(b.otpTemplateId, 'otpTemplateId'),
  };
}

/** Save (admins). Version-checked: expectedVersion 0 creates the shop. */
export async function saveShopSite(ctx: TenantContext & { userId: string }, input: ShopSiteInput): Promise<ShopSiteView> {
  try {
    await withTenant(ctx, async (tx) => {
      await requireFeature(tx, ctx.accountId, 'storefront');
      const current = await loadRow(tx, ctx.accountId, true);
      if ((current?.version ?? 0) !== input.expectedVersion) throw new StoreError('conflict');
      let wabaId: string | null = null;
      if (input.whatsappConfigId) {
        const [number] = await tx.$queryRaw<{ waba_id: string | null }[]>`SELECT waba_id FROM whatsapp_config
          WHERE account_id=${ctx.accountId}::uuid AND id=${input.whatsappConfigId}::uuid`;
        if (!number) throw new StoreError('invalid', { field: 'whatsappConfigId' });
        wabaId = number.waba_id;
      }
      if (input.otpTemplateId) {
        if (!input.whatsappConfigId) throw new StoreError('invalid', { field: 'otpTemplateId' });
        const [template] = await tx.$queryRaw<{ kind: string; status: string | null; waba_id: string | null }[]>`
          SELECT template_kind AS kind, status, waba_id FROM message_templates
          WHERE account_id=${ctx.accountId}::uuid AND id=${input.otpTemplateId}::uuid`;
        // An authentication template on the chosen number's WABA (a template of another WABA is refused by Meta).
        if (!template || template.kind !== 'authentication' || (template.waba_id && wabaId && template.waba_id !== wabaId))
          throw new StoreError('invalid', { field: 'otpTemplateId' });
      }
      const template = input.template ?? (current && isShopTemplateId(current.template) ? current.template : 'wellness');
      const themeValue = input.theme ?? (current ? readThemeSettings(current.theme) : readThemeSettings({}));
      const theme = JSON.stringify(themeValue);
      if (!current)
        await tx.$executeRaw`INSERT INTO shop_storefronts(account_id,handle,published,template,theme,whatsapp_config_id,whatsapp_phone,otp_template_id)
          VALUES(${ctx.accountId}::uuid,${input.handle},${input.published},${template},${theme}::jsonb,${input.whatsappConfigId}::uuid,
            ${input.whatsappPhone},${input.otpTemplateId}::uuid)`;
      else
        await tx.$executeRaw`UPDATE shop_storefronts SET handle=${input.handle}, published=${input.published}, template=${template},
          theme=${theme}::jsonb, whatsapp_config_id=${input.whatsappConfigId}::uuid, whatsapp_phone=${input.whatsappPhone},
          otp_template_id=${input.otpTemplateId}::uuid, version=version+1 WHERE account_id=${ctx.accountId}::uuid`;
      const fields = !current ? ['created'] : (['handle', 'published', 'template', 'theme', 'whatsapp_config_id', 'whatsapp_phone', 'otp_template_id'] as const)
        .filter((k) => {
          const next = { handle: input.handle, published: input.published, template, theme: themeValue,
            whatsapp_config_id: input.whatsappConfigId, whatsapp_phone: input.whatsappPhone, otp_template_id: input.otpTemplateId }[k];
          return JSON.stringify(next) !== JSON.stringify(k === 'theme' ? readThemeSettings(current.theme) : current[k]);
        });
      await tx.$executeRaw`INSERT INTO audit_logs(account_id,user_id,action,resource_id,metadata)
        VALUES(${ctx.accountId}::uuid,${ctx.userId}::uuid,'commerce.shop_site_updated',${ctx.accountId},${JSON.stringify({ fields })}::jsonb)`;
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw new StoreError('handle_taken', { field: 'handle' });
    throw error;
  }
  return getShopSite(ctx);
}
