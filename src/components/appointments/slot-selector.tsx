'use client';

import { useState } from 'react';
import type { Slot } from '@/lib/appointments/types';
import { useFailureText } from './shared';
import { SlotPicker } from './slot-picker';
import { useStaffSlots, type SlotQuery } from './use-staff-slots';

/** SlotPicker fed by the staff slots API (new bookings and rescheduling). */
export function SlotSelector({
  query, value, onChange, disabled,
}: { query: SlotQuery | null; value: Slot | null; onChange: (slot: Slot | null) => void; disabled?: boolean }) {
  const slots = useStaffSlots(query);
  const failureText = useFailureText();
  const [picked, setPicked] = useState<string | null>(null);
  const date = picked && slots.dates.includes(picked) ? picked : (slots.dates[0] ?? null);
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
