import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The settings panel and its label/control rows (the prototype's `.panel` and
 * `.rw.form`): label and hint on the left, the control on the right, stacked
 * below 640px so nothing overlaps on a phone.
 */
export function SettingsPanel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('divide-y divide-border overflow-hidden rounded-xl border border-border bg-card', className)}>
      {children}
    </div>
  );
}

export function SettingsRow({
  label,
  hint,
  htmlFor,
  error,
  errorId,
  children,
  className,
}: {
  label: ReactNode;
  hint?: ReactNode;
  htmlFor?: string;
  error?: string | null;
  errorId?: string;
  children: ReactNode;
  className?: string;
}) {
  const Label = htmlFor ? 'label' : 'span';
  return (
    <div className={cn('grid gap-2 px-4 py-3.5 sm:grid-cols-[minmax(0,13rem)_minmax(0,1fr)] sm:items-center sm:gap-6', className)}>
      <Label {...(htmlFor ? { htmlFor } : {})} className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        {hint ? <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span> : null}
      </Label>
      <div className="min-w-0">
        {children}
        {error ? <p id={errorId} role="alert" className="mt-1.5 text-xs text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

/** A switch row: title and description on the left, the control on the right. */
export function SettingsSwitchRow({ title, description, control, className }: {
  title: ReactNode;
  description?: ReactNode;
  control: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex items-center gap-4 px-4 py-3.5', className)}>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description ? <p className="mt-0.5 text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <div className="shrink-0">{control}</div>
    </div>
  );
}
