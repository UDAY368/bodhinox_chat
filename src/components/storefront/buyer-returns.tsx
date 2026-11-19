'use client';

/**
 * Return and exchange requests on the buyer's order page. The buyer picks lines and quantities, a reason, and (for an exchange)
 * another variant of the same product; the shop's staff approve or reject it. Nothing is refunded here, and the page says so.
 * The server decides whether a request can be made now (the shop offers it, the return window is open, the line is free).
 * One request id per form, so a double tap or a retry is the same request.
 */
import { useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { shopApi, shopErrorCode, type ShopErrorCode, type StorefrontOrderView } from './api';

const REASONS = ['wrong_item', 'damaged', 'not_as_described', 'size_fit', 'changed_mind', 'other'] as const;

export function BuyerReturns({ token, order, onOrder }: { token: string; order: StorefrontOrderView; onOrder: (order: StorefrontOrderView) => void }) {
  const t = useTranslations('Storefront.returns');
  const te = useTranslations('Storefront');
  const returns = order.returns;
  const [open, setOpen] = useState(false);
  const [qty, setQty] = useState<Record<string, number>>({});
  const [exchange, setExchange] = useState<Record<string, string>>({});
  const [reason, setReason] = useState<string>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ShopErrorCode | null>(null);
  const [sent, setSent] = useState(false);
  // One id per form: a retry or a double tap of Send is the same request.
  const requestId = useRef<string>(crypto.randomUUID());
  if (!returns) return null;

  const lines = Object.entries(qty).filter(([, n]) => n > 0);
  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const answer = await shopApi.requestReturn(token, {
        clientRequestId: requestId.current, reason, note: note.trim() || null,
        lines: lines.map(([id, n]) => ({ order_item_id: id, qty: n, exchange_variant_id: exchange[id] || null })),
      });
      if (answer.order) onOrder(answer.order);
      requestId.current = crypto.randomUUID();
      setOpen(false); setQty({}); setExchange({}); setReason(''); setNote(''); setSent(true);
    } catch (e) {
      setError(shopErrorCode(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 border-t pt-3" aria-label={t('heading')}>
      <h3 className="text-sm font-medium">{t('heading')}</h3>
      {returns.requests.length > 0 && (
        <ul className="space-y-2 text-sm">
          {returns.requests.map((r) => (
            <li key={r.id} className="rounded-md bg-muted p-3">
              <p className="font-medium">{r.status === 'requested' ? t(r.pendingApproval ? 'status.pending' : 'status.approved') : t(`status.${r.status}`)}{r.exchange ? ` · ${t('exchange')}` : ''}</p>
              <p className="text-xs text-muted-foreground">{r.lines.map((l) => `${l.name} × ${l.qty}`).join(', ')}</p>
            </li>
          ))}
        </ul>
      )}
      {sent && !open && <p className="text-sm" role="status">{t('sent')}</p>}
      {returns.canRequest && !open && (
        <Button type="button" variant="outline" className="w-full" onClick={() => { setOpen(true); setSent(false); }}>{t('open')}</Button>
      )}
      {!returns.canRequest && returns.closedReason && returns.requests.length === 0 && (
        <p className="text-xs text-muted-foreground">{t(returns.closedReason === 'return_window_closed' ? 'windowClosed' : 'unavailable')}</p>
      )}
      {open && (
        <form className="space-y-3 rounded-md border p-3" onSubmit={(e) => { e.preventDefault(); void send(); }}>
          {returns.lines.filter((l) => l.remaining > 0 && !l.open).map((l) => (
            <div key={l.id} className="space-y-1">
              <div className="flex items-center justify-between gap-2">
                <Label htmlFor={`ret-${l.id}`} className="min-w-0 flex-1 break-words">{l.name}</Label>
                <select id={`ret-${l.id}`} className="h-9 rounded-md border bg-background px-2 text-sm" value={qty[l.id] ?? 0}
                  onChange={(e) => setQty((q) => ({ ...q, [l.id]: Number(e.target.value) }))}>
                  {Array.from({ length: l.remaining + 1 }, (_, n) => <option key={n} value={n}>{n}</option>)}
                </select>
              </div>
              {(qty[l.id] ?? 0) > 0 && l.exchangeOptions.length > 0 && (
                <select aria-label={t('exchangeFor')} className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={exchange[l.id] ?? ''}
                  onChange={(e) => setExchange((x) => ({ ...x, [l.id]: e.target.value }))}>
                  <option value="">{t('returnOnly')}</option>
                  {l.exchangeOptions.map((o) => <option key={o.variantId} value={o.variantId}>{t('exchangeTo', { option: o.label })}</option>)}
                </select>
              )}
            </div>
          ))}
          <div className="space-y-1">
            <Label htmlFor="ret-reason">{t('reason')}</Label>
            <select id="ret-reason" required className="h-9 w-full rounded-md border bg-background px-2 text-sm" value={reason} onChange={(e) => setReason(e.target.value)}>
              <option value="">{t('pickReason')}</option>
              {REASONS.map((r) => <option key={r} value={r}>{t(`reasons.${r}`)}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="ret-note">{t('note')}</Label>
            <Textarea id="ret-note" rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">{t('afterSend')}</p>
          {error && (
            <p className="flex items-start gap-2 text-sm text-destructive" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {te(`errors.${error}`)}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="submit" disabled={busy || lines.length === 0 || !reason}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} {t('send')}
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setOpen(false)}>{t('cancel')}</Button>
          </div>
        </form>
      )}
    </section>
  );
}
