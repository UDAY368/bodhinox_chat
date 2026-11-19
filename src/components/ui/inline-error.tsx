'use client';

import { AlertTriangle, RotateCw } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

/**
 * What happened, then Retry. Use in place of a list, panel or count whose request failed, so a
 * failure never looks like "nothing here". The message is a plain sentence for the user; never
 * pass a raw server error (it can carry internal detail).
 */
export function InlineError({
  message,
  onRetry,
  className,
}: {
  message?: string;
  onRetry?: () => void;
  className?: string;
}) {
  const t = useTranslations('UiPrimitives');
  return (
    <div
      role="alert"
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-4 py-10 text-center',
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-amber-500/10">
        <AlertTriangle className="h-5 w-5 text-amber-500" aria-hidden />
      </div>
      <p className="max-w-sm text-sm text-muted-foreground">{message ?? t('loadFailed')}</p>
      {onRetry && (
        <Button variant="outline" onClick={onRetry} className="min-h-11 sm:min-h-9">
          <RotateCw className="size-4" aria-hidden />
          {t('retry')}
        </Button>
      )}
    </div>
  );
}
