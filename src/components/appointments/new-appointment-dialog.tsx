'use client';

/**
 * Staff booking: pick a customer (existing contact), a service, a location
 * that offers it, optionally a practitioner, then a free time. The server
 * re-checks the slot under its locks and confirms at once; the customer's
 * confirmation and reminders are queued with the booking.
 */
import { useEffect, useMemo, useState } from 'react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { createClient } from '@/lib/data/client';
import type { Slot } from '@/lib/appointments/types';
import { SlotSelector } from './slot-selector';
import { apiRequest, selectClass, useFailureText, type AppointmentConfig } from './shared';

interface ContactOption { id: string; name: string | null }

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
  open, onOpenChange, config, onBooked,
}: { open: boolean; onOpenChange: (open: boolean) => void; config: AppointmentConfig; onBooked: (id: string) => void }) {
  const t = useTranslations('Appointments');
  const failureText = useFailureText();
  const [search, setSearch] = useState('');
  const [contacts, setContacts] = useState<ContactOption[]>([]);
  const [contactId, setContactId] = useState('');
  const services = useMemo(() => config.services.filter((s) => !s.archived_at), [config.services]);
  const [serviceId, setServiceId] = useState('');
  const [locationId, setLocationId] = useState('');
  const [staffId, setStaffId] = useState('');
  const [slot, setSlot] = useState<Slot | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const term = search.trim().replace(/[%_,()]/g, '');
    const timer = setTimeout(() => {
      let q = createClient().from('contacts').select('id,name').order('name').limit(20);
      if (term) q = q.ilike('name', `%${term}%`);
      void q.then(({ data }) => {
        if (live) setContacts(((data ?? []) as ContactOption[]));
      });
    }, 250);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [open, search]);

  const choices = useMemo(() => offeringChoices(config, serviceId), [config, serviceId]);
  const staffHere = locationId ? choices.staffAt(locationId) : [];

  const reset = () => {
    setContactId('');
    setServiceId('');
    setLocationId('');
    setStaffId('');
    setSlot(null);
    setSearch('');
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
            <Label htmlFor="appt-contact-search">{t('create.contact')}</Label>
            <Input id="appt-contact-search" placeholder={t('create.contactSearch')} value={search} onChange={(e) => setSearch(e.target.value)} />
            <select aria-label={t('create.contact')} className={selectClass} value={contactId} onChange={(e) => setContactId(e.target.value)}>
              <option value="">—</option>
              {contacts.map((c) => <option key={c.id} value={c.id}>{c.name || c.id.slice(0, 8)}</option>)}
            </select>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="appt-service">{t('create.service')}</Label>
              <select id="appt-service" className={selectClass} value={serviceId}
                onChange={(e) => { setServiceId(e.target.value); setLocationId(''); setStaffId(''); setSlot(null); }}>
                <option value="">—</option>
                {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="appt-location">{t('create.location')}</Label>
              <select id="appt-location" className={selectClass} value={locationId} disabled={!serviceId}
                onChange={(e) => { setLocationId(e.target.value); setStaffId(''); setSlot(null); }}>
                <option value="">—</option>
                {choices.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="appt-staff">{t('create.practitioner')}</Label>
              <select id="appt-staff" className={selectClass} value={staffId} disabled={!locationId || staffHere.length === 0}
                onChange={(e) => { setStaffId(e.target.value); setSlot(null); }}>
                <option value="">{staffHere.length ? t('schedule.anyStaff') : t('schedule.pool')}</option>
                {staffHere.map((s) => <option key={s.id} value={s.id}>{s.display_name}</option>)}
              </select>
            </div>
          </div>
          {serviceId && locationId && (
            <SlotSelector query={{ serviceId, locationId, staffId }} value={slot} onChange={setSlot} disabled={busy} />
          )}
        </div>
        <DialogFooter>
          <Button type="button" disabled={busy || !slot || !contactId} onClick={() => void book()}>{t('create.book')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
