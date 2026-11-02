'use client';

import { useCallback, useEffect, useState } from 'react';
import { useFormatter, useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { templateStatusConfig } from '@/lib/template-status';
import type { MessageTemplateStatus } from '@/types';
import { cn } from '@/lib/utils';

export interface TemplateStatusEvent {
  id: string;
  status: string;
  reason: string | null;
  quality_score: string | null;
  source: 'draft' | 'submit' | 'webhook' | 'sync' | 'edit' | string;
  created_at: string;
}

const KNOWN_SOURCES = new Set(['draft', 'submit', 'webhook', 'sync', 'edit']);

/** Vertical status history for one template, newest first. */
export function TemplateTimeline({ templateId }: { templateId: string }) {
  const t = useTranslations('Templates.studio.timeline');
  const format = useFormatter();
  const [events, setEvents] = useState<TemplateStatusEvent[] | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    setEvents(null);
    try {
      const res = await authFetch(
        `/api/whatsapp/templates/${encodeURIComponent(templateId)}/events`
      );
      if (!res.ok) throw new Error(String(res.status));
      const data = (await res.json()) as { events?: TemplateStatusEvent[] };
      const list = [...(data.events ?? [])].sort((a, b) =>
        b.created_at.localeCompare(a.created_at)
      );
      setEvents(list);
    } catch {
      setFailed(true);
    }
  }, [templateId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (failed) {
    return (
      <div className="flex items-center gap-2 text-sm text-destructive" role="alert">
        {t('loadFailed')}
        <Button variant="outline" size="xs" onClick={() => void load()}>
          {t('retry')}
        </Button>
      </div>
    );
  }
  if (!events) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
        <Loader2 className="size-4 animate-spin" aria-hidden /> {t('loading')}
      </div>
    );
  }
  if (events.length === 0) {
    return <p className="text-sm text-muted-foreground">{t('empty')}</p>;
  }

  return (
    <ol className="relative space-y-4 border-l border-border pl-4" aria-label={t('label')}>
      {events.map((ev) => {
        const cfg = templateStatusConfig[ev.status as MessageTemplateStatus];
        const at = new Date(ev.created_at);
        return (
          <li key={ev.id} className="relative">
            <span
              className="absolute top-1.5 -left-[1.3rem] size-2.5 rounded-full border-2 border-background bg-primary"
              aria-hidden
            />
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="outline" className={cn(cfg?.classes)}>
                {cfg?.label ?? ev.status}
              </Badge>
              <span className="text-xs text-muted-foreground">
                {KNOWN_SOURCES.has(ev.source) ? t(`source.${ev.source}`) : ev.source}
              </span>
              <time
                dateTime={ev.created_at}
                title={format.dateTime(at, { dateStyle: 'medium', timeStyle: 'short' })}
                className="text-xs text-muted-foreground"
              >
                {format.relativeTime(at)}
              </time>
            </div>
            {ev.reason && <p className="mt-1 text-sm">{ev.reason}</p>}
            {ev.quality_score && (
              <p className="mt-0.5 text-xs text-muted-foreground">
                {t('quality', { score: ev.quality_score })}
              </p>
            )}
          </li>
        );
      })}
    </ol>
  );
}
