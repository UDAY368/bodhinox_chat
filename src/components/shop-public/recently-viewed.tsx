'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { PublicProduct } from '@/lib/commerce/public-shop';
import type { ShopLayout } from '@/lib/commerce/shop-templates';
import { ProductCard, ProductGrid } from './product-card';

/**
 * Recently viewed products, kept only in the visitor's browser: product ids
 * per shop in localStorage (newest first, at most 12). Storage may be blocked
 * (private windows); every read and write is guarded and then nothing shows.
 */
export const RECENT_MAX = 12;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const key = (handle: string) => `bodhinox-recent:${handle}`;

export function readRecent(handle: string): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(key(handle)) ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && UUID.test(id)).slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

export function rememberViewed(handle: string, productId: string): void {
  if (!UUID.test(productId)) return;
  try {
    window.localStorage.setItem(key(handle), JSON.stringify([productId, ...readRecent(handle).filter((id) => id !== productId)].slice(0, RECENT_MAX)));
  } catch { /* storage blocked: nothing remembered */ }
}

/** Put this on the product page: it records the product as viewed (renders nothing). */
export function RecordRecentlyViewed({ handle, productId }: { handle: string; productId: string }) {
  useEffect(() => { rememberViewed(handle, productId); }, [handle, productId]);
  return null;
}

export interface RecentLabels { soldOut: string; from: string; add: string; added: string; /** With "{percent}" in it. */ sale: string }

/**
 * The home page's "Recently viewed" section. Fetches the cards for the ids in
 * the browser (only this shop's published products come back) and shows
 * nothing when there are none. `preview` (the theme editor) shows `sample` instead.
 */
export function RecentlyViewed({ handle, limit, layout, currency, locale, labels, title, preview = false, sample = [] }: {
  handle: string; limit: number; layout: ShopLayout; currency: string | null; locale: string; labels: RecentLabels; title: ReactNode;
  preview?: boolean; sample?: PublicProduct[];
}) {
  const [products, setProducts] = useState<PublicProduct[]>(preview ? sample.slice(0, limit) : []);
  useEffect(() => {
    if (preview) return;
    const ids = readRecent(handle).slice(0, limit);
    if (!ids.length) return;
    const controller = new AbortController();
    fetch(`/api/public/store/${handle}/products?ids=${ids.join(',')}`, { signal: controller.signal, cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { products?: PublicProduct[] } | null) => { if (Array.isArray(data?.products)) setProducts(data.products.slice(0, limit)); })
      .catch(() => { /* a section that cannot load stays hidden */ });
    return () => controller.abort();
  }, [handle, limit, preview]);
  if (!products.length) return null;
  const cardLabels = { ...labels, sale: (percent: number) => labels.sale.replace('{percent}', String(percent)) };
  return (
    <section className="flex flex-col gap-3">
      {title}
      <ProductGrid columns={layout.columns}>
        {products.map((p) => <ProductCard key={p.id} handle={handle} product={p} currency={currency} layout={layout} locale={locale} labels={cardLabels} />)}
      </ProductGrid>
    </section>
  );
}
