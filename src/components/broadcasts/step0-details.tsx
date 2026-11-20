'use client';

// Wizard step 1 (Campaigns redesign): the campaign's channel, shown only when the
// workspace uses both. WhatsApp sends an approved template to everyone who opted in;
// Instagram sends a text to the people who wrote in the last 24 hours. The name is
// asked once, on the last step.

import { useTranslations } from 'next-intl';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ChannelDot } from './broadcast-display';

export type CampaignChannel = 'whatsapp' | 'instagram';

export function Step0Details({
  channel, onChannelChange, instagramAvailable, whatsappAvailable, onNext, onBack,
}: {
  channel: CampaignChannel;
  onChannelChange: (channel: CampaignChannel) => void;
  instagramAvailable: boolean;
  whatsappAvailable: boolean;
  onNext: () => void;
  onBack: () => void;
}) {
  const t = useTranslations('Campaigns.wizard');
  const options: { value: CampaignChannel; title: string; text: string; available: boolean }[] = [
    { value: 'whatsapp', title: t('channelWhatsapp'), text: t('channelWhatsappHint'), available: whatsappAvailable },
    { value: 'instagram', title: t('channelInstagram'), text: instagramAvailable ? t('channelInstagramHint') : t('channelInstagramOff'), available: instagramAvailable },
  ];
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-foreground">{t('detailsTitle')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">{t('detailsSubtitle')}</p>
      </div>
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-foreground">{t('channelLabel')}</legend>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {options.map((o) => {
            const on = channel === o.value;
            return (
              <button
                key={o.value}
                type="button"
                aria-pressed={on}
                disabled={!o.available}
                onClick={() => onChannelChange(o.value)}
                className={cn(
                  'flex items-start gap-3 rounded-xl border p-4 text-left transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60',
                  on ? 'border-primary bg-primary/5' : 'border-border bg-card hover:border-primary/40',
                )}
              >
                <ChannelDot channel={o.value} className="mt-1.5" />
                <span className="min-w-0">
                  <strong className="block text-sm font-semibold text-foreground">{o.title}</strong>
                  <small className="block text-xs text-muted-foreground">{o.text}</small>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>
      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="text-muted-foreground">
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>
        <Button
          onClick={onNext}
          disabled={!options.find((o) => o.value === channel)?.available}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {t('next')}
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
