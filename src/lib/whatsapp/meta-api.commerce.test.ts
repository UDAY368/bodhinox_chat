import { afterEach, expect, it, vi } from 'vitest';
import {
  getCatalogProducts,
  getWabaCatalogs,
  MetaApiError,
  sendCatalogMessage,
  sendProductListMessage,
  sendProductMessage,
  setCommerceSettings,
} from './meta-api';

const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as Response;
const sent = { messages: [{ id: 'wamid.X' }] };
afterEach(() => vi.unstubAllGlobals());
const base = { phoneNumberId: '111', accessToken: 'TOKEN', to: '919800000000' };
const bodyOf = (fetch: ReturnType<typeof vi.fn>, call = 0) =>
  JSON.parse(String((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body));

it('pages through catalogue products and stops when Meta has no next page', async () => {
  const fetch = vi.fn()
    .mockResolvedValueOnce(json({
      data: [{ id: '1', retailer_id: 'SKU1', name: 'Tea', price: '₹120.00', currency: 'INR', visibility: 'published' }, { id: 'bad' }],
      paging: { cursors: { after: 'CUR' }, next: 'https://graph.facebook.com/next' },
    }))
    .mockResolvedValueOnce(json({ data: [{ id: '2', retailer_id: 'SKU2', name: 'Cup' }], paging: { cursors: { after: 'END' } } }));
  vi.stubGlobal('fetch', fetch);
  const first = await getCatalogProducts({ catalogId: '555', accessToken: 'TOKEN' });
  expect(first.products.map((p) => p.retailer_id)).toEqual(['SKU1']);
  expect(first.after).toBe('CUR');
  const url = new URL((fetch.mock.calls[0] as unknown as [string])[0]);
  expect(url.pathname).toMatch(/\/555\/products$/);
  expect(url.searchParams.get('fields')).toBe('id,retailer_id,name,description,price,currency,image_url,url,availability,visibility');
  expect(url.searchParams.get('limit')).toBe('100');
  // The token goes in the header, never the URL.
  expect(url.toString()).not.toContain('TOKEN');
  const second = await getCatalogProducts({ catalogId: '555', accessToken: 'TOKEN', after: 'CUR' });
  expect(new URL((fetch.mock.calls[1] as unknown as [string])[0]).searchParams.get('after')).toBe('CUR');
  expect(second.after).toBeNull();
  await expect(getCatalogProducts({ catalogId: '../me', accessToken: 'T' })).rejects.toThrow();
});

it('lists WABA catalogues and surfaces Meta errors', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ data: [{ id: '9', name: 'Main' }, { name: 'no id' }] })));
  expect(await getWabaCatalogs({ wabaId: '42', accessToken: 'T' })).toEqual([{ id: '9', name: 'Main' }]);
  vi.stubGlobal('fetch', vi.fn(async () => json({ error: { message: 'no permission', code: 10 } }, 403)));
  await expect(getWabaCatalogs({ wabaId: '42', accessToken: 'T' })).rejects.toBeInstanceOf(MetaApiError);
});

it('sets commerce settings on the number', async () => {
  const fetch = vi.fn(async () => json({ success: true }));
  vi.stubGlobal('fetch', fetch);
  await setCommerceSettings({ phoneNumberId: '111', accessToken: 'T', isCatalogVisible: true, isCartEnabled: false });
  const [raw, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  const url = new URL(raw);
  expect(url.pathname).toMatch(/\/111\/whatsapp_commerce_settings$/);
  expect(Object.fromEntries(url.searchParams)).toEqual({ is_catalog_visible: 'true', is_cart_enabled: 'false' });
  expect(init.method).toBe('POST');
});

it('sends a single product', async () => {
  const fetch = vi.fn(async () => json(sent));
  vi.stubGlobal('fetch', fetch);
  expect(await sendProductMessage({ ...base, catalogId: '555', productRetailerId: 'SKU1', bodyText: 'Try this' })).toEqual({ messageId: 'wamid.X' });
  expect(bodyOf(fetch)).toEqual({
    messaging_product: 'whatsapp', recipient_type: 'individual', to: '919800000000', type: 'interactive',
    interactive: { type: 'product', body: { text: 'Try this' }, action: { catalog_id: '555', product_retailer_id: 'SKU1' } },
  });
  await expect(sendProductMessage({ ...base, catalogId: '555', productRetailerId: ' ' })).rejects.toThrow();
});

it('sends a product list within Meta limits', async () => {
  const fetch = vi.fn(async () => json(sent));
  vi.stubGlobal('fetch', fetch);
  await sendProductListMessage({
    ...base, catalogId: '555', headerText: 'Menu', bodyText: 'Pick one', footerText: 'Thanks',
    sections: [{ title: 'Hot', productRetailerIds: ['A', 'B'] }, { title: 'Cold', productRetailerIds: ['C'] }],
  });
  expect(bodyOf(fetch).interactive).toEqual({
    type: 'product_list', header: { type: 'text', text: 'Menu' }, body: { text: 'Pick one' }, footer: { text: 'Thanks' },
    action: { catalog_id: '555', sections: [
      { title: 'Hot', product_items: [{ product_retailer_id: 'A' }, { product_retailer_id: 'B' }] },
      { title: 'Cold', product_items: [{ product_retailer_id: 'C' }] },
    ] },
  });
  const ok = { ...base, catalogId: '555', headerText: 'Menu', bodyText: 'Pick' };
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);
  await expect(sendProductListMessage({ ...ok, sections: [{ title: 'A', productRetailerIds: ids(31) }] })).rejects.toThrow();
  await expect(sendProductListMessage({ ...ok, sections: ids(11).map((id) => ({ title: id, productRetailerIds: [id] })) })).rejects.toThrow();
  await expect(sendProductListMessage({ ...ok, sections: [{ title: '', productRetailerIds: ['A'] }, { title: 'B', productRetailerIds: ['B'] }] })).rejects.toThrow();
  await expect(sendProductListMessage({ ...ok, headerText: '', sections: [{ title: 'A', productRetailerIds: ['A'] }] })).rejects.toThrow();
  await expect(sendProductListMessage({ ...ok, sections: [] })).rejects.toThrow();
  // Nothing invalid reached Meta.
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('sends the catalogue with an optional thumbnail', async () => {
  const fetch = vi.fn(async () => json(sent));
  vi.stubGlobal('fetch', fetch);
  await sendCatalogMessage({ ...base, bodyText: 'Browse', thumbnailProductRetailerId: 'SKU1' });
  expect(bodyOf(fetch).interactive).toEqual({
    type: 'catalog_message', body: { text: 'Browse' },
    action: { name: 'catalog_message', parameters: { thumbnail_product_retailer_id: 'SKU1' } },
  });
  await sendCatalogMessage({ ...base, bodyText: 'Browse' });
  expect(bodyOf(fetch, 1).interactive.action).toEqual({ name: 'catalog_message' });
  await expect(sendCatalogMessage({ ...base, bodyText: '' })).rejects.toThrow();
});
