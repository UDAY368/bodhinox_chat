'use client';

/**
 * The checkout itself, shared by the staff storefront link (/shop/<token>,
 * storefront.tsx, which adds its product grid) and the public shop's themed
 * checkout (/s/<handle>/checkout/<token>, shop-checkout.tsx): the cart, the
 * delivery address, the checkout extras and the summary with coupon, delivery
 * method, payment, store credit, totals, GST invoice, consent and "Place
 * order". Every change is sent with the session version and answered with the
 * fresh view, so prices and totals always come from the server. After placing,
 * the page waits for the payment link and opens it; the order status itself
 * comes only from the database.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, Minus, Plus, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { readWishlist, writeWishlist } from '@/components/shop-public/wishlist-store';
import { validateGstin } from '@/lib/billing/gst';
import { formatShipDate } from '@/lib/commerce/selling-rules';
import {
  MARKETING_OPT_IN_VERSION, shopApi, shopErrorCode, type ExtrasValues, type Quote, type ShopErrorCode, type StorefrontView,
} from './api';
import { CheckoutExtrasForm, normaliseDraft } from './checkout-extras-form';
import { money, OrderSummary } from './order-summary';

type Address = Record<'name' | 'phone' | 'line1' | 'line2' | 'city' | 'state' | 'state_code' | 'postal_code' | 'country' | 'instructions', string>;
const EMPTY_ADDRESS: Address = { name: '', phone: '', line1: '', line2: '', city: '', state: '', state_code: '', postal_code: '', country: 'IN', instructions: '' };
const POLL_MS = 3000;

/** Names for cart lines the quote cannot name (a refused quote): from the products the page has seen. */
export type VariantInfo = ReadonlyMap<string, { productName: string; options: string }>;

/** One storefront session on the page: the view, its load state and the version-checked changes. */
export function useCheckoutSession(token: string, onView?: (view: StorefrontView) => void) {
  const [view, setView] = useState<StorefrontView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShopErrorCode | null>(null);
  const [address, setAddress] = useState<Address>(EMPTY_ADDRESS);
  const [coupon, setCoupon] = useState('');
  // What the buyer types for the checkout extras; sent with the order (the server checks it again), seeded from the session once.
  const [extrasDraft, setExtrasDraft] = useState<ExtrasValues>({});
  const extrasSeeded = useRef(false);
  // The contact's saved variants (their wishlist); a visitor's browser list is saved here once, when they come in through a session.
  const [wishlist, setWishlist] = useState<ReadonlySet<string>>(new Set());
  const wishlistSynced = useRef(false);
  const justPlacedRef = useRef(false);
  const onViewRef = useRef(onView);
  useEffect(() => { onViewRef.current = onView; }, [onView]);

  const accept = useCallback((next: StorefrontView | null) => {
    if (!next) return;
    setView(next);
    onViewRef.current?.(next);
    if (next.extras && !extrasSeeded.current) { extrasSeeded.current = true; setExtrasDraft(next.extras.values); }
    setWishlist(new Set(next.wishlist));
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

  // A visitor's browser wishlist joins their contact the first time they are here through a session; then the browser list is cleared.
  useEffect(() => {
    if (loadState !== 'ready' || view?.purpose !== 'shop' || !view.open || wishlistSynced.current) return;
    wishlistSynced.current = true;
    const saved = readWishlist();
    if (!saved.length) return;
    shopApi.wishlist(token, { action: 'sync', variantIds: saved })
      .then((list) => { setWishlist(new Set(list.items.map((i) => i.variantId))); writeWishlist([]); })
      .catch(() => { /* keep the browser list for next time */ });
  }, [loadState, view, token]);

  // While the payment link is being prepared, poll the order (database only) and open the link once it exists.
  const pending = view?.order?.status === 'awaiting_payment' && view.order.paymentPending;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(async () => {
      try {
        const { order } = await shopApi.status(token);
        if (!order) return;
        setView((v) => (v ? { ...v, order } : v));
        if (order.paymentUrl && justPlacedRef.current) {
          justPlacedRef.current = false;
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

  /** Set one line's quantity (0 removes it). */
  const setQty = useCallback((variantId: string, qty: number) => {
    if (!view) return;
    const lines = view.cart.map((l) => ({ ...l })).filter((l) => l.variantId !== variantId || qty > 0);
    const line = lines.find((l) => l.variantId === variantId);
    if (line) line.qty = qty;
    else if (qty > 0) lines.push({ variantId, qty });
    void run(() => shopApi.cart(token, view.version, lines));
  }, [view, run, token]);

  const toggleSaved = useCallback((variantId: string) => {
    const saved = wishlist.has(variantId);
    setError(null);
    shopApi.wishlist(token, { action: saved ? 'remove' : 'add', variantId })
      .then((list) => setWishlist(new Set(list.items.map((i) => i.variantId))))
      .catch((e) => setError(shopErrorCode(e)));
  }, [wishlist, token]);

  return {
    token, view, setView, loadState, load, busy, error, run, setQty, wishlist, toggleSaved,
    address, setAddress, coupon, setCoupon, extrasDraft, setExtrasDraft, justPlacedRef,
  };
}

export type CheckoutSession = ReturnType<typeof useCheckoutSession>;

/** The loading, "not found" and error states of a session page; null once the view is ready. */
export function CheckoutLoadState({ session, notFoundAction }: { session: CheckoutSession; notFoundAction?: ReactNode }) {
  const t = useTranslations('Storefront');
  if (session.loadState === 'loading') return <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" aria-label={t('loading')} />;
  if (session.loadState === 'ready' && session.view) return null;
  return (
    <Card className="w-full max-w-md self-start">
      <CardHeader><CardTitle>{session.loadState === 'not_found' ? t('notFoundTitle') : t('errors.error')}</CardTitle></CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        {session.loadState === 'not_found'
          ? <><p>{t('notFoundBody')}</p><p>{t('notFoundReturnHint')}</p>{notFoundAction}</>
          : <Button type="button" variant="outline" onClick={() => void session.load()}>{t('retry')}</Button>}
      </CardContent>
    </Card>
  );
}

/**
 * Everything after the product grid. `beforeCart` is the staff page's grid; `emptyCart` replaces the plain
 * "cart is empty" line (the shop's checkout offers "Browse the shop").
 */
export function CheckoutPanel({ session, variantInfo, beforeCart, emptyCart }: {
  session: CheckoutSession; variantInfo: VariantInfo; beforeCart?: ReactNode; emptyCart?: ReactNode;
}) {
  const t = useTranslations('Storefront');
  const locale = useLocale();
  const { token, view, busy, error, run, setQty, address, setAddress, coupon, setCoupon, extrasDraft, setExtrasDraft, justPlacedRef, load } = session;
  // Repeat-purchase consent (Phase 9 D13): unticked by default, sent with the place request only.
  const [marketingOptIn, setMarketingOptIn] = useState(false);
  // An optional GST tax invoice for a business buyer: the GSTIN is checked here for a quick hint and again on the server.
  const [wantInvoice, setWantInvoice] = useState(false);
  const [buyerGstin, setBuyerGstin] = useState('');
  const [buyerLegalName, setBuyerLegalName] = useState('');
  const gstinInvalid = wantInvoice && buyerGstin.trim() !== '' && validateGstin(buyerGstin) === null;
  const [email, setEmail] = useState('');
  const [emailOffers, setEmailOffers] = useState(false);
  if (!view) return null;

  const currency = view.store.currency ?? 'INR';
  const quote = view.quote?.ok ? view.quote.quote : null;
  const quoteError = view.quote && !view.quote.ok ? view.quote.code : null;
  const cart = view.cart;
  const saveAddress = () => void run(() => shopApi.address(token, view.version,
    Object.fromEntries(Object.entries(address).map(([k, v]) => [k, v.trim() || null]))));
  const cod = view.paymentMethod === 'cod';
  // COD is offered when the store has it on; the quote says whether every product in the cart allows it.
  const codOffered = view.store.codEnabled && view.store.checkoutEnabled;
  const codPossible = codOffered && (quote ? quote.codAvailable : quoteError === 'cod_unavailable' ? false : true);
  // No Razorpay connection: online payment cannot be set up, so it is not offered (placing refuses it too).
  const onlineAvailable = view.store.onlineAvailable;
  const choosePayment = (method: 'online' | 'cod') => {
    if (method !== view.paymentMethod) void run(() => shopApi.payment(token, view.version, method));
  };
  // Store credit and loyalty points: switches only. The server decides how much each pays, from its own balances.
  const wallet = view.wallet;
  const chooseTender = (useStoreCredit: boolean, usePoints: boolean) => void run(() => shopApi.tender(token, view.version, useStoreCredit, usePoints));
  // Credit and points cover the whole order: nothing is left to pay, so no payment method is needed.
  const nothingToPay = !!quote && quote.payableMinor === 0 && quote.storeCreditMinor + quote.pointsValueMinor > 0;
  const delivery = view.delivery;
  // 'ship' is always there; pickup and local delivery only when the store offers them. The server prices the choice.
  const chooseDelivery = (method: 'ship' | 'pickup' | 'local') => {
    if (method !== delivery.method) void run(() => shopApi.delivery(token, view.version, method));
  };
  // One tap for a repeat buyer: the server copies the last order's address and delivery choice onto this cart.
  const useLastDelivery = () => void run(() => shopApi.repeat(token, view.version));
  const placeOrder = () => {
    if (!quote) return;
    justPlacedRef.current = true;
    void run(async () => {
      try {
        // The extras the buyer typed are saved first (the server checks them), so the order is placed with them.
        let version = view.version;
        const draft = normaliseDraft(extrasDraft);
        if (view.extras && JSON.stringify(draft) !== JSON.stringify(normaliseDraft(view.extras.values))) version = (await shopApi.extras(token, view.version, draft)).version;
        const placed = await shopApi.place(token, { expectedVersion: version, expectedTotalMinor: quote.totalMinor,
          expectedPayableMinor: quote.payableMinor, clientRequestId: crypto.randomUUID(), marketingOptIn,
          ...(email.trim() ? { email: email.trim(), emailOffers } : {}),
          ...(wantInvoice && buyerGstin.trim() ? { buyerGstin: buyerGstin.trim().toUpperCase(), buyerLegalName: buyerLegalName.trim() } : {}) });
        if (placed.view?.order?.paymentUrl) window.location.assign(placed.view.order.paymentUrl);
        return placed.view;
      } catch (e) {
        justPlacedRef.current = false;
        // The total changed since the customer saw it: show the new quote before anything is charged.
        if (shopErrorCode(e) === 'quote_changed') await load();
        throw e;
      }
    });
  };

  return (
    <>
      {error && (
        <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {t(`errors.${error}`)}
        </p>
      )}

      {view.order && (view.order.priced || view.purpose === 'status') ? (
        <OrderSummary order={view.order} locale={locale} token={token} onOrder={(order) => session.setView((v) => (v ? { ...v, order } : v))} />
      ) : !view.open ? (
        <Card><CardContent className="pt-6 text-sm text-muted-foreground">{t('expired')}</CardContent></Card>
      ) : (
        <>
          {!view.store.checkoutEnabled && <p className="rounded-md bg-muted p-3 text-sm">{t('checkoutClosed')}</p>}

          {beforeCart}

          <Card>
            <CardHeader><CardTitle className="text-lg">{t('cartHeading')}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {cart.length === 0 && (emptyCart ?? <p className="text-sm text-muted-foreground">{t('cartEmpty')}</p>)}
              <ul className="divide-y text-sm">
                {cart.map((line) => {
                  const info = variantInfo.get(line.variantId);
                  const q = quote?.lines.find((l) => l.variantId === line.variantId);
                  const name = q?.productName ?? info?.productName ?? '-';
                  const options = q ? Object.values(q.optionValues).join(' / ') : info?.options;
                  return (
                    <li key={line.variantId} className="flex items-center justify-between gap-2 py-2">
                      <span className="min-w-0 break-words">
                        {name}{options ? ` (${options})` : ''}
                        {q?.preorderShipDate && <span className="block text-xs text-muted-foreground">{t('shipsBy', { date: formatShipDate(q.preorderShipDate, locale) })}</span>}
                        {q?.digital && <span className="block text-xs text-muted-foreground">{t('digitalNote')}</span>}
                      </span>
                      {view.cartLocked ? <span className="shrink-0">× {line.qty}</span> : (
                        <span className="flex shrink-0 items-center gap-1">
                          <Button variant="ghost" size="icon" className="size-11" aria-label={line.qty === 1 ? t('remove') : t('decrease')} disabled={busy}
                            onClick={() => setQty(line.variantId, line.qty - 1)}>
                            {line.qty === 1 ? <Trash2 className="size-4" aria-hidden /> : <Minus className="size-4" aria-hidden />}
                          </Button>
                          <span className="w-6 text-center tabular-nums">{line.qty}</span>
                          <Button variant="ghost" size="icon" className="size-11" aria-label={t('increase')} disabled={busy || line.qty >= 99}
                            onClick={() => setQty(line.variantId, line.qty + 1)}>
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
              {view.repeat && !quote?.digitalOnly && (
                <Card>
                  <CardContent className="flex flex-wrap items-center justify-between gap-3 pt-6 text-sm">
                    <p>{t('repeatPrompt', { name: view.repeat.name, city: view.repeat.city, postalCode: view.repeat.postalCode })}</p>
                    <Button type="button" disabled={busy} onClick={useLastDelivery}>{t('repeatUse')}</Button>
                  </CardContent>
                </Card>
              )}
              {!quote?.digitalOnly && (
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
              )}

              {view.extras && (
                <CheckoutExtrasForm extras={view.extras} draft={extrasDraft} onChange={setExtrasDraft} disabled={busy} digitalOnly={!!quote?.digitalOnly} />
              )}

              <Card>
                <CardHeader><CardTitle className="text-lg">{t('summaryHeading')}</CardTitle></CardHeader>
                <CardContent className="space-y-4">
                  <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void run(() => shopApi.coupon(token, view.version, coupon.trim() || null)); }}>
                    <Input aria-label={t('couponLabel')} placeholder={t('couponLabel')} value={coupon} maxLength={32}
                      onChange={(e) => setCoupon(e.target.value.toUpperCase())} />
                    <Button type="submit" variant="outline" disabled={busy}>{view.couponCode && !coupon ? t('removeCoupon') : t('applyCoupon')}</Button>
                  </form>
                  {!quote?.digitalOnly && (delivery.methods.length > 1 || delivery.method !== 'ship') && (
                    <fieldset className="space-y-2" disabled={busy}>
                      <legend className="mb-1 text-sm font-medium">{t('deliveryHeading')}</legend>
                      {(['ship', 'pickup', 'local'] as const).filter((m) => delivery.methods.includes(m) || m === delivery.method).map((m) => (
                        <label key={m} className="flex items-start gap-2 text-sm">
                          <input type="radio" name="delivery-method" className="mt-0.5 size-4" checked={delivery.method === m} onChange={() => chooseDelivery(m)} />
                          <span>
                            {m === 'local' ? t('deliveryLocal', { fee: money(delivery.localFeeMinor, currency, locale) }) : t(m === 'pickup' ? 'deliveryPickup' : 'deliveryShip')}
                            {m === 'pickup' && delivery.pickupAddress && (
                              <span className="block whitespace-pre-line text-xs text-muted-foreground">{delivery.pickupAddress}</span>
                            )}
                          </span>
                        </label>
                      ))}
                    </fieldset>
                  )}
                  {(codOffered || cod || !onlineAvailable) && (
                    <fieldset className="space-y-2" disabled={busy}>
                      <legend className="mb-1 text-sm font-medium">{t('paymentHeading')}</legend>
                      <label className="flex items-center gap-2 text-sm">
                        <input type="radio" name="payment-method" className="size-4" checked={!cod} disabled={!onlineAvailable && !cod}
                          onChange={() => choosePayment('online')} />
                        {t('payOnline')}
                      </label>
                      {!onlineAvailable && <p className="text-xs text-muted-foreground">{t('onlineUnavailable')}</p>}
                      <label className={`flex items-center gap-2 text-sm ${codPossible ? '' : 'text-muted-foreground'}`}>
                        <input type="radio" name="payment-method" className="size-4" checked={cod} disabled={!codPossible && !cod}
                          onChange={() => choosePayment('cod')} />
                        {view.store.codFeeMinor > 0
                          ? t('payCodWithFee', { fee: money(view.store.codFeeMinor, currency, locale) })
                          : t('payCod')}
                      </label>
                      {codOffered && !codPossible && !cod && <p className="text-xs text-muted-foreground">{t('codNotForCart')}</p>}
                      {cod && onlineAvailable && quote && quote.prepaidSavingMinor > 0 && (
                        <p className="text-sm font-medium text-primary">{t('payOnlineSave', { amount: money(quote.prepaidSavingMinor, quote.currency, locale) })}</p>
                      )}
                    </fieldset>
                  )}
                  {wallet && (wallet.storeCreditMinor > 0 || wallet.points > 0 || wallet.useStoreCredit || wallet.usePoints) && (
                    <fieldset className="space-y-2" disabled={busy}>
                      <legend className="mb-1 text-sm font-medium">{t('walletHeading')}</legend>
                      {(wallet.storeCreditMinor > 0 || wallet.useStoreCredit) && (
                        <div className="flex items-start gap-2">
                          <Checkbox id="use-store-credit" checked={wallet.useStoreCredit} onCheckedChange={(v) => chooseTender(v === true, wallet.usePoints)} />
                          <Label htmlFor="use-store-credit" className="text-sm font-normal leading-snug">
                            {t('useStoreCredit', { amount: money(wallet.storeCreditMinor, currency, locale) })}
                          </Label>
                        </div>
                      )}
                      {wallet.pointValueMinor !== null && (wallet.points > 0 || wallet.usePoints) && (
                        <div className="flex items-start gap-2">
                          <Checkbox id="use-points" checked={wallet.usePoints} onCheckedChange={(v) => chooseTender(wallet.useStoreCredit, v === true)} />
                          <Label htmlFor="use-points" className="text-sm font-normal leading-snug">{t('usePoints', { points: wallet.points })}</Label>
                        </div>
                      )}
                    </fieldset>
                  )}
                  {quoteError && <p className="text-sm text-destructive" role="alert">{t(`errors.${(quoteError in ERROR_SET ? quoteError : 'error') as ShopErrorCode}`)}</p>}
                  {quote && <QuoteTotals quote={quote} locale={locale} />}
                  {quote && !quote.shipping && <p className="text-sm text-muted-foreground">{t('addAddressForShipping')}</p>}
                  <div className="space-y-2">
                    <div className="flex items-start gap-2">
                      <Checkbox id="want-gst-invoice" checked={wantInvoice} disabled={busy} onCheckedChange={(v) => setWantInvoice(v === true)} />
                      <Label htmlFor="want-gst-invoice" className="text-sm font-normal leading-snug">{t('gstInvoice.toggle')}</Label>
                    </div>
                    {wantInvoice && (
                      <div className="space-y-2">
                        <div className="space-y-1">
                          <Label htmlFor="buyer-gstin" className="text-xs">{t('gstInvoice.gstin')}</Label>
                          <Input id="buyer-gstin" value={buyerGstin} maxLength={15} autoCapitalize="characters" autoComplete="off" disabled={busy}
                            aria-invalid={gstinInvalid} onChange={(e) => setBuyerGstin(e.target.value.toUpperCase())} />
                          {gstinInvalid && <p className="text-xs text-destructive" role="alert">{t('gstInvoice.invalid')}</p>}
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="buyer-legal-name" className="text-xs">{t('gstInvoice.legalName')}</Label>
                          <Input id="buyer-legal-name" value={buyerLegalName} maxLength={200} autoComplete="organization" disabled={busy}
                            onChange={(e) => setBuyerLegalName(e.target.value)} />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="checkout-email" className="text-sm">{t('emailLabel')}</Label>
                    <Input id="checkout-email" type="email" autoComplete="email" maxLength={254} value={email} disabled={busy}
                      onChange={(e) => { setEmail(e.target.value); if (!e.target.value.trim()) setEmailOffers(false); }} />
                    <p className="text-xs text-muted-foreground">{t('emailHint')}</p>
                  </div>
                  <div className="flex items-start gap-2">
                    <Checkbox id="email-offers" checked={emailOffers} disabled={busy || !email.trim()} onCheckedChange={(v) => setEmailOffers(v === true)} />
                    <Label htmlFor="email-offers" className="text-sm font-normal leading-snug">{t('emailOffers')}</Label>
                  </div>
                  <div className="flex items-start gap-2">
                    <Checkbox id="marketing-opt-in" checked={marketingOptIn} disabled={busy}
                      onCheckedChange={(v) => setMarketingOptIn(v === true)} />
                    <Label htmlFor="marketing-opt-in" className="text-sm font-normal leading-snug">
                      {t(`marketingOptIn.${MARKETING_OPT_IN_VERSION}`)}
                    </Label>
                  </div>
                  <Button className="min-h-11 w-full" disabled={busy || gstinInvalid || !quote?.shipping || !view.store.checkoutEnabled || (!cod && !onlineAvailable && !nothingToPay)} onClick={placeOrder}>
                    {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
                    {!quote ? t('placeOrder') : nothingToPay ? t('placeNothingToPay')
                      : t(cod ? 'placeCod' : 'placeAndPay', { amount: money(quote.payableMinor, quote.currency, locale) })}
                  </Button>
                  {!nothingToPay && <p className="text-xs text-muted-foreground">{t(cod ? 'codNote' : 'paymentNote')}</p>}
                </CardContent>
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}

const ERROR_SET: Record<string, true> = Object.fromEntries([
  'tax_not_configured', 'shipping_unavailable', 'price_not_configured', 'variant_unavailable', 'coupon_not_found', 'coupon_inactive',
  'coupon_not_started', 'coupon_expired', 'coupon_min_subtotal', 'store_not_configured', 'cart_empty', 'invalid_cart', 'amount_out_of_range',
  'cod_unavailable', 'online_unavailable', 'delivery_unavailable', 'extras_invalid',
].map((c) => [c, true]));

const AUTOCOMPLETE: Record<string, string> = {
  name: 'name', phone: 'tel', line1: 'address-line1', line2: 'address-line2', city: 'address-level2', state: 'address-level1',
  postal_code: 'postal-code', country: 'country',
};

function QuoteTotals({ quote, locale }: { quote: Quote; locale: string }) {
  const t = useTranslations('Storefront');
  const c = quote.currency;
  // discountMinor is automatic discounts plus the coupon; each is shown on its own line.
  const couponMinor = quote.discountMinor - quote.autoDiscountMinor;
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between ${strong ? 'text-base font-semibold' : 'text-muted-foreground'}`}><span>{label}</span><span className="tabular-nums">{value}</span></div>
  );
  return (
    <div className="space-y-1 text-sm">
      {quote.lines.map((l) => (
        <div key={`${l.variantId}${l.gift ? ':gift' : ''}`}>
          {row(`${l.productName} × ${l.qty}`, l.gift ? t('freeGift') : money(l.grossMinor, c, locale))}
          {!l.gift && l.unitPriceMinor < l.catalogPriceMinor && (
            <p className="text-xs text-muted-foreground">{t('yourPrice', { price: money(l.unitPriceMinor, c, locale), was: money(l.catalogPriceMinor, c, locale) })}</p>
          )}
        </div>
      ))}
      <div className="border-t pt-1" />
      {row(t('subtotal'), money(quote.subtotalMinor, c, locale))}
      {quote.autoDiscounts.map((d) => (
        <div key={d.id}>{row(d.name, d.kind === 'free_shipping_over' ? t('freeShipping') : `−${money(d.savingMinor, c, locale)}`)}</div>
      ))}
      {couponMinor > 0 && row(t('discountWithCode', { code: quote.couponCode ?? '' }), `−${money(couponMinor, c, locale)}`)}
      {quote.shipping && !quote.digitalOnly && row(quote.deliveryMethod === 'pickup' ? t('deliveryPickup') : quote.deliveryMethod === 'local' ? t('deliveryLocalLine')
        : t('shippingWith', { name: quote.shipping.name }), money(quote.shippingMinor, c, locale))}
      {quote.codFee && quote.codFeeMinor > 0 && row(t('codFee'), money(quote.codFeeMinor, c, locale))}
      {row(quote.taxInclusive ? t('taxIncluded') : t('tax'), money(quote.taxMinor, c, locale))}
      {row(t('total'), money(quote.totalMinor, c, locale), true)}
      {quote.pointsValueMinor > 0 && row(t('pointsApplied', { points: quote.pointsRedeemed }), `−${money(quote.pointsValueMinor, c, locale)}`)}
      {quote.storeCreditMinor > 0 && row(t('storeCreditApplied'), `−${money(quote.storeCreditMinor, c, locale)}`)}
      {quote.payableMinor !== quote.totalMinor && row(t('toPay'), money(quote.payableMinor, c, locale), true)}
      {quote.preorderShipDate && <p className="pt-1 text-xs text-muted-foreground">{t('shipsBy', { date: formatShipDate(quote.preorderShipDate, locale) })}</p>}
    </div>
  );
}
