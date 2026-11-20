'use client';

/**
 * The customer's booking status page (design section 5.4). Shows business,
 * service, practitioner, place, local time with its zone, status and price;
 * never the customer's name, phone or notes, because these links get
 * forwarded. Cancel and change time only before the workspace's cutoff.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { ExternalLink, Loader2 } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { AppointmentStatusBadge } from '@/components/appointments/appointment-status-badge';
import { SlotPicker } from '@/components/appointments/slot-picker';
import { googleCalendarUrl } from '@/lib/appointments/calendar';
import { zoneLabel } from '@/lib/appointments/time';
import type { Slot } from '@/lib/appointments/types';
import { cn } from '@/lib/utils';
import {
  bookingApi, errorCode, formatWhen, shiftWindow, slotDates, todayIn, WINDOW_DAYS,
  type ManageView, type PublicErrorCode, type PublicSlot,
} from './api';
import { icsPath, priceText } from './flow-helpers';
import {
  BottomBar, CalendarButtons, ErrorState, Group, InfoRow, InlineError, PageSkeleton, PageTitle, TAP,
} from './parts';

type Mode = 'view' | 'cancel' | 'reschedule';

export function ManageBooking({ token }: { token: string }) {
  const t = useTranslations('BookingManage');
  const tp = useTranslations('BookingPublic');
  const locale = useLocale();
  const [view, setView] = useState<ManageView | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [loadKey, setLoadKey] = useState(0);
  const [mode, setMode] = useState<Mode>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PublicErrorCode | null>(null);
  const [notice, setNotice] = useState<'cancelled' | 'rescheduled' | null>(null);
  const [windowFrom, setWindowFrom] = useState<string | null>(null);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  const [slotsLoading, setSlotsLoading] = useState(false);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<PublicSlot | null>(null);
  /** When the view was loaded: "is it over" is judged against this, not the render clock. */
  const [loadedAt, setLoadedAt] = useState(0);

  useEffect(() => {
    let live = true;
    bookingApi.manage(token)
      .then((data) => { if (live) { setView(data); setLoadedAt(Date.now()); setLoadState('ready'); } })
      .catch((e) => { if (live) setLoadState(errorCode(e) === 'not_found' ? 'not_found' : 'error'); });
    return () => { live = false; };
  }, [token, loadKey]);

  const today = useMemo(() => (view ? todayIn(view.timezone) : null), [view]);
  const ended = view ? Date.parse(view.endAt) <= loadedAt : false;

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
      setLoadedAt(Date.now());
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

  if (loadState === 'loading') return <PageSkeleton label={t('loading')} rows={4} />;
  if (loadState !== 'ready' || !view) {
    return loadState === 'not_found'
      ? <ErrorState title={t('notFound')} />
      : <ErrorState title={t('error')} onRetry={() => { setLoadState('loading'); setLoadKey((k) => k + 1); }} />;
  }

  const price = priceText(view.priceMinor, view.currency, locale, tp('free'));
  const zone = zoneLabel(new Date(view.startAt), view.timezone, locale);
  const dates = slotDates(slots);
  const place = view.online ? null : [view.location?.name, view.location?.address].filter(Boolean).join(', ') || null;
  const calendar = view.status === 'confirmed' && !ended;
  const google = calendar ? googleCalendarUrl({
    title: `${view.serviceName} · ${view.businessName}`, start: view.startAt, end: view.endAt, location: place,
    url: typeof window === 'undefined' ? null : `${window.location.origin}/my-booking/${token}`,
  }) : null;

  return (
    <div className="w-full max-w-lg space-y-6">
      <PageTitle eyebrow={view.businessName} title={mode === 'reschedule' ? t('chooseNewTime') : t('title')}
        onBack={mode === 'reschedule' ? () => { setMode('view'); setError(null); } : undefined} backLabel={tp('back')} />
      {notice && <p className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm" role="status">{t(notice)}</p>}
      {error && <InlineError text={tp(`errors.${error}`)} />}

      {mode !== 'reschedule' && (
        <Group>
          <InfoRow label={t('status')}><AppointmentStatusBadge status={view.status} /></InfoRow>
          <InfoRow label={t('service')}>{view.serviceName}</InfoRow>
          {view.practitioner && <InfoRow label={t('practitioner')}>{view.practitioner}</InfoRow>}
          <InfoRow label={t('location')}>
            {view.online ? t('online') : view.location?.name}
            {!view.online && view.location?.address && <span className="text-muted-foreground block text-xs">{view.location.address}</span>}
          </InfoRow>
          <InfoRow label={t('when')} testId="booking-when">
            {formatWhen(view.startAt, view.timezone, locale)}
            <span className="text-muted-foreground block text-xs">{tp('timesShownIn', { zone })}</span>
          </InfoRow>
          {price && <InfoRow label={t('price')}>{price}</InfoRow>}
        </Group>
      )}

      {mode === 'view' && view.meetingUrl && (
        <a href={view.meetingUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), TAP, 'w-full')}>
          <ExternalLink className="size-4" />
          {t('meetingLink')}
        </a>
      )}
      {mode === 'view' && view.meetingLinkLater && <p className="text-muted-foreground px-1 text-sm">{t('meetingLinkLater')}</p>}
      {/* Inside the link window but the online meeting is not ready yet (being created, or staff will send it). */}
      {mode === 'view' && view.online && view.status === 'confirmed' && !view.meetingUrl && !view.meetingLinkLater && !ended && (
        <p className="text-muted-foreground px-1 text-sm" data-testid="meeting-link-pending">{tp('meetingLinkPending')}</p>
      )}

      {mode === 'view' && google && <CalendarButtons icsHref={icsPath(token)} googleHref={google} />}

      {view.status === 'confirmed' && !view.canChange && <p className="text-muted-foreground px-1 text-sm">{t('cutoffPassed')}</p>}

      {view.canChange && mode === 'view' && (
        <>
          <div className="h-32 sm:hidden" aria-hidden />
          <BottomBar>
            <Button type="button" variant="ghost" className={cn(TAP, 'w-full text-destructive sm:w-auto')}
              onClick={() => { setMode('cancel'); setNotice(null); setError(null); }}>
              {t('cancel')}
            </Button>
            <Button type="button" className={cn(TAP, 'w-full sm:w-auto sm:px-8')} onClick={openReschedule}>{t('reschedule')}</Button>
          </BottomBar>
        </>
      )}

      {view.canChange && mode === 'cancel' && (
        <div className="space-y-3 rounded-xl border bg-card p-4" role="alertdialog" aria-labelledby="cancel-question">
          <p id="cancel-question" className="font-medium">{t('cancelConfirm')}</p>
          <p className="text-muted-foreground text-sm">{t('cancelHelp')}</p>
          <div className="grid gap-2 sm:grid-cols-2">
            <Button type="button" variant="destructive" className={TAP} disabled={busy} onClick={() => void change('cancel')}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('cancel')}
            </Button>
            <Button type="button" variant="outline" className={TAP} disabled={busy} onClick={() => setMode('view')}>{t('keepBooking')}</Button>
          </div>
        </div>
      )}

      {view.canChange && mode === 'reschedule' && (
        <>
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
          <div className="h-20 sm:hidden" aria-hidden />
          <BottomBar>
            <Button type="button" className={cn(TAP, 'w-full sm:w-auto sm:px-8')} disabled={!slot || busy} onClick={() => void change('reschedule')}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('saveTime')}
            </Button>
          </BottomBar>
        </>
      )}
    </div>
  );
}
