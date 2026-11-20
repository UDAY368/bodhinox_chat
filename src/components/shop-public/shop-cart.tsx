'use client';

/**
 * The public shop's cart page. The lines live in the browser; names, prices
 * and stock come from the server each time the page opens or a quantity
 * changes. Ordering needs a known buyer, by either path the shop turned on:
 * a WhatsApp one-time code (then checkout opens with this cart), or "Order on
 * WhatsApp" (the buyer sends the cart's code to the shop's number and gets
 * the checkout link back in the chat). Before that step the page shows an
 * estimate from the server (pincode, coupon, shipping, tax, total) for the
 * cart as it is: nothing is stored or reserved. Checkout itself is the shop's
 * themed checkout page (/s/<handle>/checkout/<token>); the pincode and coupon
 * carry over to it, and while its link is still valid the Checkout button
 * goes straight back there.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, MessageCircle, Minus, Plus, Trash2 } from 'lucide-react';
import { formatMoney } from '@/lib/commerce/money';
import { formatShipDate } from '@/lib/commerce/selling-rules';
import type { CartEstimate } from '@/lib/commerce/cart-estimate';
import { parsePincode } from '@/lib/commerce/pincode';
import type { CartPreview } from '@/lib/commerce/public-shop';
import { accountApiPath } from '@/lib/commerce/shop-customer-cookie';
import { addToCart, CART_EVENT, readCart, setLineQty, writeCart, type BrowserCartLine } from './cart-store';
import { markReplaceCart, readCheckout, writeCarry } from './checkout-store';
import { shopErrorKey, shopPostJson as post } from './shop-post';
import { readRef } from './referral-store';

export interface CartShopInfo {
  handle: string;
  name: string;
  checkoutOpen: boolean;
  ordering: { otp: boolean; whatsapp: boolean };
  pricesIncludeTax: boolean;
}

/** The signed-in buyer (store plan Phase 5): a masked number and their saved addresses as one-line labels. */
export interface CartBuyer { phoneMasked: string; addresses: Array<{ id: string; label: string }> }

export function ShopCart({ shop, buyer = null }: { shop: CartShopInfo; buyer?: CartBuyer | null }) {
  const t = useTranslations('ShopPublic');
  const router = useRouter();
  const locale = useLocale();
  const api = `/api/public/store/${shop.handle}`;
  const [lines, setLines] = useState<BrowserCartLine[] | null>(null);
  const [preview, setPreview] = useState<CartPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [phone, setPhone] = useState('+91');
  const [challenge, setChallenge] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState<null | 'otp' | 'verify' | 'whatsapp' | 'account'>(null);
  // Signed in: "Check out as <number>" replaces the code form until the buyer asks for another number.
  const [asBuyer, setAsBuyer] = useState(buyer !== null);
  const [addressId, setAddressId] = useState(buyer?.addresses[0]?.id ?? '');
  // The estimate's pincode and coupon: typed here, sent with every cart refresh once applied.
  const [pincodeInput, setPincodeInput] = useState('');
  const [couponInput, setCouponInput] = useState('');
  const [pincodeError, setPincodeError] = useState(false);
  const applied = useRef<{ pincode: string | null; coupon: string | null }>({ pincode: null, coupon: null });
  // A checkout link opened before in this browser and still valid: the Checkout button goes back to it (no new code).
  const openCheckout = useSyncExternalStore(subscribeStorage, () => readCheckout(shop.handle)?.token ?? null, () => null);
  const [otherWay, setOtherWay] = useState(false);

  const refresh = useCallback(async (current: BrowserCartLine[]) => {
    if (!current.length) { setPreview(null); setLoading(false); return; }
    setLoading(true);
    const { pincode, coupon } = applied.current;
    const result = await post<CartPreview>(`${api}/cart`, { lines: current, ...(pincode ? { pincode } : {}), ...(coupon ? { coupon } : {}) });
    setLoading(false);
    if (!result.ok) { setError(result.code); return; }
    setPreview(result.data);
    // Drop what is no longer on sale, so the code and WhatsApp paths get a clean cart.
    if (result.data.removed.length) writeCart(shop.handle, current.filter((l) => !result.data.removed.includes(l.variantId)));
  }, [api, shop.handle]);

  useEffect(() => {
    const load = () => { const current = readCart(shop.handle); setLines(current); void refresh(current); };
    load();
    window.addEventListener(CART_EVENT, load);
    return () => window.removeEventListener(CART_EVENT, load);
  }, [refresh, shop.handle]);

  const money = (minor: number) => (preview?.currency ? formatMoney(minor, preview.currency, locale) : '');
  const message = (c: string) => t(shopErrorKey(c));
  const cart = (lines ?? []).map((l) => ({ variantId: l.variantId, qty: l.qty }));
  const estimate: CartEstimate | null = preview?.estimate ?? null;
  const applyPincode = () => {
    const typed = pincodeInput.trim() !== '';
    const pincode = typed ? parsePincode(pincodeInput) : null;
    setPincodeError(typed && !pincode);
    if (typed && !pincode) return;
    applied.current = { ...applied.current, pincode };
    void refresh(lines ?? []);
  };
  const applyCoupon = () => {
    applied.current = { ...applied.current, coupon: couponInput.trim().toUpperCase() || null };
    void refresh(lines ?? []);
  };
  // What the checkout takes over: the pincode, and the coupon only when it applies to this cart.
  const carry = () => writeCarry(shop.handle, {
    pincode: applied.current.pincode, coupon: estimate?.couponCode && !estimate.couponError ? estimate.couponCode : null,
  });
  const goToCheckout = () => {
    if (!openCheckout) return;
    carry();
    markReplaceCart(shop.handle);
    router.push(`/s/${shop.handle}/checkout/${openCheckout}`);
  };

  const sendCode = async () => {
    setBusy('otp'); setError(null);
    const result = await post<{ challengeId: string }>(`${api}/otp`, { phone, cart, ref: readRef(shop.handle) });
    setBusy(null);
    if (!result.ok) { setError(result.code); return; }
    setChallenge(result.data.challengeId);
  };
  const verify = async () => {
    if (!challenge) return;
    setBusy('verify'); setError(null);
    const result = await post<{ url: string }>(`${api}/otp/verify`, { challengeId: challenge, code: code.trim() });
    if (!result.ok) { setBusy(null); setError(result.code); return; }
    carry();
    writeCart(shop.handle, []);
    window.location.assign(result.data.url);
  };
  const checkoutAsBuyer = async () => {
    setBusy('account'); setError(null);
    const result = await post<{ url: string }>(`${accountApiPath(shop.handle)}/checkout`, { cart, addressId: addressId || undefined });
    if (!result.ok) {
      setBusy(null); setError(result.code);
      // The session ended (expired, signed out elsewhere): fall back to the code.
      if (result.code === 'signed_out') setAsBuyer(false);
      return;
    }
    carry();
    writeCart(shop.handle, []);
    window.location.assign(result.data.url);
  };
  const orderOnWhatsApp = async () => {
    setBusy('whatsapp'); setError(null);
    const result = await post<{ whatsappUrl: string }>(`${api}/whatsapp`, { cart, ref: readRef(shop.handle) });
    setBusy(null);
    if (!result.ok) { setError(result.code); return; }
    carry();
    window.location.assign(result.data.whatsappUrl);
  };

  if (lines === null) return <p className="py-16 text-center opacity-70">{t('loading')}</p>;
  if (!lines.length) return (
    <div className="flex flex-col items-center gap-4 py-16 text-center">
      <p className="text-lg">{t('cartEmpty')}</p>
      <Link href={`/s/${shop.handle}`} className="rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-5 py-3 font-semibold text-[var(--shop-on-primary)]">
        {t('keepShopping')}
      </Link>
    </div>
  );

  return (
    <div className="grid gap-6 @5xl:grid-cols-[1fr_380px]">
      <section aria-labelledby="cart-heading" className="flex flex-col gap-3">
        <h1 id="cart-heading" className="text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('cart')}</h1>
        {loading && !preview && <p className="opacity-70"><Loader2 className="mr-2 inline size-4 animate-spin" aria-hidden />{t('loading')}</p>}
        {preview?.removed.length ? <p className="rounded-[var(--shop-radius)] bg-amber-100 p-3 text-sm text-amber-900">{t('removedLines')}</p> : null}
        <ul className="flex flex-col gap-3">
          {preview?.lines.map((line) => (
            <li key={line.variantId} className="flex gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-3 ring-1 ring-black/5">
              <div className="flex min-w-0 flex-1 flex-col gap-1">
                <Link href={`/s/${shop.handle}/p/${line.productId}`} className="font-medium hover:underline">{line.name}</Link>
                {Object.keys(line.options).length > 0 && <p className="text-xs opacity-70">{Object.values(line.options).join(' · ')}</p>}
                <p className="text-sm">{money(line.unitPriceMinor)}</p>
                {line.shipsBy && <p className="text-xs font-medium">{t('shipsBy', { date: formatShipDate(line.shipsBy, locale) })}</p>}
                {line.digital && <p className="text-xs opacity-70">{t('digitalNote')}</p>}
                {line.available !== null && line.available < line.qty && <p className="text-xs text-red-700">{t('onlyLeft', { count: Math.max(0, line.available) })}</p>}
              </div>
              <div className="flex flex-col items-end justify-between gap-2">
                <p className="font-semibold">{money(line.lineTotalMinor)}</p>
                <div className="flex items-center gap-1">
                  <button type="button" className="grid size-11 place-items-center rounded-full hover:bg-black/5" aria-label={t('decrease')}
                    onClick={() => setLineQty(shop.handle, line.variantId, line.qty - 1)}><Minus className="size-4" aria-hidden /></button>
                  <span className="w-6 text-center tabular-nums">{line.qty}</span>
                  <button type="button" className="grid size-11 place-items-center rounded-full hover:bg-black/5 disabled:opacity-30" aria-label={t('increase')}
                    disabled={line.available !== null && line.qty >= line.available}
                    onClick={() => setLineQty(shop.handle, line.variantId, line.qty + 1)}><Plus className="size-4" aria-hidden /></button>
                  <button type="button" className="grid size-11 place-items-center rounded-full hover:bg-black/5" aria-label={t('remove')}
                    onClick={() => setLineQty(shop.handle, line.variantId, 0)}><Trash2 className="size-4" aria-hidden /></button>
                </div>
              </div>
            </li>
          ))}
        </ul>
        {preview?.suggestions?.length ? (
          <section aria-labelledby="cart-suggestions" className="mt-4 flex flex-col gap-3">
            <h2 id="cart-suggestions" className="text-lg font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t('related')}</h2>
            <ul className="grid gap-3 @2xl:grid-cols-2">
              {preview.suggestions.map((p) => {
                const variant = p.variants.find((v) => v.inStock);
                if (!variant) return null;
                return (
                  <li key={p.id} className="flex items-center gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-3 ring-1 ring-black/5">
                    <Link href={`/s/${shop.handle}/p/${p.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                      {p.images[0]
                        // eslint-disable-next-line @next/next/no-img-element -- shop images come from our own route or the shop's https URL
                        ? <img src={p.images[0]} alt="" loading="lazy" className="size-14 shrink-0 rounded-[var(--shop-radius)] object-cover" />
                        : <div className="grid size-14 shrink-0 place-items-center rounded-[var(--shop-radius)] bg-black/5 opacity-40" aria-hidden>{p.name.slice(0, 1)}</div>}
                      <span className="min-w-0">
                        <span className="line-clamp-2 block text-sm font-medium">{p.name}</span>
                        <span className="block text-sm">{money(variant.priceMinor)}</span>
                      </span>
                    </Link>
                    <button type="button" onClick={() => addToCart(shop.handle, variant.id, 1)}
                      className="h-11 shrink-0 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-4 text-sm font-semibold text-[var(--shop-on-primary)]">
                      {t('addOne')}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ) : null}
      </section>

      <aside className="flex h-fit flex-col gap-4 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 ring-1 ring-black/5 @5xl:sticky @5xl:top-20">
        <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); applyPincode(); }}>
          <label htmlFor="cart-pincode" className="text-xs opacity-70">{t('estimate.pincode')}</label>
          <div className="flex gap-2">
            <input id="cart-pincode" inputMode="numeric" autoComplete="postal-code" maxLength={7} value={pincodeInput} placeholder={t('pincode.placeholder')}
              onChange={(e) => { setPincodeInput(e.target.value.replace(/[^0-9 ]/g, '')); setPincodeError(false); }}
              className="h-11 min-w-0 flex-1 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base text-black" />
            <button type="submit" disabled={loading}
              className="h-11 rounded-[var(--shop-radius)] border border-[var(--shop-primary)] px-4 text-sm font-semibold text-[var(--shop-primary)] disabled:opacity-40">
              {t('pincode.button')}
            </button>
          </div>
          {pincodeError && <p role="alert" className="text-xs text-red-700">{t('pincode.invalid')}</p>}
        </form>
        <form className="flex flex-col gap-1" onSubmit={(e) => { e.preventDefault(); applyCoupon(); }}>
          <label htmlFor="cart-coupon" className="text-xs opacity-70">{t('estimate.coupon')}</label>
          <div className="flex gap-2">
            <input id="cart-coupon" autoCapitalize="characters" autoComplete="off" maxLength={32} value={couponInput}
              onChange={(e) => setCouponInput(e.target.value.toUpperCase())}
              className="h-11 min-w-0 flex-1 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base uppercase text-black" />
            <button type="submit" disabled={loading}
              className="h-11 rounded-[var(--shop-radius)] border border-[var(--shop-primary)] px-4 text-sm font-semibold text-[var(--shop-primary)] disabled:opacity-40">
              {t('estimate.apply')}
            </button>
          </div>
          {estimate?.couponError && (
            <p role="alert" className="text-xs text-red-700">{t(`estimate.couponErrors.${COUPON_ERRORS.has(estimate.couponError) ? estimate.couponError : 'other'}`)}</p>
          )}
        </form>
        <dl className="flex flex-col gap-1 text-sm" aria-live="polite">
          <EstimateRow label={t('subtotal')} value={preview ? money(estimate?.subtotalMinor ?? preview.subtotalMinor) : '…'} />
          {estimate?.autoDiscounts.map((d, i) => (
            <EstimateRow key={i} label={d.name} value={d.kind === 'free_shipping_over' ? t('pincode.freeShipping') : `−${money(d.savingMinor)}`} />
          ))}
          {estimate && estimate.couponMinor > 0 && <EstimateRow label={t('estimate.couponLine', { code: estimate.couponCode ?? '' })} value={`−${money(estimate.couponMinor)}`} />}
          {estimate && estimate.shipping !== 'not_needed' && (
            <EstimateRow label={t('estimate.shipping')} value={estimate.shipping === 'priced'
              ? (estimate.shippingMinor > 0 ? money(estimate.shippingMinor) : t('pincode.freeShipping'))
              : t(`estimate.shippingState.${estimate.shipping}`)} />
          )}
          {estimate && <EstimateRow label={estimate.taxInclusive ? t('estimate.taxIncluded') : t('estimate.tax')} value={money(estimate.taxMinor)} />}
          {estimate && <EstimateRow strong label={t('estimate.total')} value={money(estimate.totalMinor)} />}
        </dl>
        <p className="text-xs opacity-70">{estimate ? t('estimate.note') : shop.pricesIncludeTax ? t('taxIncludedNote') : t('taxExtraNote')}</p>
        {error && <p role="alert" className="rounded-[var(--shop-radius)] bg-red-50 p-3 text-sm text-red-800">{message(error)}</p>}

        {shop.checkoutOpen && openCheckout && !otherWay ? (
          <div className="flex flex-col gap-2">
            <button type="button" onClick={goToCheckout} disabled={!preview?.lines.length}
              className="min-h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-3 py-2 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
              {t('estimate.checkout')}
            </button>
            <button type="button" className="min-h-11 text-sm underline" onClick={() => setOtherWay(true)}>{t('account.otherNumber')}</button>
          </div>
        ) : !shop.checkoutOpen || (!shop.ordering.otp && !shop.ordering.whatsapp && !buyer) ? (
          <p className="text-sm">{t('orderingClosed')}</p>
        ) : (
          <>
            {buyer && asBuyer && (
              <div className="flex flex-col gap-2">
                {buyer.addresses.length > 0 && (
                  <>
                    <label htmlFor="shop-address" className="text-xs opacity-70">{t('account.deliverTo')}</label>
                    <select id="shop-address" value={addressId} onChange={(e) => setAddressId(e.target.value)}
                      className="h-11 w-full rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base text-black">
                      {buyer.addresses.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
                      <option value="">{t('account.enterAtCheckout')}</option>
                    </select>
                  </>
                )}
                <button type="button" onClick={checkoutAsBuyer} disabled={busy !== null || !preview?.lines.length}
                  className="min-h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] px-3 py-2 font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
                  {busy === 'account' ? <Loader2 className="mx-auto size-5 animate-spin" aria-label={t('loading')} /> : t('account.checkoutAs', { phone: buyer.phoneMasked })}
                </button>
                {shop.ordering.otp && <button type="button" className="min-h-11 text-sm underline" onClick={() => setAsBuyer(false)}>{t('account.otherNumber')}</button>}
              </div>
            )}
            {shop.ordering.otp && !(buyer && asBuyer) && (
              <div className="flex flex-col gap-2">
                <p className="text-sm font-medium">{t('otpHeading')}</p>
                {!challenge ? (
                  <>
                    <label htmlFor="shop-phone" className="text-xs opacity-70">{t('phoneLabel')}</label>
                    <input id="shop-phone" type="tel" inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)}
                      className="h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-base text-black" />
                    <button type="button" onClick={sendCode} disabled={busy !== null || !preview?.lines.length}
                      className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
                      {busy === 'otp' ? <Loader2 className="mx-auto size-5 animate-spin" role="img" aria-label={t('loading')} /> : t('sendCode')}
                    </button>
                  </>
                ) : (
                  <>
                    <label htmlFor="shop-code" className="text-xs opacity-70">{t('codeLabel')}</label>
                    <input id="shop-code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                      className="h-11 rounded-[var(--shop-radius)] border border-black/15 bg-white px-3 text-center text-lg tracking-[0.4em] text-black" />
                    <button type="button" onClick={verify} disabled={busy !== null || code.length !== 6}
                      className="h-11 rounded-[var(--shop-radius)] bg-[var(--shop-primary)] font-semibold text-[var(--shop-on-primary)] disabled:opacity-40">
                      {busy === 'verify' ? <Loader2 className="mx-auto size-5 animate-spin" role="img" aria-label={t('loading')} /> : t('verifyAndCheckout')}
                    </button>
                    <button type="button" className="text-sm underline" onClick={() => { setChallenge(null); setCode(''); }}>{t('changeNumber')}</button>
                  </>
                )}
              </div>
            )}
            {(shop.ordering.otp || (buyer && asBuyer)) && shop.ordering.whatsapp && <p className="text-center text-xs opacity-60">{t('or')}</p>}
            {shop.ordering.whatsapp && (
              <button type="button" onClick={orderOnWhatsApp} disabled={busy !== null || !preview?.lines.length}
                className="flex h-11 items-center justify-center gap-2 rounded-[var(--shop-radius)] bg-[#25d366] font-semibold text-black disabled:opacity-40">
                {busy === 'whatsapp' ? <Loader2 className="size-5 animate-spin" role="img" aria-label={t('loading')} /> : <><MessageCircle className="size-5" aria-hidden />{t('orderOnWhatsApp')}</>}
              </button>
            )}
            <p className="text-xs opacity-70">{t('checkoutNote')}</p>
          </>
        )}
      </aside>
    </div>
  );
}

const COUPON_ERRORS = new Set(['coupon_not_found', 'coupon_inactive', 'coupon_not_started', 'coupon_expired', 'coupon_min_subtotal']);

function EstimateRow({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${strong ? 'text-lg font-semibold' : ''}`}>
      <dt className={strong ? '' : 'opacity-80'}>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** Another tab opening or ending a checkout changes the remembered link. */
function subscribeStorage(onChange: () => void): () => void {
  window.addEventListener('storage', onChange);
  return () => window.removeEventListener('storage', onChange);
}
