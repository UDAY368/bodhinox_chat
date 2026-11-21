/**
 * The signed-in buyer's account pages on the public shop (store plan Phase 5):
 * the order list and one order. Server-rendered from data that holds only
 * this buyer's own orders in this shop.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { formatMoney } from '@/lib/format/money';
import type { AccountOrderDetail, AccountOrders } from '@/lib/commerce/shop-customer';
import { ReorderButton, SignOutButton } from './account-actions';

const heading = { fontFamily: 'var(--shop-font-heading)' } as const;
const money = (minor: number | null, currency: string, locale: string) => {
  if (minor === null) return '';
  return formatMoney(minor, currency, { locale });
};
const day = (iso: string, locale: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));

export async function AccountHome({ handle, phoneMasked, data, locale }: { handle: string; phoneMasked: string; data: AccountOrders; locale: string }) {
  const t = await getTranslations('ShopPublic');
  const status = await getTranslations('Storefront.orderStatus');
  const base = `/s/${handle}/account`;
  const pill = 'inline-flex min-h-11 items-center rounded-[var(--shop-radius)] border border-black/15 px-4 text-sm';
  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold" style={heading}>{t('account.title')}</h1>
          <p className="text-sm opacity-70">{t('account.signedInAs', { phone: phoneMasked })}</p>
        </div>
        <div className="flex gap-2">
          <Link href={`${base}/addresses`} className={pill}>{t('account.addresses')}</Link>
          <SignOutButton handle={handle} />
        </div>
      </header>
      <section aria-labelledby="account-orders" className="flex flex-col gap-3">
        <h2 id="account-orders" className="text-lg font-semibold" style={heading}>{t('account.orders')}</h2>
        {data.orders.length === 0 && <p className="opacity-70">{t('account.noOrders')}</p>}
        <ul className="flex flex-col gap-3">
          {data.orders.map((o) => (
            <li key={o.id}>
              <Link href={`${base}/orders/${o.id}`} className="flex items-center justify-between gap-3 rounded-[var(--shop-radius)] bg-[var(--shop-surface)] p-4 ring-1 ring-black/5 hover:ring-black/20">
                <span className="min-w-0">
                  <span className="block font-medium">{t('track.order', { code: o.reference })}</span>
                  <span className="block text-sm opacity-70">{day(o.placedAt, locale)} · {t('account.items', { count: o.items })}</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block font-semibold tabular-nums">{money(o.totalMinor, o.currency, locale)}</span>
                  <span className="block text-sm opacity-80">{status.has(o.status) ? status(o.status) : o.status}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
        {(data.page > 1 || data.hasNext) && (
          <nav className="flex justify-between gap-2" aria-label={t('pagination')}>
            {data.page > 1 ? <Link href={`${base}?page=${data.page - 1}`} className={pill}>{t('prevPage')}</Link> : <span />}
            {data.hasNext && <Link href={`${base}?page=${data.page + 1}`} className={pill}>{t('nextPage')}</Link>}
          </nav>
        )}
      </section>
    </div>
  );
}

export async function AccountOrder({ handle, detail, locale }: { handle: string; detail: AccountOrderDetail; locale: string }) {
  const t = await getTranslations('ShopPublic');
  const status = await getTranslations('Storefront.orderStatus');
  const { order } = detail;
  const m = (minor: number | null) => money(minor, order.currency, locale);
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold' : 'opacity-80'}`}><dt>{label}</dt><dd className="tabular-nums">{value}</dd></div>
  );
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
      <Link href={`/s/${handle}/account`} className="inline-flex min-h-11 items-center self-start text-sm underline">{t('account.back')}</Link>
      <header>
        <p className="text-xs uppercase tracking-wide opacity-60">{t('track.order', { code: order.reference })}</p>
        <h1 className="mt-1 text-2xl font-semibold" style={heading}>{status.has(order.status) ? status(order.status) : order.status}</h1>
        <p className="mt-1 text-sm opacity-70">{t('track.placedOn', { date: day(detail.placedAt, locale) })}</p>
      </header>
      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t('track.items')}</h2>
        <ul className="divide-y divide-black/10 text-sm">
          {order.lines.map((line, i) => (
            <li key={i} className="flex justify-between gap-4 py-2">
              <span className="min-w-0 break-words">{line.name ?? line.sku ?? '-'} <span className="opacity-70">× {line.qty}</span></span>
              <span className="tabular-nums">{m(line.lineTotalMinor)}</span>
            </li>
          ))}
        </ul>
        <dl className="flex flex-col gap-1 border-t border-black/10 pt-3 text-sm">
          {row(t('track.subtotal'), m(order.subtotalMinor))}
          {order.discountMinor > 0 && row(t('track.discount'), `−${m(order.discountMinor)}`)}
          {row(t('track.shipping'), m(order.shippingMinor))}
          {order.codFeeMinor > 0 && row(t('track.codFee'), m(order.codFeeMinor))}
          {!order.taxInclusive && order.taxMinor > 0 && row(t('account.tax'), m(order.taxMinor))}
          {order.totalMinor !== null && row(t('track.total'), m(order.totalMinor), true)}
        </dl>
      </section>
      <div className="flex flex-col gap-3">
        {order.trackingPath && (
          <Link href={order.trackingPath} className="flex h-11 items-center justify-center rounded-[var(--shop-radius)] border border-black/15 font-semibold">{t('account.track')}</Link>
        )}
        <ReorderButton handle={handle} orderId={detail.id} />
      </div>
    </div>
  );
}
