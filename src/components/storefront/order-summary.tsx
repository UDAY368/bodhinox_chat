'use client';

/**
 * One placed order as the customer sees it: status, lines, totals, the pay
 * button while a payment link is live, and the receipt number once paid.
 * Shows nothing about the customer (links get forwarded). The status comes
 * from the database only; a payment redirect never changes it.
 */
import { useTranslations } from 'next-intl';
import { CheckCircle2, Clock, ExternalLink, Loader2, XCircle } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoney } from '@/lib/format/money';
import { formatShipDate } from '@/lib/commerce/selling-rules';
import type { StorefrontOrderView } from './api';
import { BuyerReturns } from './buyer-returns';

const PAID = new Set(['paid', 'partially_shipped', 'dispatched', 'fulfilled']);
const CLOSED = new Set(['expired', 'cancelled']);

export function money(minor: number | null, currency: string, locale: string): string {
  if (minor === null) return '';
  return formatMoney(minor, currency, { locale });
}

/**
 * `token` and `onOrder` turn on the buyer's return requests (the order page has them; a static render does not): the page
 * passes the session token and takes back the order the server answers with.
 */
export function OrderSummary({ order, locale, token, onOrder }: { order: StorefrontOrderView; locale: string; token?: string; onOrder?: (order: StorefrontOrderView) => void }) {
  const t = useTranslations('Storefront');
  const paid = PAID.has(order.status);
  const closed = CLOSED.has(order.status);
  // A cash-on-delivery order is confirmed at placing; the customer pays when it arrives.
  const codDue = order.paymentMethod === 'cod' && order.priced && !closed && !order.paidAt;
  const Icon = paid || codDue ? CheckCircle2 : closed ? XCircle : Clock;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Icon className={paid || codDue ? 'size-5 text-green-600' : closed ? 'size-5 text-destructive' : 'size-5 text-amber-600'} aria-hidden />
          {order.paymentFailed ? t('paymentFailedTitle') : t(`orderStatus.${order.status}`)}
        </CardTitle>
        <CardDescription>{t('orderReference', { reference: order.reference })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {order.status === 'awaiting_payment' && order.paymentUrl && (
          <a href={order.paymentUrl} rel="noopener noreferrer" className={buttonVariants({ className: 'w-full' })}>
            <ExternalLink className="size-4" aria-hidden /> {t('payNow', { amount: money(order.totalMinor !== null ? order.totalMinor - order.amountPaidMinor : null, order.currency, locale) })}
          </a>
        )}
        {order.status === 'awaiting_payment' && order.paymentPending && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="size-4 animate-spin" aria-hidden /> {t('preparingLink')}
          </p>
        )}
        {order.status === 'awaiting_payment' && order.reservationExpiresAt && (
          <p className="text-xs text-muted-foreground">
            {t('holdUntil', { time: new Intl.DateTimeFormat(locale, { timeStyle: 'short' }).format(new Date(order.reservationExpiresAt)) })}
          </p>
        )}
        {order.status === 'payment_review' && <p className="text-sm text-muted-foreground">{t('paymentReview')}</p>}
        {order.paymentFailed && <p className="text-sm text-destructive" role="alert">{t('paymentFailed')}</p>}
        {codDue && (
          <p className="rounded-md bg-muted p-3 text-sm">
            {t('codDue', { amount: money(order.totalMinor !== null ? order.totalMinor - order.amountPaidMinor : null, order.currency, locale) })}
          </p>
        )}
        {order.deliveryMethod === 'pickup' && (
          <div className="rounded-md bg-muted p-3 text-sm">
            <p className="font-medium">{t('pickupAt')}</p>
            {order.pickup?.address && <p className="whitespace-pre-line">{order.pickup.address}</p>}
            {order.pickup?.instructions && <p className="mt-1 whitespace-pre-line text-muted-foreground">{order.pickup.instructions}</p>}
          </div>
        )}
        {order.deliveryMethod === 'local' && <p className="rounded-md bg-muted p-3 text-sm">{t('localDeliveryNote')}</p>}
        {order.preorderShipDate && <p className="rounded-md bg-muted p-3 text-sm">{t('shipsBy', { date: formatShipDate(order.preorderShipDate, locale) })}</p>}
        {order.digitalDownloadUrl && (
          <a href={order.digitalDownloadUrl} rel="noopener noreferrer" className={buttonVariants({ variant: 'outline', className: 'w-full' })}>
            <ExternalLink className="size-4" aria-hidden /> {t('downloadDigital')}
          </a>
        )}
        {order.extras && <ExtrasBlock extras={order.extras} locale={locale} />}
        {order.documentNumber && <p className="text-sm">{t('receiptNumber', { number: order.documentNumber })}</p>}
        {order.trackingPath && !closed && (
          <a href={order.trackingPath} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>{t('trackOrder')}</a>
        )}
        {order.returnWindowDays !== null && (
          <p className="text-xs text-muted-foreground">
            {order.returnWindowDays > 0 ? t('returnWindow', { days: order.returnWindowDays }) : t('noReturns')}
          </p>
        )}
        <ul className="divide-y text-sm">
          {order.lines.map((line, i) => (
            <li key={i} className="flex justify-between gap-4 py-2">
              <span className="min-w-0 break-words">
                {line.name ?? line.sku ?? '-'} × {line.qty}
                {line.shipsBy && <span className="block text-xs text-muted-foreground">{t('shipsBy', { date: formatShipDate(line.shipsBy, locale) })}</span>}
              </span>
              <span className="shrink-0 tabular-nums">{line.gift ? t('freeGift') : money(line.lineTotalMinor ?? line.unitPriceMinor * line.qty, order.currency, locale)}</span>
            </li>
          ))}
        </ul>
        {order.priced && <Totals order={order} locale={locale} />}
        {token && onOrder && order.returns && <BuyerReturns token={token} order={order} onOrder={onOrder} />}
      </CardContent>
    </Card>
  );
}

/** What the buyer asked for at checkout, shown back to them on the order. */
function ExtrasBlock({ extras, locale }: { extras: NonNullable<StorefrontOrderView['extras']>; locale: string }) {
  const t = useTranslations('Storefront.extras');
  const date = extras.delivery_date ? new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeZone: 'UTC' }).format(new Date(`${extras.delivery_date}T00:00:00Z`)) : null;
  const rows: Array<[string, string]> = [
    ...(date ? [[t('deliveryDate'), extras.delivery_slot ? `${date}, ${extras.delivery_slot}` : date] as [string, string]] : []),
    ...(extras.note ? [[t('note'), extras.note] as [string, string]] : []),
    ...(extras.gift_message ? [[t('giftMessage'), extras.gift_message] as [string, string]] : []),
    ...extras.custom.map((c) => [c.label, c.value] as [string, string]),
  ];
  return (
    <dl className="space-y-1 rounded-md bg-muted p-3 text-sm">
      {rows.map(([label, value], i) => (
        <div key={i}><dt className="text-xs text-muted-foreground">{label}</dt><dd className="whitespace-pre-line break-words">{value}</dd></div>
      ))}
    </dl>
  );
}

function Totals({ order, locale }: { order: StorefrontOrderView; locale: string }) {
  const t = useTranslations('Storefront');
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between ${strong ? 'font-semibold' : 'text-muted-foreground'}`}><span>{label}</span><span className="tabular-nums">{value}</span></div>
  );
  // discountMinor is the automatic discounts plus the coupon; each automatic discount has its own line.
  const couponMinor = order.discountMinor - order.autoDiscountMinor;
  return (
    <div className="space-y-1 border-t pt-3 text-sm">
      {row(t('subtotal'), money(order.subtotalMinor, order.currency, locale))}
      {order.autoDiscounts.map((d, i) => (
        <div key={i}>{row(d.name, d.kind === 'free_shipping_over' ? t('freeShipping') : `−${money(d.savingMinor, order.currency, locale)}`)}</div>
      ))}
      {couponMinor > 0 && row(t('discount'), `−${money(couponMinor, order.currency, locale)}`)}
      {row(order.deliveryMethod === 'pickup' ? t('deliveryPickup') : order.deliveryMethod === 'local' ? t('deliveryLocalLine') : t('shipping'),
        money(order.shippingMinor, order.currency, locale))}
      {order.codFeeMinor > 0 && row(t('codFee'), money(order.codFeeMinor, order.currency, locale))}
      {row(order.taxInclusive ? t('taxIncluded') : t('tax'), money(order.taxMinor, order.currency, locale))}
      {row(t('total'), money(order.totalMinor, order.currency, locale), true)}
      {order.pointsValueMinor > 0 && row(t('pointsApplied', { points: order.pointsRedeemed }), `−${money(order.pointsValueMinor, order.currency, locale)}`)}
      {order.storeCreditMinor > 0 && row(t('storeCreditApplied'), `−${money(order.storeCreditMinor, order.currency, locale)}`)}
    </div>
  );
}
