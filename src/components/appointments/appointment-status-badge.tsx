'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AppointmentStatus } from '@/lib/appointments/types';

const STATUS_CLASS: Record<AppointmentStatus, string> = {
  held: 'border-transparent bg-amber-500/10 text-amber-600 dark:text-amber-300',
  confirmed: 'border-transparent bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  cancelled: 'border-transparent bg-muted text-muted-foreground',
  completed: 'border-transparent bg-blue-500/10 text-blue-600 dark:text-blue-300',
  no_show: 'border-transparent bg-rose-500/10 text-rose-600 dark:text-rose-300',
  expired: 'border-transparent bg-muted text-muted-foreground',
};

/** Presentational status pill (staff schedule, sheet and the public manage page). */
export function AppointmentStatusBadge({ status, className }: { status: AppointmentStatus; className?: string }) {
  const t = useTranslations('Appointments.status');
  return (
    <Badge variant="outline" className={cn(STATUS_CLASS[status], className)} data-status={status}>
      {t(status)}
    </Badge>
  );
}
