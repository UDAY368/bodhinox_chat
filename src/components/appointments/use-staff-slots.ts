'use client';

import { useEffect, useMemo, useState } from 'react';
import type { Slot } from '@/lib/appointments/types';
import { STAFF_SLOT_DAYS_MAX } from '@/lib/appointments/types';
import { addDays, localDay } from '@/lib/appointments/time';
import { apiRequest, slotDates, type ApiFailure } from './shared';

export interface SlotQuery {
  serviceId: string;
  locationId: string;
  /** A practitioner, or '' for any. */
  staffId: string;
  /** Rescheduling: ignore this appointment's own time. */
  exclude?: string;
}

/**
 * Staff slot preview for 14 local days from `from` (default: today in the
 * location's zone). Slots are a preview; booking re-checks them under locks.
 */
export function useStaffSlots(query: SlotQuery | null, refresh = 0, startDay: string | null = null) {
  // A future day picked on the week calendar starts the window there; a past or absent one starts today.
  const [from, setFrom] = useState<string | null>(() => (startDay && startDay > new Date().toISOString().slice(0, 10) ? startDay : null));
  const [state, setState] = useState<{ timezone: string; slots: Slot[]; loading: boolean; failure: ApiFailure | null }>(
    // Loading until the first answer, so the picker never flashes "no free dates" before it asked.
    { timezone: 'UTC', slots: [], loading: true, failure: null },
  );
  const key = query ? `${query.serviceId}|${query.locationId}|${query.staffId}|${query.exclude ?? ''}` : '';

  useEffect(() => {
    if (!query) return;
    let live = true;
    const params = new URLSearchParams({ service_id: query.serviceId, location_id: query.locationId, days: String(STAFF_SLOT_DAYS_MAX) });
    if (query.staffId) params.set('staff_id', query.staffId);
    if (query.exclude) params.set('exclude', query.exclude);
    if (from) params.set('from', from);
    setState((s) => ({ ...s, loading: true, failure: null }));
    void apiRequest<{ timezone: string; slots: Slot[] }>(`/api/appointments/slots?${params}`).then((r) => {
      if (!live) return;
      // A refusal (plan, invalid setup, rate limit) is kept so the picker can say why there are no times.
      setState(r.ok
        ? { timezone: r.data.timezone, slots: r.data.slots ?? [], loading: false, failure: null }
        : { timezone: 'UTC', slots: [], loading: false, failure: r });
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, from, refresh]);

  const dates = useMemo(() => slotDates(state.slots), [state.slots]);
  const firstDay = from ?? localDay(new Date(), state.timezone);
  return {
    ...state,
    dates,
    /** Page the 14-day window. */
    next: () => setFrom(addDays(firstDay, STAFF_SLOT_DAYS_MAX)),
    previous: from ? () => setFrom(addDays(from, -STAFF_SLOT_DAYS_MAX)) : undefined,
  };
}
