'use client';

// The Message card of a campaign report (Campaigns redesign): the message as
// the customer saw it, as a chat bubble, with the campaign's values filled in.
// WhatsApp campaigns render their template (header, body, footer, buttons);
// Instagram campaigns render their text. Read-only.

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import type { Broadcast, MessageTemplate } from '@/types';
import { createClient } from '@/lib/data/client';
import { TemplatePreview } from '@/components/templates/template-preview';
import type { TemplateDraftInput } from '@/components/templates/types';
import { PhoneFrame, TextBubble } from './broadcast-display';
import { CAMPAIGN_SEND_EXTRAS_KEY } from '@/lib/whatsapp/template-send-params';

type Mapping = { type?: string; value?: string };

/**
 * Sample values for the template body from the campaign's variable mappings:
 * a fixed value shows as itself, a per-contact value as its {field} token.
 * Exported for tests.
 */
export function bodySamples(variables: Record<string, unknown> | undefined, labels: { customField: string }): string[] {
  if (!variables) return [];
  const keys = Object.keys(variables).filter((k) => k !== CAMPAIGN_SEND_EXTRAS_KEY && /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  const out: string[] = [];
  for (const key of keys) {
    const m = variables[key] as Mapping | null;
    const index = Number(key) - 1;
    if (!m || typeof m !== 'object') continue;
    out[index] = m.type === 'static' ? String(m.value ?? '')
      : m.type === 'custom_field' ? `{${labels.customField}}`
        : `{${String(m.value ?? '')}}`;
  }
  return Array.from(out, (v) => v ?? '');
}

export function BroadcastMessageCard({ broadcast }: { broadcast: Broadcast }) {
  const t = useTranslations('Campaigns.message');
  const instagram = broadcast.channel === 'instagram';
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'missing'>(instagram ? 'ready' : 'loading');

  useEffect(() => {
    if (instagram) return;
    let cancelled = false;
    createClient()
      .from('message_templates')
      .select('*')
      .eq('name', broadcast.template_name)
      .eq('language', broadcast.template_language)
      .limit(1)
      .then(({ data }: { data: MessageTemplate[] | null }) => {
        if (cancelled) return;
        const row = data?.[0] ?? null;
        setTemplate(row);
        setState(row ? 'ready' : 'missing');
      }, () => { if (!cancelled) setState('missing'); });
    return () => { cancelled = true; };
  }, [instagram, broadcast.template_name, broadcast.template_language]);

  const samples = bodySamples(broadcast.template_variables, { customField: t('customField') });

  return (
    <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-border bg-card p-4" aria-labelledby="campaign-message-title">
      <div className="flex items-baseline justify-between gap-2">
        <h3 id="campaign-message-title" className="text-base font-semibold text-foreground">{t('title')}</h3>
        <small className="truncate text-xs text-muted-foreground">{instagram ? t('textMessage') : broadcast.template_name}</small>
      </div>
      {instagram ? (
        <PhoneFrame who={t('yourBusiness')}>
          <TextBubble text={broadcast.message_text ?? ''} emptyLabel={t('empty')} />
        </PhoneFrame>
      ) : state === 'loading' ? (
        <div className="h-40 animate-pulse rounded-xl bg-muted" aria-label={t('loading')} />
      ) : template ? (
        <TemplatePreview
          template={{
            ...(template as unknown as TemplateDraftInput),
            language: template.language ?? broadcast.template_language,
            sample_values: { ...(template.sample_values ?? {}), body: samples.length ? samples : template.sample_values?.body },
          }}
        />
      ) : (
        <p className="text-sm text-muted-foreground">{t('templateMissing')}</p>
      )}
    </section>
  );
}
