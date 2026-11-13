'use client';

/**
 * The rules builder's phone: what the rule sends, in order, in the same
 * handset the flow editor uses (wide screens). Message steps show as the
 * customer sees them; other steps as short system lines. Nothing is sent.
 */

import { useMemo } from 'react';
import { useTranslations } from 'next-intl';

import { PhoneBubble } from '@/components/flows/flow-preview';
import { PhoneFrame } from '@/components/flows/phone-frame';
import { useAuth } from '@/hooks/use-auth';
import { rulePreview, type RulePreviewStep } from '@/lib/automations/rule-preview';
import type { Channel } from '@/types';

export function RulePhonePreview({ steps, channel }: { steps: RulePreviewStep[]; channel: Channel }) {
  const t = useTranslations('Flows.builder.preview');
  const tb = useTranslations('Flows.builder.basic');
  const tSteps = useTranslations('Automations.builder.steps');
  const { account } = useAuth();
  const lines = useMemo(() => rulePreview(steps), [steps]);
  const dark = channel === 'whatsapp';
  return (
    <aside aria-label={tb('phoneTitle')} className="border-border bg-card-2 hidden shrink-0 flex-col items-center gap-3 border-l px-5 py-6 xl:flex xl:w-[340px] xl:overflow-y-auto">
      <p className="text-muted-foreground self-start text-[11px] font-semibold tracking-wider uppercase">{tb('phoneTitle')}</p>
      <div data-testid="rule-phone" className="contents">
        <PhoneFrame channel={channel} title={account?.name || t('phoneBusiness')}
          subtitle={channel === 'instagram' ? t('phoneSubtitleInstagram') : t('phoneSubtitleWhatsapp')} className="h-[560px]">
          {lines.length === 0 ? (
            <p className={'m-auto px-4 text-center text-xs ' + (dark ? 'text-white/60' : 'text-black/50')}>{t('phoneNoMessages')}</p>
          ) : (
            lines.map((line, i) => (line.kind === 'system' ? (
              <p key={i} className={'mx-auto max-w-[90%] text-center text-[11px] ' + (dark ? 'text-white/60' : 'text-black/60')}>
                {tSteps(line.step)}
              </p>
            ) : (
              <PhoneBubble key={i} channel={channel} active={false} t={t}
                message={{ id: i, from: 'bot', text: line.text, header: line.header, footer: line.footer, buttons: line.buttons, list: line.list, template: line.template }} />
            )))
          )}
        </PhoneFrame>
      </div>
    </aside>
  );
}
