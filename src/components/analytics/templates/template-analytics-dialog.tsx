'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { BarChart3 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { TemplateTimeline } from '@/components/templates/template-timeline';
import { templateStatusConfig } from '@/lib/template-status';
import type { MessageTemplate, MessageTemplateStatus } from '@/types';
import { cn } from '@/lib/utils';
import { TemplateAnalyticsView } from './template-analytics-view';

type TemplateRef = Pick<MessageTemplate, 'id' | 'name' | 'language' | 'status' | 'quality_score'>;

const QUALITY_DOT: Record<string, string> = { GREEN: 'bg-emerald-500', YELLOW: 'bg-amber-500', RED: 'bg-red-500' };

/** Per-template "Analytics" action: an icon button that opens the report dialog. */
export function TemplateAnalyticsAction({ template }: { template: TemplateRef }) {
  const t = useTranslations('Analytics.templates');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setOpen(true)}
        title={t('action')}
        aria-label={t('actionAria', { name: template.name })}
        className="text-muted-foreground hover:text-primary hover:bg-primary/10 h-8 w-8"
      >
        <BarChart3 className="size-4" />
      </Button>
      <TemplateAnalyticsDialog template={template} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Template performance for a chosen range, with quality and status history alongside. */
export function TemplateAnalyticsDialog({
  template,
  open,
  onOpenChange,
}: {
  template: TemplateRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useTranslations('Analytics.templates');
  const status = template.status ? templateStatusConfig[template.status as MessageTemplateStatus] : undefined;
  const quality = template.quality_score ?? null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="bg-popover border-border sm:max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground break-all">
            {t('dialogTitle', { name: template.name })}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('dialogDescription')}</DialogDescription>
        </DialogHeader>
        {/* Mount the report only while open so a closed dialog never queries. */}
        {open && (
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_16rem]">
            <TemplateAnalyticsView templateId={template.id} />
            <aside className="space-y-4 lg:border-l lg:border-border lg:pl-4">
              <section className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">{t('qualityTitle')}</h3>
                <div className="flex flex-wrap items-center gap-2">
                  {status && (
                    <Badge variant="outline" className={cn(status.classes)}>
                      {status.label}
                    </Badge>
                  )}
                  <Badge variant="outline" className="gap-1.5">
                    <span
                      aria-hidden
                      className={cn('size-1.5 rounded-full', quality ? QUALITY_DOT[quality] ?? 'bg-muted-foreground' : 'bg-muted-foreground')}
                    />
                    {quality && QUALITY_DOT[quality] ? t(`quality.${quality}`) : t('quality.unknown')}
                  </Badge>
                  {template.language && (
                    <span className="text-xs text-muted-foreground">{template.language}</span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">{t('languagesNote')}</p>
              </section>
              <section className="space-y-2">
                <h3 className="text-sm font-medium text-foreground">{t('historyTitle')}</h3>
                <TemplateTimeline templateId={template.id} />
              </section>
            </aside>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
