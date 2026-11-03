'use client';

/**
 * Anonymous booking (design section 5, journey J2): service, then place and
 * practitioner, then date and time, then optional details, then a hold
 * confirmed by sending "BOOK <code>" on WhatsApp. There is no phone field:
 * the WhatsApp sender becomes the customer (design D7).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { AlertTriangle, Check, Copy, Loader2, MessageCircle } from 'lucide-react';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SlotPicker } from '@/components/appointments/slot-picker';
import type { Slot } from '@/lib/appointments/types';
import {
  bookingApi, errorCode, formatPrice, formatWhen, newRequestId, shiftWindow, slotDates, todayIn, WINDOW_DAYS,
  type HoldResponse, type PublicErrorCode, type PublicPage, type PublicSlot,
} from './api';

type Step = 'choose' | 'details' | 'code';

type ServiceChoice = { id: string; locations: { id: string }[] };

/**
 * The service/location selection after a service card is clicked (pure; tested).
 * Re-clicking the chosen service changes nothing; a service with one location
 * gets that location at once, since no location chooser is shown for it.
 */
export function serviceSelection(currentServiceId: string | null, s: ServiceChoice): { serviceId: string; locationId: string | null } | null {
  if (s.id === currentServiceId) return null;
  return { serviceId: s.id, locationId: s.locations.length === 1 ? s.locations[0].id : null };
}

export function BookingFlow({ slug }: { slug: string }) {
  const t = useTranslations('BookingPublic');
  const locale = useLocale();
  const [page, setPage] = useState<PublicPage | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ready' | 'not_found' | 'error'>('loading');
  const [serviceId, setServiceId] = useState<string | null>(null);
  const [locationId, setLocationId] = useState<string | null>(null);
  const [staffId, setStaffId] = useState<string>('');
  const [windowFrom, setWindowFrom] = useState<string | null>(null);
  const [slots, setSlots] = useState<PublicSlot[]>([]);
  // True until the first slots answer: the picker must not say "no free dates" before it has asked.
  const [slotsLoading, setSlotsLoading] = useState(true);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const [slot, setSlot] = useState<PublicSlot | null>(null);
  const [step, setStep] = useState<Step>('choose');
  const [intake, setIntake] = useState({ name: '', city: '', state: '' });
  const [requestId, setRequestId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<PublicErrorCode | null>(null);
  const [hold, setHold] = useState<HoldResponse | null>(null);

  useEffect(() => {
    let live = true;
    bookingApi.page(slug)
      .then((data) => {
        if (!live) return;
        setPage(data);
        setLoadState(data.services.length ? 'ready' : 'not_found');
        const only = data.services.length === 1 ? serviceSelection(null, data.services[0]) : null;
        if (only) {
          setServiceId(only.serviceId);
          setLocationId(only.locationId);
        }
      })
      .catch((e) => { if (live) setLoadState(errorCode(e) === 'not_found' ? 'not_found' : 'error'); });
    return () => { live = false; };
  }, [slug]);

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
      setStep('code');
    } catch (e) {
      const code = errorCode(e);
      setError(code === 'not_found' ? 'error' : code);
      if (code === 'slot_unavailable' || code === 'day_not_allowed') {
        setStep('choose');
        resetSlot();
        if (windowFrom) void loadSlots(windowFrom);
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (loadState === 'loading') return <Centered><Loader2 className="h-5 w-5 animate-spin" aria-label={t('loading')} /></Centered>;
  if (loadState !== 'ready' || !page) {
    return (
      <Card className="h-fit w-full max-w-lg">
        <CardHeader><CardTitle>{loadState === 'not_found' ? t('notFound') : t('error')}</CardTitle></CardHeader>
      </Card>
    );
  }

  if (step === 'code' && hold) {
    return <HoldScreen hold={hold} businessName={page.businessName} onRestart={() => { setHold(null); setStep('choose'); resetSlot(); if (windowFrom) void loadSlots(windowFrom); }} />;
  }

  const price = service ? (service.priceMinor === 0 ? t('free') : formatPrice(service.priceMinor, service.currency, locale)) : null;
  const dates = slotDates(slots);

  return (
    <Card className="h-fit w-full max-w-lg">
      <CardHeader>
        <CardDescription>{page.businessName}</CardDescription>
        <CardTitle>{page.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {error && <ErrorNote code={error} />}

        {step === 'choose' && (
          <>
            <Section title={t('chooseService')}>
              <div className="grid gap-2">
                {page.services.map((s) => (
                  <Choice key={s.id} selected={s.id === serviceId} onClick={() => {
                    const next = serviceSelection(serviceId, s);
                    if (!next) return;
                    setServiceId(next.serviceId);
                    setLocationId(next.locationId);
                    setStaffId('');
                  }}>
                    <span className="font-medium">{s.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {t('duration', { minutes: s.durationMinutes })} · {s.mode === 'online' ? t('online') : t('inPerson')}
                    </span>
                  </Choice>
                ))}
              </div>
            </Section>

            {service && service.locations.length > 1 && (
              <Section title={t('chooseLocation')}>
                <div className="grid gap-2">
                  {service.locations.map((l) => (
                    <Choice key={l.id} selected={l.id === locationId} onClick={() => { setLocationId(l.id); setStaffId(''); }}>
                      <span className="font-medium">{l.name}</span>
                      {l.address && <span className="text-muted-foreground text-xs">{l.address}</span>}
                    </Choice>
                  ))}
                </div>
              </Section>
            )}

            {location && location.staff.length > 1 && (
              <Section title={t('chooseStaff')}>
                <div className="flex flex-wrap gap-2">
                  <Button type="button" size="sm" variant={staffId === '' ? 'default' : 'outline'} onClick={() => setStaffId('')}>{t('anyStaff')}</Button>
                  {location.staff.map((s) => (
                    <Button key={s.id} type="button" size="sm" variant={staffId === s.id ? 'default' : 'outline'} onClick={() => setStaffId(s.id)}>
                      {s.displayName}
                    </Button>
                  ))}
                </div>
              </Section>
            )}

            {location && timeZone && (
              <div className="space-y-2">
                <SlotPicker
                  dates={dates}
                  selectedDate={selectedDate}
                  onDateChange={(d) => { setSelectedDate(d); resetSlot(); }}
                  slots={slots.filter((s) => s.localDate === selectedDate) as Slot[]}
                  selectedStartAt={slot?.startAt ?? null}
                  onSelect={(s) => { setSlot(s); setRequestId(null); }}
                  timeZone={timeZone}
                  loading={slotsLoading}
                  showRemaining={service?.group ?? false}
                  onPreviousDates={windowFrom && today && windowFrom > today ? () => pageDates(-WINDOW_DAYS) : undefined}
                  onNextDates={() => pageDates(WINDOW_DAYS)}
                  disabled={slotsLoading}
                />
                {dates.length === 0 && !slotsLoading && (
                  <Button type="button" variant="outline" size="sm" className="mt-2" onClick={() => pageDates(WINDOW_DAYS)}>{t('moreDates')}</Button>
                )}
              </div>
            )}

            <div className="flex justify-end">
              <Button type="button" disabled={!slot} onClick={() => { setError(null); setStep('details'); }}>{t('continue')}</Button>
            </div>
          </>
        )}

        {step === 'details' && service && location && slot && timeZone && (
          <>
            <div className="rounded-md border p-3 text-sm">
              <div className="font-medium">{service.name}</div>
              <div>{formatWhen(slot.startAt, timeZone, locale)}</div>
              <div className="text-muted-foreground text-xs">{location.name}</div>
              {price && <div className="text-muted-foreground text-xs">{t('price', { price })}</div>}
            </div>
            <Section title={t('details')}>
              <div className="grid gap-3">
                {(['name', 'city', 'state'] as const).map((field) => (
                  <div key={field} className="grid gap-1">
                    <Label htmlFor={`booking-${field}`}>{t(field)}</Label>
                    <Input
                      id={`booking-${field}`}
                      value={intake[field]}
                      maxLength={field === 'name' ? 120 : 80}
                      autoComplete={field === 'name' ? 'name' : field === 'city' ? 'address-level2' : 'address-level1'}
                      onChange={(e) => setIntake((v) => ({ ...v, [field]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
            </Section>
            <p className="text-muted-foreground text-xs">{t('serviceNotice')}</p>
            <div className="flex justify-between">
              <Button type="button" variant="ghost" onClick={() => setStep('choose')} disabled={submitting}>{t('back')}</Button>
              <Button type="button" onClick={() => void submit()} disabled={submitting}>
                {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                {t('continue')}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function HoldScreen({ hold, businessName, onRestart }: { hold: HoldResponse; businessName: string; onRestart: () => void }) {
  const t = useTranslations('BookingPublic');
  const locale = useLocale();
  const [now, setNow] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const minutes = Math.max(0, Math.ceil((new Date(hold.holdExpiresAt).getTime() - now) / 60_000));
  const message = `BOOK ${hold.holdCode}`;
  const expired = minutes === 0;

  return (
    <Card className="h-fit w-full max-w-lg">
      <CardHeader>
        <CardDescription>{businessName}</CardDescription>
        <CardTitle>{t('sendCodeTitle')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-sm">{t('heldFor', { when: formatWhen(hold.startAt, hold.timezone, locale) })}</p>
        {expired ? (
          <>
            <p className="text-sm text-destructive" role="alert">{t('expired')}</p>
            <Button type="button" onClick={onRestart}>{t('startOver')}</Button>
          </>
        ) : (
          <>
            <p className="text-muted-foreground text-sm">{hold.whatsappUrl ? t('sendCodeHelp') : t('noWhatsAppLink', { business: businessName })}</p>
            <div className="rounded-md border p-4 text-center">
              <div className="text-muted-foreground text-xs">{t('messageToSend')}</div>
              <div className="font-mono text-2xl tracking-widest" data-testid="booking-hold-message">{message}</div>
            </div>
            <div className="flex flex-wrap gap-2">
              {hold.whatsappUrl && (
                <a href={hold.whatsappUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants()}>
                  <MessageCircle className="size-4" />
                  {t('openWhatsApp')}
                </a>
              )}
              <Button
                type="button"
                variant="outline"
                onClick={() => { void navigator.clipboard?.writeText(message).then(() => setCopied(true), () => undefined); }}
              >
                {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
                {copied ? t('copied') : t('copy')}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">{t('expiresIn', { minutes })}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

function ErrorNote({ code }: { code: PublicErrorCode }) {
  const t = useTranslations('BookingPublic.errors');
  return (
    <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm" role="alert">
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{t(code)}</span>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="text-sm font-medium">{title}</h2>
      {children}
    </section>
  );
}

function Choice({ selected, onClick, children }: { selected: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={`flex flex-col items-start gap-0.5 rounded-md border p-3 text-left transition-colors ${selected ? 'border-primary bg-primary/5' : 'hover:bg-muted'}`}
    >
      {children}
    </button>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="text-muted-foreground flex w-full max-w-lg items-center justify-center py-20">{children}</div>;
}
