'use client';

import { useTranslations } from 'next-intl';

import { cn } from '@/lib/utils';

/** Placeholder rows shaped like a list while it loads. No bare spinner on a whole page. */
export function PageLoading({ rows = 6, className }: { rows?: number; className?: string }) {
  const t = useTranslations('UiPrimitives');
  return (
    <div role="status" aria-label={t('loading')} className={cn('flex flex-col gap-2', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-3">
          <div className="h-9 w-9 shrink-0 animate-pulse rounded-full bg-muted motion-reduce:animate-none" />
          <div className="flex flex-1 flex-col gap-2">
            <div className="h-3 w-1/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
            <div className="h-3 w-2/3 animate-pulse rounded bg-muted motion-reduce:animate-none" />
          </div>
        </div>
      ))}
    </div>
  );
}
