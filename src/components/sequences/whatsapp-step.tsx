'use client';

// WhatsApp sequences (batch 7): the pieces the timeline editor adds for them.
//   ChannelControl     Instagram / WhatsApp segmented control (only while the
//                      sequence has no messages: the two kinds of step differ).
//   ExitWhenSection    "Exit when": Replied, Tagged (+ tag), Bought.
//   WhatsAppStepSheet  a step's message (text and/or one file), when it is sent,
//                      and the template sent instead when the 24-hour window is
//                      closed, with its {{n}} values mapped from contact fields
//                      or typed text.

import { useRef, useState, type FormEvent } from 'react';
import { Loader2, Paperclip, X } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { useApprovedTemplates, useUserTags } from '@/components/flows/forms/use-pickers';
import { FLOW_MEDIA_BUCKET, MEDIA_ACCEPT } from '@/components/flows/forms/node-config-form';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import { automationTemplateRefusal } from '@/lib/automations/template-check';
import { MEDIA_MAX_BYTES, uploadAccountMedia } from '@/lib/storage/upload-media';
import type { ExitSettings, SequenceChannel, WaMediaType } from '@/lib/sequences/whatsapp';
import { SEQUENCE_DELAY_UNITS, type SequenceDelayUnit } from '@/types';
import type { SequenceMessageView, WhatsAppStepInput } from './sequence-api';
import {
  contactPlaceholder,
  parseDelayInput,
  TEMPLATE_FIELD_CHOICES,
  templateValueSource,
  templateVariableCount,
  type TemplateFieldChoice,
} from './sequence-format';

type T = ReturnType<typeof useTranslations<'Instagram.sequences'>>;

export function ChannelControl({ t, value, locked, disabled, onChange }: {
  t: T; value: SequenceChannel; locked: boolean; disabled: boolean; onChange: (next: SequenceChannel) => void;
}) {
  return (
    <div className="space-y-1">
      <SegmentedControl aria-label={t('channel.label')} value={value}
        onValueChange={(next) => { if (next !== value) onChange(next); }}
        options={(['instagram', 'whatsapp'] as const).map((c) => ({
          value: c, label: t(`channel.${c}`), disabled: disabled || (locked && value !== c),
        }))} />
      {locked && <p className="text-muted-foreground text-xs">{t('channel.locked')}</p>}
    </div>
  );
}

export function ExitWhenSection({ t, settings, canEdit, busy, onChange }: {
  t: T; settings: ExitSettings; canEdit: boolean; busy: boolean; onChange: (patch: Partial<ExitSettings>) => void;
}) {
  const tags = useUserTags();
  const [tagging, setTagging] = useState(!!settings.exit_on_tag_id);
  const tagOn = tagging || !!settings.exit_on_tag_id;
  const tagName = tags.find((tag) => tag.id === settings.exit_on_tag_id)?.name;
  const row = 'flex min-h-11 items-center justify-between gap-3 px-4 py-2';
  return (
    <section className="space-y-2" aria-labelledby="sequence-exit-title">
      <div>
        <h2 id="sequence-exit-title" className="text-foreground text-base font-semibold">{t('exit.title')}</h2>
        <p className="text-muted-foreground text-sm">{t('exit.description')}</p>
      </div>
      <div className="border-border bg-card divide-border divide-y rounded-xl border">
        <div className={row}>
          <Label htmlFor="exit-replied" className="text-sm font-normal">{t('exit.replied')}</Label>
          <Switch id="exit-replied" checked={settings.exit_on_reply} disabled={!canEdit || busy}
            onCheckedChange={(on) => onChange({ exit_on_reply: on })} />
        </div>
        <div className="space-y-2 px-4 py-2">
          <div className="flex min-h-11 items-center justify-between gap-3">
            <Label htmlFor="exit-tagged" className="text-sm font-normal">{t('exit.tagged')}</Label>
            <Switch id="exit-tagged" checked={tagOn} disabled={!canEdit || busy}
              onCheckedChange={(on) => {
                setTagging(on);
                if (!on && settings.exit_on_tag_id) onChange({ exit_on_tag_id: null });
              }} />
          </div>
          {tagOn && (
            tags.length === 0 ? <p className="text-muted-foreground text-xs">{t('exit.noTags')}</p> : (
              <Select value={settings.exit_on_tag_id ?? ''} disabled={!canEdit || busy}
                onValueChange={(v) => { if (typeof v === 'string' && v) onChange({ exit_on_tag_id: v }); }}>
                <SelectTrigger aria-label={t('exit.chooseTag')} className="min-h-11 w-full sm:min-h-8 sm:w-64">
                  <SelectValue>{tagName ?? t('exit.chooseTag')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {tags.map((tag) => <SelectItem key={tag.id} value={tag.id}>{tag.name}</SelectItem>)}
                </SelectContent>
              </Select>
            )
          )}
        </div>
        <div className={row}>
          <Label htmlFor="exit-bought" className="text-sm font-normal">{t('exit.bought')}</Label>
          <Switch id="exit-bought" checked={settings.exit_on_purchase} disabled={!canEdit || busy}
            onCheckedChange={(on) => onChange({ exit_on_purchase: on })} />
        </div>
      </div>
    </section>
  );
}

/** The step as the sheet starts: an existing message, or empty for a new one. */
export function stepFromItem(item: SequenceMessageView | null): WhatsAppStepInput {
  return {
    text: item?.wa_text ?? null,
    media: item?.wa_media_type && item.wa_media_url ? { type: item.wa_media_type, url: item.wa_media_url, filename: item.wa_media_filename } : null,
    template: item?.template_name ? { name: item.template_name, language: item.template_language, params: item.template_params ?? [] } : null,
  };
}

const NO_TEMPLATE = '__none__';

/** When a step is sent: the wait after subscribing (first step) or after the previous step. */
export interface StepDelay { delay_amount: number; delay_unit: SequenceDelayUnit }

export function WhatsAppStepSheet({ t, open, initial, initialDelay, first, busy, onOpenChange, onSave }: {
  t: T; open: boolean; initial: WhatsAppStepInput; initialDelay: StepDelay; first: boolean; busy: boolean;
  onOpenChange: (open: boolean) => void; onSave: (step: WhatsAppStepInput, delay: StepDelay) => Promise<boolean>;
}) {
  const templates = useApprovedTemplates().filter((tpl) => !automationTemplateRefusal(tpl as never));
  const [text, setText] = useState(initial.text ?? '');
  const [media, setMedia] = useState(initial.media);
  const [template, setTemplate] = useState(initial.template);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<WaMediaType>(initial.media?.type ?? 'image');
  const [amount, setAmount] = useState(String(initialDelay.delay_amount));
  const [unit, setUnit] = useState<SequenceDelayUnit>(initialDelay.delay_unit);
  const delay = parseDelayInput(amount, unit);

  const chosen = templates.find((tpl) => tpl.name === template?.name && (!template?.language || tpl.language === template.language));
  const count = chosen ? templateVariableCount(chosen.body_text) : (template?.params.length ?? 0);
  const params = Array.from({ length: count }, (_, i) => template?.params[i] ?? contactPlaceholder('name', 'there'));
  const captionLimit = media ? 1024 : 4096;
  const valid = (!!text.trim() || !!media) && text.trim().length <= captionLimit && !uploading && !!delay;

  const setParam = (index: number, value: string) =>
    setTemplate((cur) => cur && { ...cur, params: params.map((p, i) => (i === index ? value : p)) });

  const upload = async (file: File) => {
    if (file.size > MEDIA_MAX_BYTES) { toast.error(t('whatsapp.fileTooLarge')); return; }
    setUploading(true);
    try {
      const { publicUrl } = await uploadAccountMedia(FLOW_MEDIA_BUCKET, file);
      setMedia({ type: kind, url: publicUrl, filename: kind === 'document' ? file.name.slice(0, 240) : null });
    } catch {
      toast.error(t('whatsapp.uploadFailed'));
    } finally {
      setUploading(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!valid || !delay) return;
    const step: WhatsAppStepInput = {
      text: text.trim() || null, media, template: template ? { ...template, params } : null,
    };
    if (await onSave(step, { delay_amount: delay.amount, delay_unit: delay.unit })) onOpenChange(false);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="md" className="overflow-y-auto">
        <form onSubmit={(e) => void submit(e)} className="flex h-full flex-col">
          <SheetHeader>
            <SheetTitle>{t('whatsapp.sheetTitle')}</SheetTitle>
            <SheetDescription>{t('whatsapp.sheetDescription')}</SheetDescription>
          </SheetHeader>
          <div className="flex-1 space-y-5 px-4">
            <div className="space-y-1.5">
              <Label>{first ? t('scheduleFirst') : t('schedulePrevious')}</Label>
              <div className="flex flex-wrap items-center gap-2">
                <Input aria-label={t('delayAmount')} inputMode="numeric" className="w-24" value={amount}
                  onChange={(e) => setAmount(e.target.value)} aria-invalid={!delay} />
                <Select value={unit} onValueChange={(v) => { if (v) setUnit(v as SequenceDelayUnit); }}>
                  <SelectTrigger aria-label={t('delayUnit')} className="w-32">
                    <SelectValue>{t(`unit.${unit}`, { count: delay?.amount ?? 2 })}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {SEQUENCE_DELAY_UNITS.map((u) => <SelectItem key={u} value={u}>{t(`unit.${u}`, { count: 2 })}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
              {delay ? <p className="text-muted-foreground text-xs">{t('whatsapp.delayHint')}</p>
                : <p className="text-destructive text-xs">{t('delayInvalid')}</p>}
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="wa-step-text">{t('whatsapp.text')}</Label>
              <Textarea id="wa-step-text" rows={5} value={text} maxLength={captionLimit} placeholder={String(t.raw('whatsapp.textPlaceholder'))}
                onChange={(e) => setText(e.target.value)} />
              <p className="text-muted-foreground text-xs">{String(t.raw('whatsapp.textHint'))}</p>
            </div>

            <div className="space-y-1.5">
              <Label>{t('whatsapp.media')}</Label>
              {media ? (
                <div className="border-border flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm">
                  <Paperclip className="text-muted-foreground size-4 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">{media.filename ?? t(`whatsapp.mediaType.${media.type}`)}</span>
                  <Button type="button" variant="ghost" size="icon" className="-mr-3 size-11" aria-label={t('whatsapp.removeMedia')} onClick={() => setMedia(null)}>
                    <X className="size-4" />
                  </Button>
                </div>
              ) : (
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl aria-label={t('whatsapp.mediaKind')} size="sm" value={kind} onValueChange={setKind}
                    options={(['image', 'video', 'document'] as const).map((k) => ({ value: k, label: t(`whatsapp.mediaType.${k}`) }))} />
                  <Button type="button" variant="outline" size="sm" className="min-h-11 sm:min-h-7" disabled={uploading} onClick={() => fileRef.current?.click()}>
                    {uploading ? <Loader2 className="size-4 animate-spin" /> : <Paperclip className="size-4" />}
                    {t('whatsapp.attach')}
                  </Button>
                  <input ref={fileRef} type="file" hidden accept={MEDIA_ACCEPT[kind]}
                    onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void upload(file); }} />
                </div>
              )}
            </div>

            <div className="space-y-2">
              <Label>{t('whatsapp.templateLabel')}</Label>
              <Select value={template ? `${template.name}::${template.language ?? ''}` : NO_TEMPLATE}
                onValueChange={(v) => {
                  if (typeof v !== 'string' || v === NO_TEMPLATE) { setTemplate(null); return; }
                  const tpl = templates.find((x) => `${x.name}::${x.language ?? ''}` === v);
                  if (tpl) setTemplate({ name: tpl.name, language: tpl.language, params: [] });
                }}>
                <SelectTrigger aria-label={t('whatsapp.templateLabel')} className="w-full">
                  <SelectValue>{template ? `${template.name}${template.language ? ` · ${template.language}` : ''}` : t('whatsapp.noTemplate')}</SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_TEMPLATE}>{t('whatsapp.noTemplate')}</SelectItem>
                  {templates.map((tpl) => (
                    <SelectItem key={tpl.id} value={`${tpl.name}::${tpl.language ?? ''}`}>
                      {tpl.name}{tpl.language ? ` · ${tpl.language}` : ''}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!template && <p className="text-muted-foreground text-xs">{t('whatsapp.noTemplateHint')}</p>}
              {chosen && <p className="bg-muted text-muted-foreground rounded-lg p-3 text-xs whitespace-pre-wrap">{chosen.body_text}</p>}
              {params.map((value, i) => (
                <TemplateValueRow key={i} t={t} index={i + 1} value={value} onChange={(next) => setParam(i, next)} />
              ))}
            </div>
          </div>
          <SheetFooter className="flex-row justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
            <Button type="submit" disabled={busy || !valid}>
              {busy && <Loader2 className="size-4 animate-spin" />}
              {t('save')}
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function TemplateValueRow({ t, index, value, onChange }: { t: T; index: number; value: string; onChange: (value: string) => void }) {
  const source = templateValueSource(value);
  const fallback = source === 'text' ? '' : (/\|([^{}|]*)\}\}$/.exec(value)?.[1] ?? '');
  return (
    <div className="flex flex-wrap items-end gap-2">
      <div className="space-y-1">
        <Label className="text-xs">{t('whatsapp.variable', { number: index })}</Label>
        <Select value={source} onValueChange={(v) => {
          const next = v as TemplateFieldChoice;
          onChange(next === 'text' ? '' : contactPlaceholder(next, fallback || '-'));
        }}>
          <SelectTrigger aria-label={t('whatsapp.variable', { number: index })} className="w-36">
            <SelectValue>{t(`whatsapp.field.${source}`)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {[...TEMPLATE_FIELD_CHOICES, 'text' as const].map((f) => <SelectItem key={f} value={f}>{t(`whatsapp.field.${f}`)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div className="min-w-40 flex-1 space-y-1">
        <Label className="text-xs">{source === 'text' ? t('whatsapp.value') : t('whatsapp.fallback')}</Label>
        <Input value={source === 'text' ? value : fallback} maxLength={source === 'text' ? 1000 : 100}
          aria-label={source === 'text' ? t('whatsapp.value') : t('whatsapp.fallback')}
          onChange={(e) => onChange(source === 'text' ? e.target.value : contactPlaceholder(source, e.target.value || '-'))} />
      </div>
    </div>
  );
}
