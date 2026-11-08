import { describe, expect, it } from 'vitest';
import {
  CATALOG_SYNC_INTERVAL_MS,
  CatalogError,
  catalogSyncOffsetMs,
  isMetaPermissionError,
  isTransientCommerceFailure,
  likePattern,
  nextCatalogSyncSlot,
  parseConnectInput,
  parseProductQuery,
  parseSettingsInput,
} from './catalog';
import { MetaApiError } from '@/lib/whatsapp/meta-api';

describe('isTransientCommerceFailure', () => {
  const meta = (code: number | null, httpStatus: number) => new MetaApiError(`Meta API error: ${httpStatus}`, { code, httpStatus });
  it('lets connect continue on unknown or temporary Meta errors only', () => {
    expect(isTransientCommerceFailure(meta(1, 500))).toBe(true);
    expect(isTransientCommerceFailure(meta(2, 400))).toBe(true);
    expect(isTransientCommerceFailure(meta(null, 503))).toBe(true);
    expect(isTransientCommerceFailure(Object.assign(new Error('t'), { name: 'TimeoutError' }))).toBe(true);
    for (const [code, status] of [[10, 403], [200, 400], [190, 401], [100, 400]] as const)
      expect(isTransientCommerceFailure(meta(code, status))).toBe(false);
    expect(isTransientCommerceFailure(new Error('x'))).toBe(false);
  });
});

describe('isMetaPermissionError', () => {
  const meta = (code: number | null) => new MetaApiError('Meta API error: 400', { code, httpStatus: 400 });
  it('treats permission and asset-access refusals as permission errors, not outages', () => {
    for (const code of [10, 3, 200, 275, 299]) expect(isMetaPermissionError(meta(code))).toBe(true);
    for (const code of [1, 2, 100, 190, 300, null]) expect(isMetaPermissionError(meta(code))).toBe(false);
    expect(isMetaPermissionError(new Error('x'))).toBe(false);
  });
});

const NUMBER = '11111111-1111-4111-8111-111111111111';

describe('parseConnectInput', () => {
  it('accepts a number and a numeric Meta catalogue id, defaulting both switches on', () => {
    expect(parseConnectInput({ whatsapp_config_id: NUMBER, catalog_id: ' 1234567890 ' })).toEqual({
      whatsappConfigId: NUMBER, catalogId: '1234567890', isCartEnabled: true, isCatalogVisible: true,
    });
    expect(parseConnectInput({ whatsapp_config_id: NUMBER, catalog_id: '1', is_cart_enabled: false, is_catalog_visible: false }))
      .toMatchObject({ isCartEnabled: false, isCatalogVisible: false });
  });

  it('refuses anything else before Meta is called', () => {
    for (const body of [null, {}, { whatsapp_config_id: 'x', catalog_id: '1' }, { whatsapp_config_id: NUMBER, catalog_id: '12a' },
      { whatsapp_config_id: NUMBER, catalog_id: '1/../2' }, { whatsapp_config_id: NUMBER, catalog_id: '1', is_cart_enabled: 'yes' }]) {
      expect(() => parseConnectInput(body)).toThrow(CatalogError);
    }
    try {
      parseConnectInput({});
    } catch (error) {
      expect((error as CatalogError).status).toBe(400);
      expect((error as CatalogError).code).toBe('invalid_input');
    }
  });
});

describe('parseSettingsInput', () => {
  it('takes either switch and needs at least one', () => {
    expect(parseSettingsInput({ is_cart_enabled: false })).toEqual({ isCartEnabled: false });
    expect(parseSettingsInput({ is_catalog_visible: true, is_cart_enabled: true })).toEqual({ isCartEnabled: true, isCatalogVisible: true });
    expect(() => parseSettingsInput({})).toThrow(CatalogError);
    expect(() => parseSettingsInput({ is_cart_enabled: 1 })).toThrow(CatalogError);
  });
});

describe('parseProductQuery', () => {
  it('reads known filters and clamps paging', () => {
    const q = parseProductQuery(new URLSearchParams(`q=%20shoe%20&availability=in_stock&catalog_id=${NUMBER}&hidden=1&limit=500&offset=-3`));
    expect(q).toEqual({ q: 'shoe', availability: 'in_stock', catalogRowId: NUMBER, whatsappConfigId: undefined, conversationId: undefined,
      includeHidden: true, limit: 100, offset: 0 });
  });

  it('drops unknown or malformed values instead of passing them on', () => {
    const q = parseProductQuery(new URLSearchParams('availability=sold&catalog_id=abc&conversation_id=1;DROP&limit=x'));
    expect(q).toMatchObject({ q: undefined, availability: undefined, catalogRowId: undefined, conversationId: undefined, limit: 50, includeHidden: false });
    expect(parseProductQuery(new URLSearchParams(`q=${'a'.repeat(300)}`)).q).toHaveLength(100);
  });
});

it('escapes LIKE wildcards in a search', () => {
  expect(likePattern('50%_off\\')).toBe('%50\\%\\_off\\\\%');
});

describe('six-hourly sync slots', () => {
  it('spreads catalogues across the cycle and never schedules in the past', () => {
    const a = '22222222-2222-4222-8222-222222222222';
    const b = '33333333-3333-4333-8333-333333333333';
    expect(catalogSyncOffsetMs(a)).not.toBe(catalogSyncOffsetMs(b));
    const now = Date.UTC(2026, 10, 2, 12, 0, 0);
    const next = nextCatalogSyncSlot(a, now);
    expect(next.runAt.getTime()).toBeGreaterThan(now);
    expect(next.runAt.getTime() - now).toBeLessThanOrEqual(CATALOG_SYNC_INTERVAL_MS);
    // The same instant always maps to the same slot, so the dedupe key collapses repeats.
    expect(nextCatalogSyncSlot(a, now + 1000).slot).toBe(next.slot);
    // Running at the slot start schedules the following one.
    expect(nextCatalogSyncSlot(a, next.runAt.getTime()).slot).toBe(next.slot + 1);
  });
});
