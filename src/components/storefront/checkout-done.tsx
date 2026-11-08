'use client';

/**
 * Where Razorpay returns the customer after paying (callback_url, design E13).
 * Read-only: every razorpay_* query parameter is ignored. The page polls the
 * order status, which only verified settlement on the server can change, and
 * shows the receipt number once the order is paid.
 */
import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { shopApi, shopErrorCode, type StorefrontOrderView } from './api';
import { OrderSummary } from './order-summary';

const POLL_MS = 4000;
const MAX_POLLS = 75; // about five minutes
// 'confirmed': a cash-on-delivery order is final at placing (nothing to wait for).
const SETTLED = new Set(['paid', 'confirmed', 'dispatched', 'fulfilled', 'expired', 'cancelled', 'payment_review']);

export function CheckoutDone({ token }: { token: string }) {
  const t = useTranslations('Storefront');
  const locale = useLocale();
  const [order, setOrder] = useState<StorefrontOrderView | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');

  useEffect(() => {
    let live = true;
    let polls = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      try {
        const { order: next } = await shopApi.status(token);
        if (!live) return;
        setOrder(next);
        setState('ready');
        if (next && SETTLED.has(next.status)) return;
      } catch (e) {
        if (!live) return;
        if (shopErrorCode(e) === 'not_found') { setState('not_found'); return; }
        setState((s) => (s === 'loading' ? 'error' : s));
      }
      if (++polls < MAX_POLLS) timer = setTimeout(tick, POLL_MS);
    };
    void tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [token]);

  if (state === 'loading') return <Loader2 className="mx-auto mt-16 size-6 animate-spin text-muted-foreground" aria-label={t('loading')} />;
  if (state !== 'ready' || !order) {
    return (
      <Card className="w-full max-w-md self-start">
        <CardHeader><CardTitle>{state === 'not_found' ? t('notFoundTitle') : t('errors.error')}</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">{state === 'not_found' ? t('notFoundBody') : null}</CardContent>
      </Card>
    );
  }
  return (
    <div className="w-full max-w-xl space-y-4">
      {order.status === 'awaiting_payment' && (
        <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
          <Loader2 className="size-4 animate-spin" aria-hidden /> {t('confirmingPayment')}
        </p>
      )}
      <OrderSummary order={order} locale={locale} />
      <a href={`/shop/${encodeURIComponent(token)}`} className={buttonVariants({ variant: 'outline', className: 'w-full' })}>{t('backToOrder')}</a>
    </div>
  );
}
