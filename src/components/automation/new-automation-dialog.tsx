'use client';

/**
 * "New automation": the gallery first (channel tabs, a "Start from scratch"
 * card, the channel's rule templates and the flow template gallery with its
 * own search and filters), then for scratch a short form: Name, Type (Flow,
 * Rule or Sequence, each with a hint) and Channel. A sequence runs on
 * Instagram only, so it is offered while Instagram is on and chosen. The AI
 * flow builder stays for WhatsApp.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowLeft, Clock, Loader2, MessageCircle, PhoneCall, Plus, Users, Workflow, Zap } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { TemplateGallery, type TemplateSummary } from '@/components/flows/template-gallery';
import { AiGenerateFlowButton } from '@/components/flows/ai-generate-dialog';
import { AUTOMATION_TEMPLATES, templateOnChannel, type TemplateSlug } from '@/lib/automations/templates';
import { channelPath } from '@/lib/channels/routes';
import { cn } from '@/lib/utils';
import type { Channel } from '@/types';
import type { AutomationKind } from './automation-items';

export const KIND_ICON: Record<AutomationKind, typeof Workflow> = { flow: Workflow, rule: Zap, sequence: Clock };
const RULE_TEMPLATES: TemplateSlug[] = ['welcome_message', 'out_of_office', 'lead_qualifier', 'follow_up_reminder'];
const RULE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle, out_of_office: Clock, lead_qualifier: Users, follow_up_reminder: PhoneCall,
};

export function ChannelDotMark({ channel }: { channel: Channel }) {
  return (
    <span aria-hidden className={cn('h-2 w-2 shrink-0 rounded-full',
      channel === 'instagram' ? 'bg-gradient-to-br from-amber-400 via-pink-500 to-violet-600' : 'bg-emerald-500')} />
  );
}

/** A segmented control (the app's pill tabs). */
function Segmented<T extends string>({ label, value, options, onChange, testId }: {
  label: string;
  value: T;
  options: { value: T; label: React.ReactNode; disabled?: boolean; title?: string }[];
  onChange: (value: T) => void;
  testId?: string;
}) {
  return (
    <div role="radiogroup" aria-label={label} data-testid={testId}
      className="inline-flex w-fit max-w-full gap-0.5 overflow-x-auto rounded-xl bg-muted p-[3px] [scrollbar-width:none]">
      {options.map((option) => (
        <button key={option.value} type="button" role="radio" aria-checked={value === option.value} disabled={option.disabled}
          title={option.title} onClick={() => onChange(option.value)}
          className={cn('inline-flex h-[30px] shrink-0 items-center gap-2 whitespace-nowrap rounded-[9px] px-3 text-[13px] font-medium transition-[background-color,color,box-shadow] duration-150 focus-visible:outline-2 focus-visible:outline-primary disabled:cursor-not-allowed disabled:opacity-50',
            value === option.value ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground')}>
          {option.label}
        </button>
      ))}
    </div>
  );
}

export interface NewAutomationInput { name: string; kind: AutomationKind; channel: Channel }

export function NewAutomationDialog({
  open, onOpenChange, channels, initialChannel, templates, creating, sequencesOn, onUseFlowTemplate, onCreate, onAiCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The workspace's enabled channels. */
  channels: Channel[];
  initialChannel: Channel;
  /** Flow templates (each lists its channels, or none for every channel). */
  templates: TemplateSummary[];
  creating: boolean;
  /** Instagram sequences are available (Instagram is on). */
  sequencesOn: boolean;
  onUseFlowTemplate: (slug: string, channel: Channel) => void;
  onCreate: (input: NewAutomationInput) => Promise<void>;
  onAiCreated: (flowId: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* `sm:max-w-5xl`: shadcn's DialogContent bakes in `sm:max-w-sm`. */}
      <DialogContent className="max-h-[90vh] overflow-y-auto bg-popover text-popover-foreground sm:max-w-5xl">
        {open && (
          <DialogBody key={initialChannel} channels={channels} initialChannel={initialChannel} templates={templates} creating={creating}
            sequencesOn={sequencesOn} onUseFlowTemplate={onUseFlowTemplate} onCreate={onCreate} onAiCreated={onAiCreated}
            onCancel={() => onOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function DialogBody({ channels, initialChannel, templates, creating, sequencesOn, onUseFlowTemplate, onCreate, onAiCreated, onCancel }: {
  channels: Channel[];
  initialChannel: Channel;
  templates: TemplateSummary[];
  creating: boolean;
  sequencesOn: boolean;
  onUseFlowTemplate: (slug: string, channel: Channel) => void;
  onCreate: (input: NewAutomationInput) => Promise<void>;
  onAiCreated: (flowId: string) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('AutomationList.dialog');
  const tKinds = useTranslations('AutomationList.kinds');
  const tList = useTranslations('Flows.list');
  const tChannel = useTranslations('Inbox.channel');
  const router = useRouter();
  const [channel, setChannel] = useState<Channel>(initialChannel);
  const [mode, setMode] = useState<'gallery' | 'scratch'>('gallery');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<AutomationKind>('flow');
  const [nameError, setNameError] = useState(false);
  const sequenceAllowed = (on: Channel) => sequencesOn && on === 'instagram';
  const chosenKind: AutomationKind = kind === 'sequence' && !sequenceAllowed(channel) ? 'flow' : kind;

  const flowTemplates = templates.filter((tpl) => !tpl.channels || tpl.channels.includes(channel));
  const ruleTemplates = RULE_TEMPLATES.filter((slug) => templateOnChannel(AUTOMATION_TEMPLATES[slug], channel));
  const create = async () => {
    const trimmed = name.trim();
    if (!trimmed) { setNameError(true); return; }
    await onCreate({ name: trimmed, kind: chosenKind, channel });
  };
  const channelTabs = (value: Channel, onChange: (next: Channel) => void, label: string, testId?: string) => channels.length > 1 && (
    <Segmented label={label} value={value} onChange={onChange} testId={testId}
      options={channels.map((c) => ({ value: c, label: <><ChannelDotMark channel={c} />{tChannel(c)}</> }))} />
  );

  if (mode === 'scratch') {
    const createLabel = chosenKind === 'flow' ? tList('createBlank') : chosenKind === 'rule' ? t('createRule') : t('createSequence');
    return (
      <form className="flex flex-col gap-5" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <DialogHeader>
          <DialogTitle>{t('scratchTitle')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('scratchDesc')}</DialogDescription>
        </DialogHeader>
        <button type="button" onClick={() => setMode('gallery')}
          className="inline-flex w-fit items-center gap-1.5 rounded-md text-[13px] font-medium text-primary hover:underline focus-visible:outline-2 focus-visible:outline-primary">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden />{t('backToTemplates')}
        </button>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="new-automation-name" className="text-[13px] font-semibold text-foreground">{t('name')}</label>
          <Input id="new-automation-name" value={name} maxLength={100} autoFocus placeholder={tList('placeholderName')}
            aria-invalid={nameError || undefined} aria-describedby={nameError ? 'new-automation-name-error' : undefined}
            onChange={(e) => { setName(e.target.value); setNameError(false); }}
            className="rounded-xl border-transparent bg-muted shadow-none" />
          {nameError && <p id="new-automation-name-error" className="text-xs text-destructive">{t('nameRequired')}</p>}
        </div>
        <div className="flex flex-col gap-1.5">
          <span className="text-[13px] font-semibold text-foreground" id="new-automation-type">{t('type')}</span>
          <Segmented label={t('type')} value={chosenKind} onChange={setKind}
            options={(['flow', 'rule', 'sequence'] as const).map((value) => {
              const Icon = KIND_ICON[value];
              const blocked = value === 'sequence' && !sequenceAllowed(channel);
              return { value, disabled: blocked, title: blocked ? t('sequenceInstagramOnly') : undefined,
                label: <><Icon className="h-[15px] w-[15px]" aria-hidden />{tKinds(value)}</> };
            })} />
          <p className="text-xs text-muted-foreground">{t(`hints.${chosenKind}`)}</p>
          {!sequenceAllowed(channel) && <p className="text-xs text-muted-foreground">{t('sequenceInstagramOnly')}</p>}
        </div>
        {channels.length > 1 && (
          <div className="flex flex-col gap-1.5">
            <span className="text-[13px] font-semibold text-foreground">{t('channel')}</span>
            {channelTabs(channel, setChannel, t('channel'))}
          </div>
        )}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onCancel} disabled={creating}>{tList('cancel')}</Button>
          <Button type="submit" disabled={creating}>
            {creating && <Loader2 className="h-4 w-4 animate-spin" />}
            {createLabel}
          </Button>
        </DialogFooter>
      </form>
    );
  }

  const card = 'flex min-w-0 flex-col items-start gap-1.5 rounded-xl border p-3.5 text-left transition-[border-color,background-color,transform] duration-150 hover:border-primary hover:bg-muted/50 active:scale-[.985] focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50';
  return (
    <>
      <DialogHeader>
        <DialogTitle>{tList('createTitle')}</DialogTitle>
        <DialogDescription className="text-muted-foreground">{tList('createDesc')}</DialogDescription>
      </DialogHeader>
      {channelTabs(channel, setChannel, tList('chooseChannel'), 'create-channel')}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <button type="button" className={cn(card, 'border-dashed border-border bg-card')} disabled={creating}
          onClick={() => setMode('scratch')}>
          <span className="mb-1 inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-primary/10 text-primary" aria-hidden>
            <Plus className="h-4 w-4" />
          </span>
          <span className="text-sm font-semibold text-foreground">{t('scratch')}</span>
          <span className="text-[13px] text-muted-foreground">{t('scratchHint')}</span>
        </button>
        {ruleTemplates.map((slug) => {
          const tpl = AUTOMATION_TEMPLATES[slug];
          const Icon = RULE_ICON[slug];
          return (
            <button key={slug} type="button" className={cn(card, 'border-border bg-card')} disabled={creating}
              onClick={() => router.push(`${channelPath(channel, 'automationNew')}?template=${slug}`)}>
              <span className="mb-1 inline-flex h-[34px] w-[34px] items-center justify-center rounded-[10px] bg-primary/10 text-primary" aria-hidden>
                <Icon className="h-4 w-4" />
              </span>
              <span className="text-sm font-semibold text-foreground">{tpl.name}</span>
              <span className="line-clamp-2 text-[13px] text-muted-foreground">{tpl.description}</span>
              <span className="text-xs text-muted-foreground">{t('templateKind', { kind: tKinds('rule'), channel: tChannel(channel) })}</span>
            </button>
          );
        })}
      </div>
      {flowTemplates.length > 0 && (
        <div className="space-y-3 border-t border-border pt-4">
          <p className="text-[13px] font-semibold text-foreground">{t('flowTemplates')}</p>
          <TemplateGallery key={channel} templates={flowTemplates} creating={creating} onUse={(slug) => onUseFlowTemplate(slug, channel)} />
        </div>
      )}
      <DialogFooter>
        {/* The AI builder makes WhatsApp flows, so it is offered only for WhatsApp. */}
        {channel === 'whatsapp' && <AiGenerateFlowButton disabled={creating} onCreated={onAiCreated} />}
        <Button variant="ghost" onClick={onCancel} disabled={creating}>{tList('cancel')}</Button>
      </DialogFooter>
    </>
  );
}
