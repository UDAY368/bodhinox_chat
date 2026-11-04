'use client';

/**
 * The customer's storefront (design §6): a mobile-first product grid with a
 * variant picker, the cart, a delivery address form, the server quote with
 * its tax and shipping breakdown, and "Place order and pay". Every change is
 * sent with the session version and answered with the fresh view, so prices
 * and totals always come from the server. After placing, the page waits for
 * the payment link and opens it; the order status itself comes only from the
 * database.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Minus, Plus, ShoppingBag, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { MARKETING_OPT_IN_VERSION, shopApi, shopErrorCode, type Quote, type ShopErrorCode, type StorefrontView } from './api';
import { money, OrderSummary } from './order-summary';

type Address = Record<'name' | 'phone' | 'line1' | 'line2' | 'city' | 'state' | 'state_code' | 'postal_code' | 'country' | 'instructions', string>;
const EMPTY_ADDRESS: Address = { name: '', phone: '', line1: '', line2: '', city: '', state: '', state_code: '', postal_code: '', country: 'IN', instructions: '' };
const POLL_MS = 3000;

export function Storefront({ token }: { token: string }) {
  const t = useTranslations('Storefront');
  const locale = useLocale();
  const [view, setView] = useState<StorefrontView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShopErrorCode | null>(null);
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [coupon, setCoupon] = useState('');
  const [picked, setPicked] = useState<Record<string, string>>({});
  // Repeat-purchase consent (Phase 9 D13): unticked by default, sent with the place request only.
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  const justPlaced = useRef(false);

  const accept = useCallback((next: StorefrontView | null) => {
    if (!next) return;
    setView(next);
    if (next.address) setAddress({ ...EMPTY_ADDRESS, ...Object.fromEntries(Object.entries(next.address).map(([k, v]) => [k, v ?? ''])) } as Address);
    setCoupon(next.couponCode ?? '');
  }, []);

  const load = useCallback(async () => {
    try {
      accept(await shopApi.view(token));
      setLoadState('ready');
    } catch (e) {
      setLoadState(shopErrorCode(e) === 'not_found' ? 'not_found' : 'error');
    }
  }, [token, accept]);

  useEffect(() => { void load(); }, [load]);

  // While the payment link is being prepared, poll the order (database only) and open the link once it exists.
  const pending = view?.order?.status === 'awaiting_payment' && view.order.paymentPending;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      try {
        const { order } = await shopApi.status(token);
        if (!order) return;
        setView((v) => (v ? { ...v, order } : v));
        if (order.paymentUrl && justPlaced.current) {
          justPlaced.current = false;
          window.location.assign(order.paymentUrl);
        }
      } catch { /* keep polling */ }
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [pending, token]);

  const run = useCallback(async (work: () => Promise<StorefrontView | null>) => {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      accept(await work());
    } catch (e) {
      const code = shopErrorCode(e);
      setError(code);
      if (code === 'conflict' || code === 'cart_locked' || code === 'session_expired') await load();
    } finally {
      setBusy(false);
    }
  }, [view, accept, load]);

  const variantInfo = useMemo(() => {
    const map = new Map<string, { productName: string; options: string; priceMinor: number; inStock: boolean }>();
    for (const p of view?.products ?? [])
      for (const v of p.variants)
        map.set(v.id, { productName: p.name, options: Object.values(v.options).join(' / '), priceMinor: v.priceMinor, inStock: v.inStock });
    return map;
  }, [view?.products]);

  if (loadState === 'loading') return <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" aria-label={t('loading')} />;
  if (loadState !== 'ready' || !view) {
    return (
      <Card className="w-full max-w-md self-start">
        <CardHeader><CardTitle>{loadState === 'not_found' ? t('notFoundTitle') : t('errors.error')}</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{loadState === 'not_found' ? t('notFoundBody') : null}</CardContent>
      </Card>
    );
  }

  const currency = view.store.currency ?? 'INR';
  const title = view.store.title || view.store.businessName;
  const quote = view.quote?.ok ? view.quote.quote : null;
  const quoteError = view.quote && !view.quote.ok ? view.quote.code : null;
  const cart = view.cart;
  const setQty = (variantId: string, qty: number) => {
    const lines = cart.map((l) => ({ ...l })).filter((l) => l.variantId !== variantId || qty > 0);
    const line = lines.find((l) => l.variantId === variantId);
    if (line) line.qty = qty;
    else if (qty > 0) lines.push({ variantId, qty });
    void run(() => shopApi.cart(token, view.version, lines));
  };
  const saveAddress = () => void run(() => shopApi.address(token, view.version,
    Object.fromEntries(Object.entries(address).map(([k, v]) => [k, v.trim() || null]))));
  const placeOrder = () => {
    if (!quote) return;
    justPlaced.current = true;
    void run(async () => {
      try {
        const placed = await shopApi.place(token, { expectedVersion: view.version, expectedTotalMinor: quote.totalMinor, clientRequestId: crypto.randomUUID(),
          marketingOptIn });
        if (placed.view?.order?.paymentUrl) window.location.assign(placed.view.order.paymentUrl);
        return placed.view;
      } catch (e) {
        justPlaced.current = false;
        // The total changed since the customer saw it: show the new quote before anything is charged.
        if (shopErrorCode(e) === 'quote_changed') await load();
        throw e;
      }
    });
  };

  return (
    <div className="w-full max-w-3xl space-y-6">
      <header className="flex items-center gap-2">
        <ShoppingBag className="size-6 text-primary" aria-hidden />
        <h1 className="text-xl font-semibold">{title}</h1>
      </header>

      {error && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {t(`errors.${error}`)}
        </p>
      )}

      {view.order && (view.order.priced || view.purpose === 'status') ? (
        <OrderSummary order={view.order} locale={locale} />
      ) : !view.open ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('expired')}</CardContent></Card>
      ) : (
        <>
          {!view.store.checkoutEnabled && <p className="rounded-md bg-muted p-3 text-sm">{t('checkoutClosed')}</p>}

          {view.purpose === 'shop' && (
            <section aria-label={t('productsHeading')} className="grid gap-4 sm:grid-cols-2">
              {view.products.length === 0 && <p className="text-sm text-muted-foreground">{t('noProducts')}</p>}
              {view.products.map((p) => {
                const chosen = p.variants.find((v) => v.id === picked[p.id]) ?? p.variants[0];
                const inCart = cart.find((l) => l.variantId === chosen.id)?.qty ?? 0;
                return (
                  <Card key={p.id} className="flex flex-col overflow-hidden">
                    {p.images[0] && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={shopApi.imageUrl(token, p.images[0])} alt="" className="aspect-square w-full bg-muted object-cover" loading="lazy" referrerPolicy="no-referrer" />
                    )}
                    <CardContent className="flex flex-1 flex-col gap-2 pt-4">
                      <h2 className="font-medium">{p.name}</h2>
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
            </section>
          )}

          <Card>
            <CardHeader><CardTitle className="text-lg">{t('cartHeading')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {cart.length === 0 && <p className="text-sm text-muted-foreground">{t('cartEmpty')}</p>}
              <ul className="divide-y text-sm">
                {cart.map((line) => {
                  const info = variantInfo.get(line.variantId);
                  const q = quote?.lines.find((l) => l.variantId === line.variantId);
                  const name = q?.productName ?? info?.productName ?? '-';
                  const options = q ? Object.values(q.optionValues).join(' / ') : info?.options;
                  return (
                    <li key={line.variantId} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 break-words">{name}{options ? ` (${options})` : ''}</span>
                      {view.cartLocked ? <span className="shrink-0">× {line.qty}</span> : (
                        <span className="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="icon" aria-label={t('decrease')} disabled={busy} onClick={() => setQty(line.variantId, line.qty - 1)}>
                            {line.qty === 1 ? <Trash2 className="size-4" aria-hidden /> : <Minus className="size-4" aria-hidden />}
                          </Button>
                          <span className="w-6 text-center tabular-nums">{line.qty}</span>
                          <Button variant="ghost" size="icon" aria-label={t('increase')} disabled={busy || line.qty >= 99} onClick={() => setQty(line.variantId, line.qty + 1)}>
                            <Plus className="size-4" aria-hidden />
                          </Button>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </CardContent>
          </Card>

          {cart.length > 0 && (
            <>
              <Card>
                <CardHeader><CardTitle className="text-lg">{t('addressHeading')}</CardTitle></CardHeader>
                <CardContent>
                  <form className="grid gap-3 sm:grid-cols-2" onSubmit={(e) => { e.preventDefault(); saveAddress(); }}>
                    {(['name', 'phone', 'line1', 'line2', 'city', 'state', 'postal_code', 'country'] as const).map((field) => (
                      <div key={field} className={field === 'line1' || field === 'line2' ? 'sm:col-span-2 space-y-1' : 'space-y-1'}>
                        <Label htmlFor={`addr-${field}`}>{t(`address.${field}`)}</Label>
                        <Input id={`addr-${field}`} value={address[field]} autoComplete={AUTOCOMPLETE[field]}
                          maxLength={field === 'country' ? 2 : field === 'line1' || field === 'line2' ? 200 : 100}
                          required={!['line2', 'state'].includes(field)}
                          onChange={(e) => setAddress((a) => ({ ...a, [field]: field === 'country' ? e.target.value.toUpperCase() : e.target.value }))} />
                      </div>
                    ))}
                    <div className="space-y-1 sm:col-span-2">
                      <Label htmlFor="addr-instructions">{t('address.instructions')}</Label>
                      <Textarea id="addr-instructions" maxLength={300} value={address.instructions}
                        onChange={(e) => setAddress((a) => ({ ...a, instructions: e.target.value }))} />
                    </div>
                    <Button type="submit" variant="outline" disabled={busy} className="sm:col-span-2">{t('saveAddress')}</Button>
                  </form>
                </CardContent>
              </Card>

              <Card>
                <CardHeader><CardTitle className="text-lg">{t('summaryHeading')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => shopApi.coupon(token, view.version, coupon.trim() || null)); }}>
                    <Input aria-label={t('couponLabel')} placeholder={t('couponLabel')} value={coupon} maxLength={32}
                      onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
                    <Button type="submit" variant="outline" disabled={busy}>{view.couponCode && !coupon ? t('removeCoupon') : t('applyCoupon')}</Button>
                  </form>
                  {quoteError && <p className="text-sm text-destructive" role="alert">{t(`errors.${(quoteError in ERROR_SET ? quoteError : 'error') as ShopErrorCode}`)}</p>}
                  {quote && <QuoteTotals quote={quote} locale={locale} />}
                  {quote && !quote.shipping && <p className="text-sm text-muted-foreground">{t('addAddressForShipping')}</p>}
                  <div className="flex items-start gap-2">
                    <Checkbox id="marketing-opt-in" checked={marketingOptIn} disabled={busy}
                      onCheckedChange={(v) => setMarketingOptIn(v === true)} />
                    <Label htmlFor="marketing-opt-in" className="text-sm font-normal leading-snug">
                      {t(`marketingOptIn.${MARKETING_OPT_IN_VERSION}`)}
                    </Label>
                  </div>
                  <Button className="w-full" disabled={busy || !quote?.shipping || !view.store.checkoutEnabled} onClick={placeOrder}>
                    {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    {quote ? t('placeAndPay', { amount: money(quote.totalMinor, quote.currency, locale) }) : t('placeOrder')}
                  </Button>
                  <p className="text-xs text-muted-foreground">{t('paymentNote')}</p>
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </div>
  );
}

const ERROR_SET: Record<string, true> = Object.fromEntries([
  'tax_not_configured', 'shipping_unavailable', 'price_not_configured', 'variant_unavailable', 'coupon_not_found', 'coupon_inactive',
  'coupon_not_started', 'coupon_expired', 'coupon_min_subtotal', 'store_not_configured', 'cart_empty', 'invalid_cart', 'amount_out_of_range',
].map((c) => [c, true]));

const AUTOCOMPLETE: Record<string, string> = {
  name: 'name', phone: 'tel', line1: 'address-line1', line2: 'address-line2', city: 'address-level2', state: 'address-level1',
  postal_code: 'postal-code', country: 'country',
};

function QuoteTotals({ quote, locale }: { quote: Quote; locale: string }) {
  const t = useTranslations('Storefront');
  const c = quote.currency;
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between ${strong ? 'text-base font-semibold' : 'text-muted-foreground'}`}><span>{label}</span><span className="tabular-nums">{value}</span></div>
  );
  return (
    <div className="space-y-1 text-sm">
      {quote.lines.map((l) => <div key={l.variantId}>{row(`${l.productName} × ${l.qty}`, money(l.grossMinor, c, locale))}</div>)}
      <div className="border-t pt-1" />
      {row(t('subtotal'), money(quote.subtotalMinor, c, locale))}
      {quote.discountMinor > 0 && row(t('discountWithCode', { code: quote.couponCode ?? '' }), `−${money(quote.discountMinor, c, locale)}`)}
      {quote.shipping && row(t('shippingWith', { name: quote.shipping.name }), money(quote.shippingMinor, c, locale))}
      {row(quote.taxInclusive ? t('taxIncluded') : t('tax'), money(quote.taxMinor, c, locale))}
      {row(t('total'), money(quote.totalMinor, c, locale), true)}
    </div>
  );
}
