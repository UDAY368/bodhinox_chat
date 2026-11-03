'use client';

import { useLocale, useTranslations } from 'next-intl';
import { ChevronLeft, ChevronRight, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { Slot } from '@/lib/appointments/types';
import { zoneLabel } from '@/lib/appointments/time';

export interface SlotPickerProps {
  /** Local dates (YYYY-MM-DD, in `timeZone`) that have at least one free slot. */
  dates: string[];
  selectedDate: string | null;
  onDateChange: (date: string) => void;
  /** Free slots of the selected date. */
  slots: Slot[];
  /** The chosen slot's startAt (ISO), if any. */
  selectedStartAt?: string | null;
  onSelect: (slot: Slot) => void;
  /** The location's IANA zone: every time is shown in it, never the viewer's. */
  timeZone: string;
  loading?: boolean;
  /** Show "N places left" for group sessions. */
  showRemaining?: boolean;
  /** Paging through dates, when the caller loads more. */
  onPreviousDates?: () => void;
  onNextDates?: () => void;
  disabled?: boolean;
  /** Why availability could not be loaded; shown instead of "no free dates". */
  errorText?: string | null;
}

/** A local date string formatted as a calendar day (zone-independent: read at UTC noon). */
function dayLabel(date: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
    .format(new Date(`${date}T12:00:00Z`));
}

/**
 * Presentational date + time picker for appointment slots. Props only: the
 * caller loads availability (staff API, public API or manage page).
 */
export function SlotPicker({
  dates, selectedDate, onDateChange, slots, selectedStartAt, onSelect, timeZone,
  loading = false, showRemaining = false, onPreviousDates, onNextDates, disabled = false, errorText = null,
}: SlotPickerProps) {
  const t = useTranslations('Appointments.slotPicker');
  const tPublic = useTranslations('BookingPublic');
  const locale = useLocale();
  const timeFormat = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit', timeZone });
  // The zone's label on the shown day (it can differ across a DST change).
  const labelDay = slots[0]?.startAt ?? (selectedDate ? `${selectedDate}T12:00:00Z` : null);
  const zone = labelDay ? zoneLabel(new Date(labelDay), timeZone, locale) : timeZone;

  return (
    <div className="space-y-3">
      <div>
        <div className="text-muted-foreground mb-2 text-xs font-medium">{t('chooseDate')}</div>
        <div className="flex items-center gap-1">
          {onPreviousDates && (
            <Button type="button" variant="ghost" size="icon" aria-label={t('previousDays')} onClick={onPreviousDates} disabled={disabled}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
          )}
          <div className="flex min-w-0 flex-1 gap-1 overflow-x-auto pb-1" role="listbox" aria-label={t('chooseDate')}>
            {dates.map((date) => (
              <Button
                key={date}
                type="button"
                role="option"
                aria-selected={date === selectedDate}
                variant={date === selectedDate ? 'default' : 'outline'}
                size="sm"
                className="shrink-0"
                disabled={disabled}
                onClick={() => onDateChange(date)}
              >
                {dayLabel(date, locale)}
              </Button>
            ))}
          </div>
          {onNextDates && (
            <Button type="button" variant="ghost" size="icon" aria-label={t('nextDays')} onClick={onNextDates} disabled={disabled}>
              <ChevronRight className="h-4 w-4" />
            </Button>
          )}
        </div>
      </div>

      {/* No day chosen: say why (loading, failed or nothing free) instead of showing an empty row. */}
      {!selectedDate && (loading ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm" role="status">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t('loading')}
        </div>
      ) : errorText ? (
        <p className="text-destructive text-sm" role="alert">{errorText}</p>
      ) : dates.length === 0 ? (
        <p className="text-muted-foreground text-sm">{tPublic('noDates')}</p>
      ) : null)}

      {selectedDate && (
        <div>
          <div className="text-muted-foreground mb-2 flex items-center justify-between text-xs font-medium">
            <span>{t('chooseTime')}</span>
            <span>{t('timesIn', { zone })}</span>
          </div>
          {loading ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t('loading')}
            </div>
          ) : slots.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('noSlots')}</p>
          ) : (
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-4" role="listbox" aria-label={t('chooseTime')}>
              {slots.map((slot) => {
                const selected = slot.startAt === selectedStartAt;
                return (
                  <Button
                    key={slot.startAt}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    variant={selected ? 'default' : 'outline'}
                    size="sm"
                    disabled={disabled}
                    onClick={() => onSelect(slot)}
                    className={cn('flex h-auto flex-col py-1.5')}
                  >
                    <span>{timeFormat.format(new Date(slot.startAt))}</span>
                    {showRemaining && (
                      <span className="text-[10px] opacity-70">{t('remaining', { count: slot.remaining })}</span>
                    )}
                  </Button>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
