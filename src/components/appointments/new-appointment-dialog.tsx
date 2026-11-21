'use client';

/**
 * Staff booking: pick a customer (existing contact), a service, a location
 * that offers it, optionally a practitioner, then a free time. The server
 * re-checks the slot under its locks and confirms at once; the customer's
 * confirmation and reminders are queued with the booking.
 */
import { OptionSelect } from '@/components/ui/option-select';
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useLocale, useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { ContactPicker, type PickedContact } from '@/components/ui/contact-picker';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import type { Slot } from '@/lib/appointments/types';
import { SlotSelector } from './slot-selector';
import { apiRequest, useFailureText, type AppointmentConfig } from './shared';

/** Locations offering a service, and whether it is pooled there (pure; tested). */
export function offeringChoices(config: Pick<AppointmentConfig, 'offerings' | 'locations' | 'staff'>, serviceId: string) {
  const rows = config.offerings.filter((o) => o.service_id === serviceId);
  const locationIds = new Set(rows.map((o) => o.location_id));
  const locations = config.locations.filter((l) => locationIds.has(l.id) && !l.archived_at);
  const staffAt = (locationId: string) => {
    const ids = new Set(rows.filter((o) => o.location_id === locationId && o.staff_id).map((o) => o.staff_id as string));
    return config.staff.filter((s) => ids.has(s.id) && !s.archived_at);
  };
  return { locations, staffAt };
}

export function NewAppointmentDialog({
  open, onOpenChange, config, onBooked, preferred, initialContact,
}: {
  open: boolean; onOpenChange: (open: boolean) => void; config: AppointmentConfig; onBooked: (id: string) => void;
  /** A day and time clicked on the week calendar: offered first once a service and location are chosen. */
  preferred?: { date: string; time: string } | null;
  /** The customer to book for (a contact card or chat opened the dialog); still changeable. */
  initialContact?: { id: string; name: string | null } | null;
}) {
  const t = useTranslations('Appointments');
  const ts = useTranslations('Sales.appointments');
  const locale = useLocale();
  const failureText = useFailureText();
  const [contact, setContact] = useState<PickedContact | null>(null);
  const contactId = contact?.id ?? '';
  const services = useMemo(() => config.services.filter((s) => !s.archived_at), [config.services]);
  const [serviceId, setServiceId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);

  // Each opening starts from the given customer (or none).
  const initialId = initialContact?.id ?? null;
  const initialName = initialContact?.name ?? null;
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the prefill follows the prop on each opening
    setContact(initialId ? { id: initialId, name: initialName, phone: null } : null);
  }, [open, initialId, initialName]);

  const choices = useMemo(() => offeringChoices(config, serviceId), [config, serviceId]);
  const staffHere = locationId ? choices.staffAt(locationId) : [];

  const reset = () => {
    setContact(null);
    setServiceId('');
    setLocationId('');
    setStaffId('');
    setSlot(null);
  };

  async function book() {
    if (!slot || !contactId || !serviceId || !locationId) return;
    setBusy(true);
    const r = await apiRequest<{ appointment: { id: string } }>('/api/appointments', {
      method: 'POST',
      // "Any practitioner": the server picks a free one from the slot's list under its locks.
      body: { contact_id: contactId, service_id: serviceId, location_id: locationId, staff_id: staffId || null, start_at: slot.startAt },
    });
    setBusy(false);
    if (!r.ok) {
      toast.error(failureText(r));
      if (r.code === 'slot_unavailable') setSlot(null);
      return;
    }
    toast.success(t('create.booked'));
    reset();
    onOpenChange(false);
    onBooked(r.data.appointment.id);
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>{t('create.title')}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-sm">
          <div className="space-y-1">
            <Label htmlFor="appt-contact">{t('create.contact')}</Label>
            <ContactPicker id="appt-contact" value={contact} onChange={setContact} placeholder={t('create.contactSearch')} disabled={busy} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="appt-service">{t('create.service')}</Label>
              <OptionSelect id="appt-service" value={serviceId}
                onValueChange={(v) => { setServiceId(v); setLocationId(''); setStaffId(''); setSlot(null); }}
                options={[{ value: '', label: '—' }, ...services.map((s) => ({ value: s.id, label: s.name }))]} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="appt-location">{t('create.location')}</Label>
              <OptionSelect id="appt-location" value={locationId} disabled={!serviceId}
                onValueChange={(v) => { setLocationId(v); setStaffId(''); setSlot(null); }}
                options={[{ value: '', label: '—' }, ...choices.locations.map((l) => ({ value: l.id, label: l.name }))]} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="appt-staff">{t('create.practitioner')}</Label>
              <OptionSelect id="appt-staff" value={staffId} disabled={!locationId || staffHere.length === 0}
                onValueChange={(v) => { setStaffId(v); setSlot(null); }}
                options={[{ value: '', label: staffHere.length ? t('schedule.anyStaff') : t('schedule.pool') }, ...staffHere.map((s) => ({ value: s.id, label: s.display_name }))]} />
            </div>
          </div>
          {preferred && (
            <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">
              {ts('requestedTime', {
                when: new Intl.DateTimeFormat(locale, { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
                  .format(new Date(`${preferred.date}T${preferred.time}:00Z`)),
              })}
            </p>
          )}
          {serviceId && locationId && (
            <SlotSelector key={`${serviceId}|${locationId}|${staffId}`} query={{ serviceId, locationId, staffId }} value={slot} onChange={setSlot}
              disabled={busy} preferred={preferred} />
          )}
        </div>
        <DialogFooter>
          <Button type="button" disabled={busy || !slot || !contactId} onClick={() => void book()}>{t('create.book')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
