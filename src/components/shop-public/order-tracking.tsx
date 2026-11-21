/**
 * The buyer's order tracking page body (store plan Phase 5): code, status,
 * timeline, items, totals, courier. Server-rendered; the data
 * (loadOrderTracking) holds no phone number, street address or internal id.
 */
import { getTranslations } from 'next-intl/server';
import { Check, Circle, X } from 'lucide-react';
import { formatMoney } from '@/lib/format/money';
import type { OrderTrackingView } from '@/lib/commerce/order-tracking';

export async function OrderTracking({ view, locale }: { view: OrderTrackingView; locale: string }) {
  const t = await getTranslations('ShopPublic');
  const money = (minor: number | null) => {
    if (minor === null) return '';
    return formatMoney(minor, view.currency, { locale });
  };
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between gap-4 ${strong ? 'font-semibold' : 'opacity-80'}`}><dt>{label}</dt><dd className="tabular-nums">{value}</dd></div>
  );
  const current = view.timeline.find((s) => s.state === 'current')?.key ?? 'placed';
  return (
    <div className="mx-auto flex w-full max-w-xl flex-col gap-8">
      <header>
        <p className="text-xs uppercase tracking-wide opacity-60">{t('track.order', { code: view.reference })}</p>
        <h1 className="mt-1 text-2xl font-semibold" style={{ fontFamily: 'var(--shop-font-heading)' }}>{t(`track.steps.${current}`)}</h1>
        <p className="mt-1 text-sm opacity-70">{t('track.placedOn', { date: when(view.placedAt) })}</p>
      </header>

      <ol className="flex flex-col" aria-label={t('track.timeline')}>
        {view.timeline.map((step, i) => {
          const done = step.state === 'done', now = step.state === 'current', bad = step.key === 'cancelled';
          const Icon = bad ? X : done || now ? Check : Circle;
          return (
            <li key={step.key} className="flex gap-3" aria-current={now ? 'step' : undefined}>
              <div className="flex flex-col items-center">
                <span className={`grid size-7 shrink-0 place-items-center rounded-full ${bad ? 'bg-red-700 text-white' : done || now ? 'bg-[var(--shop-primary)] text-[var(--shop-on-primary)]' : 'border border-black/20 opacity-50'}`}>
                  <Icon className="size-4" aria-hidden />
                </span>
                {i < view.timeline.length - 1 && <span className={`w-px grow ${done ? 'bg-[var(--shop-primary)]' : 'bg-black/15'}`} aria-hidden />}
              </div>
              <div className="pb-5">
                <p className={`text-sm ${now ? 'font-semibold' : done ? '' : 'opacity-60'}`}>{t(`track.steps.${step.key}`)}</p>
                {step.at && <p className="text-xs opacity-60">{when(step.at)}</p>}
              </div>
            </li>
          );
        })}
      </ol>

      {view.shipment && (
        <section className="flex flex-col gap-1 rounded-[var(--shop-radius)] border border-black/10 bg-[var(--shop-surface)] p-4 text-sm">
          <h2 className="font-semibold">{t('track.courier')}</h2>
          {view.shipment.courierName && <p>{view.shipment.courierName}</p>}
          <p className="opacity-80">{t('track.awb', { awb: view.shipment.awb })}</p>
          {view.shipment.trackingUrl && (
            <a href={view.shipment.trackingUrl} target="_blank" rel="noopener noreferrer" className="mt-1 font-semibold text-[var(--shop-primary)] underline">{t('track.courierLink')}</a>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold">{t('track.items')}</h2>
        <ul className="divide-y divide-black/10 text-sm">
          {view.items.map((item, i) => (
            <li key={i} className="flex justify-between gap-4 py-2"><span className="min-w-0 break-words">{item.name}</span><span className="tabular-nums">× {item.quantity}</span></li>
          ))}
        </ul>
        <dl className="flex flex-col gap-1 border-t border-black/10 pt-3 text-sm">
          {row(t('track.subtotal'), money(view.subtotalMinor))}
          {view.discountMinor > 0 && row(t('track.discount'), `−${money(view.discountMinor)}`)}
          {row(t('track.shipping'), money(view.shippingMinor))}
          {view.codFeeMinor > 0 && row(t('track.codFee'), money(view.codFeeMinor))}
          {view.totalMinor !== null && row(t('track.total'), money(view.totalMinor), true)}
        </dl>
        {view.paymentMethod === 'cod' && current !== 'delivered' && current !== 'cancelled' && <p className="text-xs opacity-70">{t('track.codNote')}</p>}
      </section>

      {view.deliveryTo && (view.deliveryTo.city || view.deliveryTo.postalCode) && (
        <p className="text-sm opacity-80">{t('track.deliveringTo', { place: [view.deliveryTo.city, view.deliveryTo.postalCode].filter(Boolean).join(' ') })}</p>
      )}
    </div>
  );
}
