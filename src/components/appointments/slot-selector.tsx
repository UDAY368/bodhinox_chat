'use client';

import { useEffect, useRef, useState } from 'react';
import type { Slot } from '@/lib/appointments/types';
import { useFailureText } from './shared';
import { SlotPicker } from './slot-picker';
import { useStaffSlots, type SlotQuery } from './use-staff-slots';

/** The first free slot on `date` at or after `time` (HH:MM), or null (pure; tested). */
export function preferredSlot(slots: Slot[], date: string, time: string): Slot | null {
  return slots.filter((s) => s.localDate === date && s.hhmm >= time).sort((a, b) => a.hhmm.localeCompare(b.hhmm))[0] ?? null;
}

/** SlotPicker fed by the staff slots API (new bookings and rescheduling). */
export function SlotSelector({
  query, value, onChange, disabled, preferred,
}: {
  query: SlotQuery | null;
  value: Slot | null;
  onChange: (slot: Slot | null) => void;
  disabled?: boolean;
  /** A day and time picked on the week calendar: that day is shown first and its first free time from then is chosen. */
  preferred?: { date: string; time: string } | null;
}) {
  const slots = useStaffSlots(query, 0, preferred?.date ?? null);
  const failureText = useFailureText();
  const [picked, setPicked] = useState<string | null>(null);
  const applied = useRef<string | null>(null);
  const wanted = picked ?? preferred?.date ?? null;
  const date = wanted && slots.dates.includes(wanted) ? wanted : (slots.dates[0] ?? null);

  // Choose the calendar's time once the slots for this query have loaded (once per query and time).
  useEffect(() => {
    if (!preferred || !query || slots.loading || value) return;
    const key = `${query.serviceId}|${query.locationId}|${query.staffId}|${preferred.date}|${preferred.time}`;
    if (applied.current === key) return;
    applied.current = key;
    const slot = preferredSlot(slots.slots, preferred.date, preferred.time);
    if (slot) onChange(slot);
  }, [preferred, query, slots.loading, slots.slots, value, onChange]);

  if (!query) return null;
  return (
    <SlotPicker
      dates={slots.dates}
      selectedDate={date}
      onDateChange={(d) => {
        setPicked(d);
        onChange(null);
      }}
      slots={slots.slots.filter((s) => s.localDate === date)}
      selectedStartAt={value?.startAt ?? null}
      onSelect={onChange}
      timeZone={slots.timezone}
      loading={slots.loading}
      errorText={slots.failure ? failureText(slots.failure) : null}
      showRemaining
      onPreviousDates={slots.previous}
      onNextDates={slots.next}
      disabled={disabled}
    />
  );
}
