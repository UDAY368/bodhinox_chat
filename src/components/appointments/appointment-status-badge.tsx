'use client';

import { useTranslations } from 'next-intl';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { AppointmentStatus } from '@/lib/appointments/types';

const STATUS_CLASS: Record<AppointmentStatus, string> = {
  held: 'border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-300',
  confirmed: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-300',
  cancelled: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
  completed: 'border-blue-500/30 bg-blue-500/10 text-blue-600 dark:text-blue-300',
  no_show: 'border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-300',
  expired: 'border-slate-500/30 bg-slate-500/10 text-muted-foreground',
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
