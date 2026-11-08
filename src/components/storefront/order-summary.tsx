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
import { formatMoney } from '@/lib/commerce/money';
import type { StorefrontOrderView } from './api';

const PAID = new Set(['paid', 'dispatched', 'fulfilled']);
const CLOSED = new Set(['expired', 'cancelled']);

export function money(minor: number | null, currency: string, locale: string): string {
  if (minor === null) return '';
  try {
    return formatMoney(minor, currency, locale);
  } catch {
    return String(minor);
  }
}

export function OrderSummary({ order, locale }: { order: StorefrontOrderView; locale: string }) {
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
          {t(`orderStatus.${order.status}`)}
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
        {codDue && (
          <p className="rounded-md bg-muted p-3 text-sm">
            {t('codDue', { amount: money(order.totalMinor !== null ? order.totalMinor - order.amountPaidMinor : null, order.currency, locale) })}
          </p>
        )}
        {order.documentNumber && <p className="text-sm">{t('receiptNumber', { number: order.documentNumber })}</p>}
        <ul className="divide-y text-sm">
          {order.lines.map((line, i) => (
            <li key={i} className="flex justify-between gap-4 py-2">
              <span className="min-w-0 break-words">{line.name ?? line.sku ?? '-'} × {line.qty}</span>
              <span className="shrink-0 tabular-nums">{money(line.lineTotalMinor ?? line.unitPriceMinor * line.qty, order.currency, locale)}</span>
            </li>
          ))}
        </ul>
        {order.priced && <Totals order={order} locale={locale} />}
      </CardContent>
    </Card>
  );
}

function Totals({ order, locale }: { order: StorefrontOrderView; locale: string }) {
  const t = useTranslations('Storefront');
  const row = (label: string, value: string, strong = false) => (
    <div className={`flex justify-between ${strong ? 'font-semibold' : 'text-muted-foreground'}`}><span>{label}</span><span className="tabular-nums">{value}</span></div>
  );
  return (
    <div className="space-y-1 border-t pt-3 text-sm">
      {row(t('subtotal'), money(order.subtotalMinor, order.currency, locale))}
      {order.discountMinor > 0 && row(t('discount'), `−${money(order.discountMinor, order.currency, locale)}`)}
      {row(t('shipping'), money(order.shippingMinor, order.currency, locale))}
      {order.codFeeMinor > 0 && row(t('codFee'), money(order.codFeeMinor, order.currency, locale))}
      {row(order.taxInclusive ? t('taxIncluded') : t('tax'), money(order.taxMinor, order.currency, locale))}
      {row(t('total'), money(order.totalMinor, order.currency, locale), true)}
    </div>
  );
}
