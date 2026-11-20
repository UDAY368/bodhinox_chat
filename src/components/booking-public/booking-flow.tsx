'use client';

/**
 * Anonymous booking (design section 5, journey J2) in three steps: Service,
 * Time, Confirm. A place or practitioner choice appears only when there is
 * more than one. The hold is confirmed by sending "BOOK <code>" on WhatsApp:
 * there is no phone field, the WhatsApp sender becomes the customer (D7).
 * After the hold the page waits for the code (and, for a paid service, the
 * payment) and turns into "Booked" without a reload.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarX, Check, Copy, Loader2, MessageCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SlotPicker } from '@/components/appointments/slot-picker';
import { googleCalendarUrl } from '@/lib/appointments/calendar';
import type { Slot } from '@/lib/appointments/types';
import { cn } from '@/lib/utils';
import {
  bookingApi, errorCode, formatWhen, newRequestId, shiftWindow, slotDates, todayIn, WINDOW_DAYS,
  type HoldResponse, type PublicErrorCode, type PublicLocation, type PublicPage, type PublicService, type PublicSlot,
} from './api';
import {
  FLOW_STEPS, icsPath, locationForStaff, nextPollDelay, preselect, priceText, serviceSelection, tokenFromManagePath,
  type FlowStep, type HoldState,
} from './flow-helpers';
import {
  BookingHeader, BottomBar, CalendarButtons, InfoRow, TAP,
} from './parts';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';

export interface BookingQuery { service?: string | null; staff?: string | null }

export function BookingFlow({ slug, query = {} }: { slug: string; query?: BookingQuery }) {
  const t = useTranslations('BookingPublic');
  const locale = useLocale();
  const [page, setPage] = useState<PublicPage | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [loadKey, setLoadKey] = useState(0);
  const [step, setStep] = useState<FlowStep>('service');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string>('');
  const [staffFilter, setStaffFilter] = useState<string | null>(null);
  const [windowFrom, setWindowFrom] = useState<string | null>(null);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  // True until the first slots answer: the picker must not say "no free dates" before it has asked.
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<PublicSlot | null>(null);
  const [intake, setIntake] = useState({ name: '', city: '', state: '' });
  const [requestId, setRequestId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<PublicErrorCode | null>(null);
  const [hold, setHold] = useState<HoldResponse | null>(null);

  const wantService = query.service ?? null;
  const wantStaff = query.staff ?? null;
  useEffect(() => {
    let live = true;
    bookingApi.page(slug)
      .then((data) => {
        if (!live) return;
        setPage(data);
        setLoadState(data.services.length ? 'ready' : 'not_found');
        const pick = preselect(data.services, { service: wantService, staff: wantStaff });
        setServiceId(pick.serviceId);
        setLocationId(pick.locationId);
        setStaffId(pick.staffId);
        setStaffFilter(pick.staffFilter);
        setStep(pick.step);
      })
      .catch((e) => { if (live) setLoadState(errorCode(e) === 'not_found' ? 'not_found' : 'error'); });
    return () => { live = false; };
  }, [slug, wantService, wantStaff, loadKey]);

  const services = useMemo(() => (page?.services ?? []).filter((s) =>
    !staffFilter || s.locations.some((l) => l.staff.some((st) => st.id === staffFilter))), [page, staffFilter]);
  const service = page?.services.find((s) => s.id === serviceId) ?? null;
  const location = service?.locations.find((l) => l.id === locationId) ?? null;
  const timeZone = location?.timezone ?? null;
  const today = useMemo(() => (timeZone ? todayIn(timeZone) : null), [timeZone]);

  const resetSlot = () => { setSlot(null); setRequestId(null); setError(null); };

  const loadSlots = useCallback(async (from: string) => {
    if (!serviceId || !locationId) return;
    setSlotsLoading(true);
    setError(null);
    try {
      const data = await bookingApi.slots(slug, { serviceId, locationId, staffId: staffId || undefined, from, days: WINDOW_DAYS });
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
  }, [slug, serviceId, locationId, staffId]);

  useEffect(() => {
    if (!today || !serviceId || !locationId) return;
    setWindowFrom(today);
    resetSlot();
    void loadSlots(today);
  }, [today, serviceId, locationId, staffId, loadSlots]);

  const pageDates = (by: number) => {
    if (!windowFrom || !today) return;
    const next = shiftWindow(windowFrom, by);
    const from = next < today ? today : next;
    setWindowFrom(from);
    resetSlot();
    void loadSlots(from);
  };

  function chooseService(s: PublicService) {
    const next = serviceSelection(serviceId, s);
    if (!next) {
      if (locationId) setStep('time');
      return;
    }
    // A practitioner link keeps that practitioner and their place.
    const keepStaff = staffFilter && s.locations.some((l) => l.staff.some((st) => st.id === staffFilter)) ? staffFilter : '';
    setServiceId(next.serviceId);
    setLocationId(keepStaff ? locationForStaff(s, keepStaff) : next.locationId);
    setStaffId(keepStaff);
    const place = keepStaff ? locationForStaff(s, keepStaff) : next.locationId;
    if (place) setStep('time');
  }

  function chooseLocation(l: PublicLocation) {
    setLocationId(l.id);
    setStaffId(staffFilter && l.staff.some((st) => st.id === staffFilter) ? staffFilter : '');
    setStep('time');
  }

  async function submit() {
    if (!service || !location || !slot) return;
    const id = requestId ?? newRequestId();
    setRequestId(id);
    setSubmitting(true);
    setError(null);
    try {
      const details = Object.fromEntries(Object.entries(intake).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
      const result = await bookingApi.hold(slug, {
        serviceId: service.id, locationId: location.id, staffId: staffId || undefined, startAt: slot.startAt, requestId: id,
        intake: Object.keys(details).length ? details : undefined,
      });
      setHold(result);
    } catch (e) {
      const code = errorCode(e);
      setError(code === 'not_found' ? 'error' : code);
      if (code === 'slot_unavailable' || code === 'day_not_allowed') {
        setStep('time');
        setSlot(null);
        setRequestId(null);
        if (windowFrom) void loadSlots(windowFrom);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loadState === 'loading') return <PageLoading rows={4} className="w-full max-w-lg" />;
  if (loadState !== 'ready' || !page) {
    return loadState === 'not_found'
      ? <EmptyState icon={CalendarX} title={t('notFound')} className="w-full max-w-lg" />
      : <InlineError message={t('error')} className="w-full max-w-lg" onRetry={() => { setLoadState('loading'); setLoadKey((k) => k + 1); }} />;
  }

  if (hold && requestId && service && location) {
    return (
      <HoldScreen
        slug={slug}
        requestId={requestId}
        hold={hold}
        businessName={page.businessName}
        service={service}
        location={location}
        practitioner={location.staff.find((s) => s.id === staffId)?.displayName ?? null}
        onRestart={() => { setHold(null); setStep('time'); resetSlot(); if (windowFrom) void loadSlots(windowFrom); }}
      />
    );
  }

  const stepIndex = FLOW_STEPS.indexOf(step) + 1;
  const stepLabel = t('stepOf', { step: stepIndex, total: FLOW_STEPS.length });
  const price = service ? priceText(service.priceMinor, service.currency, locale, t('free')) : null;
  const dates = slotDates(slots);
  const back = step === 'time' ? () => setStep('service') : step === 'confirm' ? () => setStep('time') : undefined;
  const titles: Record<FlowStep, string> = { service: t('chooseService'), time: t('chooseTime'), confirm: t('confirmTitle') };

  return (
    <div className="w-full max-w-lg space-y-6">
      <BookingHeader subtitle={`${page.businessName} · ${stepLabel}`} title={titles[step]} onBack={back} backLabel={t('back')} />
      {error && <InlineError className="py-4" message={t(`errors.${error}`)} />}

      {step === 'service' && (
        <>
          <GroupedList>
            {services.map((s) => (
              <GroupedListRow
                key={s.id}
                selected={s.id === serviceId}
                onClick={() => chooseService(s)}
                title={s.name}
                subtitle={[t('duration', { minutes: s.durationMinutes }), s.mode === 'online' ? t('online') : t('inPerson'),
                  s.paymentRequired ? t('payInAdvance') : null].filter(Boolean).join(' · ')}
                trailing={<span data-testid="service-price">{priceText(s.priceMinor, s.currency, locale, t('free'))}</span>}
              />
            ))}
          </GroupedList>
          {service && service.locations.length > 1 && (
            <GroupedList header={t('chooseLocation')}>
              {service.locations.filter((l) => !staffFilter || l.staff.some((st) => st.id === staffFilter)).map((l) => (
                <GroupedListRow key={l.id} selected={l.id === locationId} onClick={() => chooseLocation(l)} title={l.name} subtitle={l.address} />
              ))}
            </GroupedList>
          )}
        </>
      )}

      {step === 'time' && service && location && timeZone && (
        <>
          <GroupedList>
            <InfoRow label={service.name}>{[t('duration', { minutes: service.durationMinutes }), price].filter(Boolean).join(' · ')}</InfoRow>
          </GroupedList>
          {location.staff.length > 1 && (
            <section className="space-y-2">
              <h2 className="text-muted-foreground px-1 text-xs font-medium uppercase tracking-wide">{t('chooseStaff')}</h2>
              <div className="flex flex-wrap gap-2" role="group" aria-label={t('chooseStaff')}>
                {[{ id: '', displayName: t('anyStaff') }, ...location.staff].map((s) => (
                  <Button key={s.id || 'any'} type="button" className={TAP} variant={staffId === s.id ? 'default' : 'outline'}
                    aria-pressed={staffId === s.id} onClick={() => setStaffId(s.id)}>
                    {s.displayName}
                  </Button>
                ))}
              </div>
            </section>
          )}
          <SlotPicker
            dates={dates}
            selectedDate={selectedDate}
            onDateChange={(d) => { setSelectedDate(d); setSlot(null); setRequestId(null); }}
            slots={slots.filter((s) => s.localDate === selectedDate) as Slot[]}
            selectedStartAt={slot?.startAt ?? null}
            onSelect={(s) => { setSlot(s); setRequestId(null); setError(null); }}
            timeZone={timeZone}
            loading={slotsLoading}
            showRemaining={service.group}
            onPreviousDates={windowFrom && today && windowFrom > today ? () => pageDates(-WINDOW_DAYS) : undefined}
            onNextDates={() => pageDates(WINDOW_DAYS)}
            disabled={slotsLoading}
          />
          {dates.length === 0 && !slotsLoading && (
            <Button type="button" variant="outline" className={TAP} onClick={() => pageDates(WINDOW_DAYS)}>{t('moreDates')}</Button>
          )}
          <BottomBar>
            <Button type="button" className={cn(TAP, 'w-full sm:w-auto sm:px-8')} disabled={!slot} onClick={() => { setError(null); setStep('confirm'); }}>
              {t('continue')}
            </Button>
          </BottomBar>
        </>
      )}

      {step === 'confirm' && service && location && slot && timeZone && (
        <>
          <GroupedList>
            <InfoRow label={t('summaryService')}>{service.name}</InfoRow>
            <InfoRow label={t('summaryWhen')}>{formatWhen(slot.startAt, timeZone, locale)}</InfoRow>
            <InfoRow label={t('summaryWhere')}>{service.mode === 'online' ? t('online') : location.name}</InfoRow>
            {staffId && <InfoRow label={t('summaryWith')}>{location.staff.find((s) => s.id === staffId)?.displayName}</InfoRow>}
            {price && <InfoRow label={t('summaryPrice')}>{price}</InfoRow>}
          </GroupedList>
          <GroupedList header={t('details')} footer={t('serviceNotice')}>
            {(['name', 'city', 'state'] as const).map((field) => (
              <div key={field} className="grid gap-1 px-4 py-3">
                <Label htmlFor={`booking-${field}`}>{t(field)}</Label>
                <Input
                  id={`booking-${field}`}
                  className="h-11"
                  value={intake[field]}
                  maxLength={field === 'name' ? 120 : 80}
                  autoComplete={field === 'name' ? 'name' : field === 'city' ? 'address-level2' : 'address-level1'}
                  onChange={(e) => setIntake((v) => ({ ...v, [field]: e.target.value }))}
                />
              </div>
            ))}
          </GroupedList>
          {service.paymentRequired && <p className="text-muted-foreground px-1 text-sm">{t('paymentNotice')}</p>}
          <BottomBar>
            <Button type="button" className={cn(TAP, 'w-full sm:w-auto sm:px-8')} onClick={() => void submit()} disabled={submitting}>
              {submitting && <Loader2 className="size-4 animate-spin" />}
              {t('continue')}
            </Button>
          </BottomBar>
        </>
      )}
      {/* Room for the pinned bottom button on phones. */}
    </div>
  );
}

function HoldScreen({ slug, requestId, hold, businessName, service, location, practitioner, onRestart }: {
  slug: string; requestId: string; hold: HoldResponse; businessName: string; service: PublicService; location: PublicLocation;
  practitioner: string | null; onRestart: () => void;
}) {
  const t = useTranslations('BookingPublic');
  const locale = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [state, setState] = useState<HoldState>('held');
  const [managePath, setManagePath] = useState<string | null>(null);
  const expiresAt = useMemo(() => new Date(hold.holdExpiresAt).getTime(), [hold.holdExpiresAt]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);

  // Wait for the WhatsApp code (and payment): poll only while the tab is visible, back off, stop on a final state.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let stopped = false;
    let inFlight = false;
    let current: HoldState = 'held';
    const started = Date.now();
    const schedule = (failed: boolean) => {
      const delay = nextPollDelay({ state: current, elapsedMs: Date.now() - started, msToExpiry: expiresAt - Date.now(), failed });
      if (delay === null) stopped = true;
      else timer = setTimeout(() => void tick(), delay);
    };
    const tick = async () => {
      timer = null;
      if (closed || stopped || document.visibilityState !== 'visible') return; // resumes when the tab is shown again
      inFlight = true;
      let failed = false;
      try {
        const result = await bookingApi.holdStatus(slug, requestId);
        current = result.status;
        if (!closed) {
          setState(result.status);
          if (result.managePath) setManagePath(result.managePath);
        }
      } catch (e) {
        if (errorCode(e) === 'not_found') current = 'expired';
        else failed = true;
        if (!closed && current === 'expired') setState('expired');
      } finally {
        inFlight = false;
      }
      if (!closed) schedule(failed);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible' && !timer && !inFlight && !stopped && !closed) void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule(false);
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [slug, requestId, expiresAt]);

  const minutes = Math.max(0, Math.ceil((expiresAt - now) / 60_000));
  // The countdown ran out locally; a code sent at the last second can still flip it to Booked.
  const shown: HoldState = state === 'held' && minutes === 0 ? 'expired' : state;
  const when = formatWhen(hold.startAt, hold.timezone, locale);
  const message = `BOOK ${hold.holdCode}`;

  if (shown === 'confirmed') {
    const token = tokenFromManagePath(managePath);
    const origin = typeof window === 'undefined' ? '' : window.location.origin;
    const place = service.mode === 'online' ? null : [location.name, location.address].filter(Boolean).join(', ');
    const google = googleCalendarUrl({
      title: `${service.name} · ${businessName}`, start: hold.startAt, end: hold.endAt, location: place,
      url: managePath && origin ? `${origin}${managePath}` : null,
    });
    return (
      <div className="w-full max-w-lg space-y-6" data-testid="booking-confirmed">
        <div className="flex flex-col items-center gap-3 pt-4 text-center">
          <span className="flex size-14 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600"><Check className="size-7" aria-hidden /></span>
          <BookingHeader subtitle={businessName} title={t('bookedTitle')} />
          <p className="text-muted-foreground text-sm">{t('bookedHelp')}</p>
        </div>
        <GroupedList>
          <InfoRow label={t('summaryService')}>{service.name}</InfoRow>
          <InfoRow label={t('summaryWhen')}>{when}</InfoRow>
          <InfoRow label={t('summaryWhere')}>{service.mode === 'online' ? t('online') : location.name}</InfoRow>
          {practitioner && <InfoRow label={t('summaryWith')}>{practitioner}</InfoRow>}
        </GroupedList>
        <CalendarButtons icsHref={token ? icsPath(token) : null} googleHref={google} />
        {managePath && (
          <a href={managePath} className={cn(buttonVariants({ variant: 'ghost' }), TAP, 'w-full')}>{t('viewBooking')}</a>
        )}
      </div>
    );
  }

  if (shown === 'expired' || shown === 'cancelled') {
    return (
      <div className="w-full max-w-lg space-y-6">
        <BookingHeader subtitle={businessName} title={t('expiredTitle')} />
        <p className="text-sm" role="alert">{t('expired')}</p>
        <BottomBar>
          <Button type="button" className={cn(TAP, 'w-full sm:w-auto sm:px-8')} onClick={onRestart}>{t('startOver')}</Button>
        </BottomBar>
      </div>
    );
  }

  if (shown === 'payment_pending') {
    return (
      <div className="w-full max-w-lg space-y-6" data-testid="booking-waiting-payment">
        <BookingHeader subtitle={businessName} title={t('waitingPaymentTitle')} />
        <p className="text-sm">{t('waitingPaymentHelp')}</p>
        <GroupedList>
          <InfoRow label={t('summaryService')}>{service.name}</InfoRow>
          <InfoRow label={t('summaryWhen')}>{when}</InfoRow>
        </GroupedList>
        <Waiting text={t('waitingForPayment')} />
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg space-y-6">
      <BookingHeader subtitle={businessName} title={t('sendCodeTitle')} />
      <p className="text-sm">{t('heldFor', { when })}</p>
      <p className="text-muted-foreground text-sm">{hold.whatsappUrl ? t('sendCodeHelp') : t('noWhatsAppLink', { business: businessName })}</p>
      <div className="rounded-xl border bg-card p-5 text-center">
        <div className="text-muted-foreground text-xs">{t('messageToSend')}</div>
        <div className="font-mono text-3xl tracking-widest" data-testid="booking-hold-message">{message}</div>
      </div>
      {service.paymentRequired && <p className="text-sm" data-testid="booking-payment-note">{t('paymentAfterCode')}</p>}
      <Waiting text={t('waitingForCode')} />
      <p className="text-muted-foreground text-xs">{t('expiresIn', { minutes })}</p>
      <BottomBar>
        <Button
          type="button"
          variant={hold.whatsappUrl ? 'outline' : 'default'}
          className={cn(TAP, 'w-full sm:w-auto')}
          onClick={() => { void navigator.clipboard?.writeText(message).then(() => setCopied(true), () => undefined); }}
        >
          {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
          {copied ? t('copied') : t('copy')}
        </Button>
        {hold.whatsappUrl && (
          <a href={hold.whatsappUrl} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), TAP, 'w-full sm:w-auto')}>
            <MessageCircle className="size-4" />
            {t('openWhatsApp')}
          </a>
        )}
      </BottomBar>
    </div>
  );
}

function Waiting({ text }: { text: string }) {
  return (
    <p className="text-muted-foreground flex items-center gap-2 text-sm" role="status" aria-live="polite">
      <span className="relative flex size-2.5">
        <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/50 motion-reduce:animate-none" />
        <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
      </span>
      {text}
    </p>
  );
}
