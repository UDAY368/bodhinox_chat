'use client';

/**
 * The customer's booking status page (design section 5.4). Shows business,
 * service, practitioner, place, local time with its zone, status and price;
 * never the customer's name, phone or notes, because these links get
 * forwarded. Cancel and change time only before the workspace's cutoff.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { AppointmentStatusBadge } from '@/components/appointments/appointment-status-badge';
import { SlotPicker } from '@/components/appointments/slot-picker';
import { zoneLabel } from '@/lib/appointments/time';
import type { Slot } from '@/lib/appointments/types';
import {
  bookingApi, errorCode, formatPrice, formatWhen, shiftWindow, slotDates, todayIn, WINDOW_DAYS,
  type ManageView, type PublicErrorCode, type PublicSlot,
} from './api';

type Mode = 'view' | 'cancel' | 'reschedule';

export function ManageBooking({ token }: { token: string }) {
  const t = useTranslations('BookingManage');
  const tp = useTranslations('BookingPublic');
  const locale = useLocale();
  const [view, setView] = useState<ManageView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PublicErrorCode | null>(null);
  const [notice, setNotice] = useState<'cancelled' | 'rescheduled' | null>(null);
  const [windowFrom, setWindowFrom] = useState<string | null>(null);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<PublicSlot | null>(null);

  useEffect(() => {
    let live = true;
    bookingApi.manage(token)
      .then((data) => { if (live) { setView(data); setLoadState('ready'); } })
      .catch((e) => { if (live) setLoadState(errorCode(e) === 'not_found' ? 'not_found' : 'error'); });
    return () => { live = false; };
  }, [token]);

  const today = useMemo(() => (view ? todayIn(view.timezone) : null), [view]);

  const loadSlots = useCallback(async (from: string) => {
    setSlotsLoading(true);
    setError(null);
    setSlot(null);
    try {
      const data = await bookingApi.manageSlots(token, { from, days: WINDOW_DAYS });
      setSlots(data.slots);
      setSelectedDate(slotDates(data.slots)[0] ?? null);
    } catch (e) {
      setSlots([]);
      setSelectedDate(null);
      const code = errorCode(e);
      setError(code === 'not_found' ? 'error' : code);
    } finally {
      setSlotsLoading(false);
    }
  }, [token]);

  function openReschedule() {
    if (!today) return;
    setMode('reschedule');
    setNotice(null);
    setWindowFrom(today);
    void loadSlots(today);
  }

  function pageDates(by: number) {
    if (!windowFrom || !today) return;
    const next = shiftWindow(windowFrom, by);
    const from = next < today ? today : next;
    setWindowFrom(from);
    void loadSlots(from);
  }

  async function change(action: 'cancel' | 'reschedule') {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const next = await bookingApi.change(token, {
        action, expectedVersion: view.version, ...(action === 'reschedule' && slot ? { startAt: slot.startAt } : {}),
      });
      setView(next);
      setMode('view');
      setNotice(action === 'cancel' ? 'cancelled' : 'rescheduled');
    } catch (e) {
      const code = errorCode(e);
      setError(code === 'not_found' ? 'error' : code);
      if (action === 'reschedule' && code === 'slot_unavailable' && windowFrom) void loadSlots(windowFrom);
    } finally {
      setBusy(false);
    }
  }

  if (loadState === 'loading') {
    return <div className="text-muted-foreground flex w-full max-w-lg justify-center py-20"><Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading')} /></div>;
  }
  if (loadState !== 'ready' || !view) {
    return (
      <Card className="h-fit w-full max-w-lg">
        <CardHeader><CardTitle>{loadState === 'not_found' ? t('notFound') : t('error')}</CardTitle></CardHeader>
      </Card>
    );
  }

  const price = view.priceMinor === 0 ? tp('free') : formatPrice(view.priceMinor, view.currency, locale);
  const zone = zoneLabel(new Date(view.startAt), view.timezone, locale);
  const dates = slotDates(slots);

  return (
    <Card className="h-fit w-full max-w-lg">
      <CardHeader>
        <CardDescription>{view.businessName}</CardDescription>
        <CardTitle className="flex items-center justify-between gap-2">
          {t('title')}
          <AppointmentStatusBadge status={view.status} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {notice && <p className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm" role="status">{t(notice)}</p>}
        {error && (
          <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <span>{tp(`errors.${error}`)}</span>
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{t('service')}</dt>
          <dd>{view.serviceName}</dd>
          {view.practitioner && (<><dt className="text-muted-foreground">{t('practitioner')}</dt><dd>{view.practitioner}</dd></>)}
          <dt className="text-muted-foreground">{t('location')}</dt>
          <dd>
            {view.online ? t('online') : view.location?.name}
            {!view.online && view.location?.address && <span className="text-muted-foreground block text-xs">{view.location.address}</span>}
          </dd>
          <dt className="text-muted-foreground">{t('when')}</dt>
          <dd data-testid="booking-when">
            {formatWhen(view.startAt, view.timezone, locale)}
            <span className="text-muted-foreground block text-xs">{tp('timesShownIn', { zone })}</span>
          </dd>
          {price && (<><dt className="text-muted-foreground">{t('price')}</dt><dd>{price}</dd></>)}
        </dl>

        {view.meetingUrl && (
          <a href={view.meetingUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: 'outline' })}>
            <ExternalLink className="size-4" />
            {t('meetingLink')}
          </a>
        )}
        {view.meetingLinkLater && <p className="text-muted-foreground text-xs">{t('meetingLinkLater')}</p>}

        {view.status === 'confirmed' && !view.canChange && <p className="text-muted-foreground text-sm">{t('cutoffPassed')}</p>}

        {view.canChange && mode === 'view' && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={openReschedule}>{t('reschedule')}</Button>
            <Button type="button" variant="destructive" onClick={() => { setMode('cancel'); setNotice(null); setError(null); }}>{t('cancel')}</Button>
          </div>
        )}

        {view.canChange && mode === 'cancel' && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm">{t('cancelConfirm')}</p>
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="destructive" disabled={busy} onClick={() => void change('cancel')}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('cancel')}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => setMode('view')}>{t('keepBooking')}</Button>
            </div>
          </div>
        )}

        {view.canChange && mode === 'reschedule' && (
          <div className="space-y-3 rounded-md border p-3">
            <h2 className="text-sm font-medium">{t('chooseNewTime')}</h2>
            <SlotPicker
              dates={dates}
              selectedDate={selectedDate}
              onDateChange={(d) => { setSelectedDate(d); setSlot(null); }}
              slots={slots.filter((s) => s.localDate === selectedDate) as Slot[]}
              selectedStartAt={slot?.startAt ?? null}
              onSelect={(s) => setSlot(s)}
              timeZone={view.timezone}
              loading={slotsLoading}
              onPreviousDates={windowFrom && today && windowFrom > today ? () => pageDates(-WINDOW_DAYS) : undefined}
              onNextDates={() => pageDates(WINDOW_DAYS)}
              disabled={slotsLoading || busy}
            />
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={!slot || busy} onClick={() => void change('reschedule')}>
                {busy && <Loader2 className="size-4 animate-spin" />}
                {t('saveTime')}
              </Button>
              <Button type="button" variant="ghost" disabled={busy} onClick={() => { setMode('view'); setError(null); }}>{tp('back')}</Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
