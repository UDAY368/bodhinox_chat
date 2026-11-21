'use client';

/**
 * The staff storefront link (/shop/<token>, design §6): the product grid with
 * a name search, category chips and "Show more" paging, then the checkout
 * (checkout-panel.tsx: cart, address, summary and "Place order"). The public
 * shop has its own themed checkout without a grid (shop-checkout.tsx).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Heart, Loader2, Plus, Search, ShoppingBag } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { shopApi, type StorefrontProduct, type StorefrontView } from './api';
import { CheckoutLoadState, CheckoutPanel, useCheckoutSession } from './checkout-panel';
import { money } from './order-summary';

export function Storefront({ token }: { token: string }) {
  const t = useTranslations('Storefront');
  const locale = useLocale();
  const [picked, setPicked] = useState<Record<string, string>>({});
  // The catalogue is paged and searched on its own (GET …/products): set from the first view only, so a cart
  // change never resets the pages the customer already loaded.
  const [products, setProducts] = useState<StorefrontProduct[] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  // From the first view only (change answers carry no catalogue): the category chips and whether to offer search.
  const [categories, setCategories] = useState<StorefrontView['categories']>([]);
  const [manyProducts, setManyProducts] = useState(false);
  // Every product seen on any page or search, so a cart line keeps its name after the list is filtered.
  const [seen, setSeen] = useState<ReadonlyMap<string, StorefrontProduct>>(new Map());
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [catalogueBusy, setCatalogueBusy] = useState(false);
  const [catalogueFailed, setCatalogueFailed] = useState(false);
  const catalogueTicket = useRef(0);
  const filtered = useRef(false);
  const catalogueSeeded = useRef(false);

  const remember = useCallback((list: readonly StorefrontProduct[]) => {
    if (list.length) setSeen((current) => new Map([...current, ...list.map((p) => [p.id, p] as const)]));
  }, []);

  // The first view (GET, with the catalogue) seeds it; answers to changes carry none.
  const session = useCheckoutSession(token, useCallback((next: StorefrontView) => {
    if (catalogueSeeded.current) return;
    catalogueSeeded.current = true;
    setProducts(next.products);
    setNextCursor(next.productsNext);
    setCategories(next.categories);
    setManyProducts(next.productsNext !== null);
    remember(next.products);
  }, [remember]));
  const { view, busy, wishlist, toggleSaved, setQty } = session;

  const fetchProducts = useCallback(async (filter: { q: string; category: string | null }, cursor: string | null) => {
    const ticket = ++catalogueTicket.current;
    setCatalogueBusy(true);
    setCatalogueFailed(false);
    try {
      const page = await shopApi.products(token, { ...filter, cursor });
      if (ticket !== catalogueTicket.current) return;
      setProducts((current) => (cursor ? [...(current ?? []), ...page.products] : page.products));
      remember(page.products);
      setNextCursor(page.nextCursor);
    } catch {
      if (ticket === catalogueTicket.current) setCatalogueFailed(true);
    } finally {
      if (ticket === catalogueTicket.current) setCatalogueBusy(false);
    }
  }, [token, remember]);

  // A new search or category starts again from the first page (the search waits for a pause in typing).
  useEffect(() => {
    if (!filtered.current) return;
    const timer = setTimeout(() => void fetchProducts({ q: search, category }, null), 300);
    return () => clearTimeout(timer);
  }, [search, category, fetchProducts]);
  const changeFilter = (next: { search?: string; category?: string | null }) => {
    filtered.current = true;
    if (next.search !== undefined) setSearch(next.search);
    if (next.category !== undefined) setCategory(next.category);
  };

  const variantInfo = useMemo(() => {
    const map = new Map<string, { productName: string; options: string }>();
    for (const p of seen.values())
      for (const v of p.variants) map.set(v.id, { productName: p.name, options: Object.values(v.options).join(' / ') });
    return map;
  }, [seen]);

  if (!view || session.loadState !== 'ready') return <CheckoutLoadState session={session} />;

  const currency = view.store.currency ?? 'INR';
  const title = view.store.title || view.store.businessName;
  const cart = view.cart;
  const grid = (
    <>
      {view.purpose === 'shop' && (
        <section aria-label={t('productsHeading')} className="space-y-3">
          {(manyProducts || categories.length > 1 || search || category) && (
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
                <Input type="search" value={search} maxLength={80} placeholder={t('searchProducts')} aria-label={t('searchProducts')}
                  className="pl-8" onChange={(e) => changeFilter({ search: e.target.value })} />
              </div>
              {categories.length > 1 && (
                <div className="flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label={t('categories')}>
                  {[{ id: null, name: t('allCategories') }, ...categories].map((c) => (
                    <Button key={c.id ?? 'all'} type="button" size="sm" variant={category === c.id ? 'secondary' : 'ghost'}
                      aria-pressed={category === c.id} className="shrink-0" onClick={() => changeFilter({ category: c.id })}>
                      {c.name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
          {catalogueFailed && <p className="text-sm text-destructive" role="alert">{t('errors.error')}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
          {(products ?? []).length === 0 && !catalogueBusy && (
            <p className="text-sm text-muted-foreground">{search || category ? t('noMatchingProducts') : t('noProducts')}</p>
          )}
          {(products ?? []).map((p) => {
            const chosen = p.variants.find((v) => v.id === picked[p.id]) ?? p.variants[0];
            const inCart = cart.find((l) => l.variantId === chosen.id)?.qty ?? 0;
            return (
              <Card key={p.id} className="flex flex-col overflow-hidden">
                {p.images[0] && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={shopApi.imageUrl(token, p.images[0])} alt="" className="aspect-square w-full bg-muted object-cover" loading="lazy" referrerPolicy="no-referrer" />
                )}
                <CardContent className="flex flex-1 flex-col gap-2 pt-4">
                  <div className="flex items-start justify-between gap-2">
                    <h2 className="font-medium">{p.name}</h2>
                    <Button type="button" variant="ghost" size="icon" className="-mt-1 -mr-2 shrink-0" aria-pressed={wishlist.has(chosen.id)}
                      aria-label={t(wishlist.has(chosen.id) ? 'unsave' : 'save')} onClick={() => toggleSaved(chosen.id)}>
                      <Heart className={`size-4 ${wishlist.has(chosen.id) ? 'fill-current text-primary' : ''}`} aria-hidden />
                    </Button>
                  </div>
                  {p.description && <p className="line-clamp-3 text-sm text-muted-foreground">{p.description}</p>}
                  {p.disclosure && <p className="text-xs text-muted-foreground">{p.disclosure}</p>}
                  {p.variants.length > 1 && (
                    <select aria-label={t('variant')} className="h-9 rounded-md border bg-background px-2 text-sm" value={chosen.id}
                      onChange={(e) => setPicked((m) => ({ ...m, [p.id]: e.target.value }))}>
                      {p.variants.map((v) => <option key={v.id} value={v.id}>{Object.values(v.options).join(' / ') || v.sku}</option>)}
                    </select>
                  )}
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="font-semibold tabular-nums">
                      {money(chosen.priceMinor, currency, locale)}
                      {chosen.compareAtMinor && chosen.compareAtMinor > chosen.priceMinor && (
                        <s className="ml-2 text-xs font-normal text-muted-foreground">{money(chosen.compareAtMinor, currency, locale)}</s>
                      )}
                    </span>
                    {chosen.inStock ? (
                      <Button size="sm" disabled={busy || inCart >= 99} onClick={() => setQty(chosen.id, inCart + 1)}>
                        <Plus className="size-4" aria-hidden /> {t('add')}
                      </Button>
                    ) : <span className="text-sm text-muted-foreground">{t('outOfStock')}</span>}
                  </div>
                </CardContent>
              </Card>
            );
          })}
          </div>
          {catalogueBusy && <Loader2 className="mx-auto size-5 animate-spin text-muted-foreground" aria-label={t('loading')} />}
          {!catalogueBusy && nextCursor && (
            <Button type="button" variant="outline" className="w-full" onClick={() => void fetchProducts({ q: search, category }, nextCursor)}>
              {t('showMore')}
            </Button>
          )}
        </section>
      )}
    </>
  );

  return (
    <div className="w-full max-w-3xl space-y-6">
      <header className="flex items-center gap-2">
        <ShoppingBag className="size-6 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">{title}</h1>
      </header>
      <CheckoutPanel session={session} variantInfo={variantInfo} beforeCart={grid} />
    </div>
  );
}
