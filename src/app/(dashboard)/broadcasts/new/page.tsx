'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step0Details, type CampaignChannel } from '@/components/broadcasts/step0-details';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { AiCampaignAssistant } from '@/components/broadcasts/ai-campaign-assistant';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { InstagramMessageStep, InstagramReviewStep } from '@/components/broadcasts/instagram-steps';
import { defaultCampaignName, prefillFromBroadcast } from '@/components/broadcasts/wizard-prefill';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import type { AudienceConfig, CsvAudienceRow } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-create';
import { createInstagramCampaign, deleteCampaignDraft, loadCampaignDraft, saveCampaignDraft } from '@/lib/broadcasts/campaign-client';
import type { CampaignSendExtras } from '@/lib/whatsapp/template-send-params';
import { csvValueColumns } from '@/lib/broadcast-csv';
import { fetchSegments } from '@/lib/audience/client';
import { presetSegmentAudience } from '@/components/broadcasts/preset-segment';
import { Check } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { useLocale, useTranslations } from 'next-intl';

type StepKey = 'details' | 'template' | 'audience' | 'personalize' | 'send' | 'message' | 'review';
// Details (the channel) comes first only when the workspace has two channels to choose from.
// WhatsApp keeps its four template steps; Instagram writes a text and reviews who is inside
// their 24-hour window. The name is asked once, on the last step, already filled in.
const WHATSAPP_STEPS: StepKey[] = ['template', 'audience', 'personalize', 'send'];
const INSTAGRAM_STEPS: StepKey[] = ['audience', 'message', 'review'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `useSearchParams` requires a Suspense boundary or the production build
// bails out of prerendering this page.
export default function NewBroadcastPage() {
  return (
    <Suspense fallback={null}>
      <NewBroadcastWizard />
    </Suspense>
  );
}

function NewBroadcastWizard() {
  const router = useRouter();
  const params = useSearchParams();
  const presetSegmentId = params.get('segmentId');
  const presetTemplateId = params.get('templateId');
  const fromId = params.get('from');
  // ?from=<id>&draft=1 edits that draft (it is removed once the campaign is created); ?from alone duplicates.
  const editingDraft = params.get('draft') === '1';
  const t = useTranslations('Broadcasts.new');
  const tc = useTranslations('Campaigns');
  const locale = useLocale();
  const { data: channelState } = useWorkspaceChannels();
  const enabled = channelState?.enabled ?? ['whatsapp'];
  const { createAndSendBroadcast, isProcessing } = useBroadcastSending();
  // One id for this wizard session: a retry or double submit returns the campaign already created.
  const [clientRequestId] = useState(() => crypto.randomUUID());

  const [channel, setChannel] = useState<CampaignChannel>('whatsapp');
  const [stepKey, setStepKey] = useState<StepKey | null>(null);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<Record<string, VariableMapping>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [trackedUrl, setTrackedUrl] = useState('');
  const [sendExtras, setSendExtras] = useState<CampaignSendExtras>({});
  const [name, setName] = useState('');
  // Until the member types a name, it follows the template (or channel) and today's date.
  const [nameEdited, setNameEdited] = useState(false);
  const [text, setText] = useState('');
  const [igSending, setIgSending] = useState(false);
  // Step 4's choices live here so a saved draft keeps them: send later and its time (datetime-local,
  // workspace time zone), the number to send from, and quiet hours.
  const [later, setLater] = useState(false);
  const [scheduleAt, setScheduleAt] = useState('');
  const [fromNumberId, setFromNumberId] = useState<string | null>(null);
  const [sendWindow, setSendWindow] = useState<{ start: number; end: number } | null>(null);
  const draftId = editingDraft && fromId && UUID.test(fromId) ? fromId : null;

  // An Instagram-only workspace starts on Instagram (and a WhatsApp-only one on WhatsApp),
  // so the Details step never leads into a channel the workspace cannot send on.
  const whatsappOn = enabled.includes('whatsapp');
  const instagramOn = enabled.includes('instagram');
  const channelsKnown = !!channelState;
  useEffect(() => {
    if (!channelsKnown) return;
    if (channel === 'whatsapp' && !whatsappOn && instagramOn) setChannel('instagram');
    if (channel === 'instagram' && !instagramOn && whatsappOn) setChannel('whatsapp');
  }, [channelsKnown, channel, whatsappOn, instagramOn]);

  const showDetails = whatsappOn && instagramOn;
  const steps: StepKey[] = [...(showDetails ? ['details' as const] : []), ...(channel === 'instagram' ? INSTAGRAM_STEPS : WHATSAPP_STEPS)];
  const step = stepKey && steps.includes(stepKey) ? stepKey : steps[0];
  const currentStep = steps.indexOf(step);
  const go = (key: StepKey) => setStepKey(key);
  /** Back from the first content step: the channel choice when there is one, else the list. */
  const backToStart = () => (showDetails ? go('details') : router.push('/broadcasts'));

  const nameBase = channel === 'instagram' ? tc('wizard.channelInstagram') : template?.name;
  useEffect(() => {
    if (nameEdited || !nameBase) return;
    setName(defaultCampaignName(nameBase, new Date(), locale));
  }, [nameEdited, nameBase, locale]);
  const changeName = (next: string) => { setName(next); setNameEdited(true); };

  // ?segmentId= (from "Broadcast to these leads") preselects that segment, but
  // only once the workspace's own segment list confirms it, and only while the
  // user has not picked another audience yet.
  useEffect(() => {
    if (!presetSegmentId) return;
    let cancelled = false;
    fetchSegments()
      .then((segments) => {
        if (!cancelled) setAudience((current) => presetSegmentAudience(current, presetSegmentId, segments));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [presetSegmentId]);

  // ?templateId= (a template's "Use" button) preselects that approved template of this workspace.
  useEffect(() => {
    if (!presetTemplateId || !UUID.test(presetTemplateId)) return;
    let cancelled = false;
    createClient().from('message_templates').select('*').eq('id', presetTemplateId).maybeSingle()
      .then(({ data }: { data: MessageTemplate | null }) => {
        if (cancelled || !data) return;
        if (data.status !== 'APPROVED') { toast.error(tc('wizard.templateNotApproved')); return; }
        setChannel('whatsapp');
        setTemplate(data);
      }, () => undefined);
    return () => { cancelled = true; };
  }, [presetTemplateId, tc]);

  // ?from=<id>&draft=1 reopens a saved draft with every field it holds (lib/broadcasts/drafts).
  useEffect(() => {
    if (!draftId) return;
    let cancelled = false;
    (async () => {
      const draft = await loadCampaignDraft(draftId);
      if (cancelled) return;
      setName(draft.name);
      setNameEdited(true);
      setChannel(draft.channel);
      setText(draft.text ?? '');
      setAudience(draft.audience);
      setVariables((draft.variables ?? {}) as Record<string, VariableMapping>);
      setHeaderMediaUrl(draft.headerMediaUrl ?? '');
      setTrackedUrl(draft.trackedUrl ?? '');
      setSendExtras((draft.sendExtras ?? {}) as CampaignSendExtras);
      setLater(!!draft.scheduledAt);
      setScheduleAt(draft.scheduledAt ?? '');
      setFromNumberId(draft.whatsappConfigId ?? null);
      setSendWindow(draft.sendWindow ?? null);
      if (draft.channel === 'whatsapp' && draft.templateId) {
        const { data } = await createClient().from('message_templates').select('*').eq('id', draft.templateId).eq('status', 'APPROVED').maybeSingle();
        if (cancelled) return;
        if (data) setTemplate(data as MessageTemplate);
        else toast.error(tc('wizard.templateGone'));
      }
    })().catch(() => toast.error(tc('wizard.loadFailed')));
    return () => { cancelled = true; };
  }, [draftId, tc]);

  // ?from= alone (Duplicate) starts from that campaign of this workspace.
  useEffect(() => {
    if (!fromId || !UUID.test(fromId) || editingDraft) return;
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data: row } = await db.from('broadcasts').select('*').eq('id', fromId).maybeSingle();
      if (cancelled || !row) return;
      const prefill = prefillFromBroadcast(row, (n) => tc('wizard.copyName', { name: n }));
      setName(prefill.name);
      setNameEdited(true);
      setChannel(prefill.channel);
      setText(prefill.text);
      setAudience(prefill.audience);
      setVariables(prefill.variables);
      setSendExtras(prefill.sendExtras);
      if (prefill.templateName) {
        const { data: rows } = await db.from('message_templates').select('*')
          .eq('name', prefill.templateName).eq('language', prefill.templateLanguage ?? 'en_US').eq('status', 'APPROVED').limit(1);
        if (cancelled) return;
        const found = (rows as MessageTemplate[] | null)?.[0];
        if (found) setTemplate(found);
        else toast.error(tc('wizard.templateGone'));
      }
    })().catch(() => toast.error(tc('wizard.loadFailed')));
    return () => { cancelled = true; };
  }, [fromId, editingDraft, tc]);

  /** The draft this wizard was opened to finish is replaced by the campaign just created. */
  async function retireDraft() {
    if (draftId) await deleteCampaignDraft(draftId);
  }

  const audienceLabel = useMemo(() => {
    const key = audience.type === 'custom_field' ? 'customField' : audience.type;
    return tc(`wizard.audience.${key}`);
  }, [audience.type, tc]);

  async function handleSend(scheduledAt?: string, options?: { whatsappConfigId: string | null }) {
    if (!template) return;
    // Only the CSV columns a variable uses travel to the server, so unused columns cannot block the campaign.
    const used = new Set(Object.values(variables).flatMap((v) => (v.type === 'csv_column' ? [v.value] : [])));
    const csvContacts = audience.csvContacts?.map(({ values, ...row }): CsvAudienceRow => {
      const kept = Object.fromEntries(Object.entries(values ?? {}).filter(([column]) => used.has(column)));
      return Object.keys(kept).length ? { ...row, values: kept } : row;
    });
    if (csvContacts?.some((row) => Object.values(row.values ?? {}).some((value) => value.length > 1024))) {
      toast.error(t('csvValueTooLong'));
      return;
    }

    try {
      const broadcastId = await createAndSendBroadcast({
        name,
        template,
        audience: {
          type: audience.type,
          tagIds: audience.tagIds,
          customField: audience.customField,
          csvContacts,
          excludeTagIds: audience.excludeTagIds,
          segmentId: audience.segmentId,
          listId: audience.listId,
          ...(audience.type === 'csv' && audience.allowDuplicates ? { allowDuplicates: true } : {}),
          ...(audience.skipRecentDays ? { skipRecentDays: audience.skipRecentDays } : {}),
          // The CSV consent tick (Step 2 requires it; the server refuses a CSV audience without it).
          ...(audience.type === 'csv' ? { consentConfirmed: audience.consentConfirmed === true } : {}),
        },
        variables,
        headerMediaUrl,
        scheduledAt,
        trackedUrl: trackedUrl.trim() || undefined,
        sendExtras,
        whatsappConfigId: options?.whatsappConfigId ?? null,
        clientRequestId,
        sendWindow,
      });
      await retireDraft().catch(() => undefined);
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : t('broadcastFailed');
      console.error('Broadcast failed:', err instanceof Error ? err.name : 'unknown');
      toast.error(message);
    }
  }

  async function handleInstagramSend() {
    setIgSending(true);
    try {
      const id = await createInstagramCampaign({ name: name.trim(), text, audience });
      await retireDraft().catch(() => undefined);
      router.push(`/broadcasts/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('broadcastFailed'));
    } finally {
      setIgSending(false);
    }
  }

  /**
   * Saves every wizard field as a draft (lib/broadcasts/drafts): no recipients, no sending.
   * Editing a draft replaces it in place; Edit on the list reopens it exactly as it was.
   */
  async function handleSaveDraft() {
    if (!name.trim()) {
      toast.error(t('toastGiveName'));
      return;
    }
    try {
      await saveCampaignDraft({
        name: name.trim(),
        channel,
        ...(channel === 'instagram' ? { text: text.slice(0, 1000) } : {}),
        templateId: channel === 'whatsapp' ? template?.id ?? null : null,
        variables,
        headerMediaUrl,
        trackedUrl,
        sendExtras: sendExtras as Record<string, unknown>,
        scheduledAt: later && scheduleAt ? scheduleAt : undefined,
        whatsappConfigId: fromNumberId,
        sendWindow,
        audience,
      }, draftId);
    } catch (err) {
      toast.error(t('toastFailedDraft', { error: err instanceof Error ? err.message : '' }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  const stepLabel = (key: StepKey) => (key === 'details' || key === 'message' || key === 'review'
    ? tc(`wizard.steps.${key}`)
    : t(`steps.${key}`));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <PageHeader className="mb-0" title={t('title')} subtitle={t('subtitle')} />

      {/* Step Indicator: underlined steps, numbered dots; finished steps can be revisited. */}
      <ol className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {steps.map((key, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <li
              key={key}
              aria-current={isActive ? 'step' : undefined}
              className={`flex min-w-0 border-b-2 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
                isActive ? 'flex-1 border-primary text-foreground' : isCompleted ? 'flex-1 border-primary text-muted-foreground' : 'flex-none border-border text-muted-foreground sm:flex-1'
              }`}
            >
              <button
                type="button"
                disabled={!isCompleted || isProcessing || igSending}
                onClick={() => setStepKey(key)}
                className="flex min-w-0 items-center gap-2 rounded-sm px-1 pt-1.5 pb-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring enabled:hover:text-foreground disabled:cursor-default"
              >
                <span
                  className={`inline-flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                    isActive
                      ? 'bg-primary text-primary-foreground'
                      : isCompleted
                        ? 'bg-primary/10 text-primary'
                        : 'bg-muted text-muted-foreground'
                  }`}
                >
                  {isCompleted ? <Check className="size-3" /> : index + 1}
                </span>
                <span className={isActive ? 'truncate' : 'hidden truncate sm:inline'}>
                  {stepLabel(key)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      {/* Step Content */}
      <div className="relative min-h-[400px] rounded-xl border border-border bg-card p-4 sm:p-6">
        <div
          className="transition-all duration-300 ease-in-out"
          style={{
            opacity: isProcessing ? 0.6 : 1,
            pointerEvents: isProcessing ? 'none' : 'auto',
          }}
        >
          {step === 'details' && (
            <Step0Details
              channel={channel}
              onChannelChange={(next) => {
                setChannel(next);
                setStepKey('details');
                // Instagram campaigns cannot use a CSV audience.
                if (next === 'instagram' && audience.type === 'csv') setAudience({ type: 'all' });
              }}
              whatsappAvailable={whatsappOn}
              instagramAvailable={instagramOn}
              onNext={() => go(channel === 'instagram' ? 'audience' : 'template')}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {step === 'template' && (
            <AiCampaignAssistant
              onApply={(draft) => {
                if (draft.template.id !== template?.id) setSendExtras({});
                setTemplate(draft.template);
                setVariables(draft.variables);
                if (draft.audience) setAudience(draft.audience);
              }}
            />
          )}
          {step === 'template' && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={(picked) => {
                setTemplate(picked);
                // Location, offer end and coupon belong to one template.
                if (picked.id !== template?.id) setSendExtras({});
              }}
              onNext={() => go('audience')}
              onBack={backToStart}
            />
          )}
          {step === 'audience' && (
            <Step2SelectAudience
              channel={channel}
              audience={audience}
              onUpdate={setAudience}
              onNext={() => go(channel === 'instagram' ? 'message' : 'personalize')}
              onBack={() => (channel === 'instagram' ? backToStart() : go('template'))}
            />
          )}
          {step === 'personalize' && template && (
            <Step3Personalize
              template={template}
              variables={variables}
              onUpdate={setVariables}
              headerMediaUrl={headerMediaUrl}
              onHeaderMediaUrlChange={setHeaderMediaUrl}
              csvColumns={audience.type === 'csv' ? csvValueColumns(audience.csvContacts ?? []) : []}
              csvSample={audience.type === 'csv' ? audience.csvContacts?.[0]?.values : undefined}
              trackedUrl={trackedUrl}
              onTrackedUrlChange={setTrackedUrl}
              sendExtras={sendExtras}
              onSendExtrasChange={setSendExtras}
              onNext={() => go('send')}
              onBack={() => go('audience')}
            />
          )}
          {step === 'send' && template && (
            <Step4ScheduleSend
              name={name}
              onNameChange={changeName}
              template={template}
              audience={audience}
              onSend={handleSend}
              variables={variables}
              headerMediaUrl={headerMediaUrl}
              sendExtras={sendExtras}
              onSaveDraft={handleSaveDraft}
              later={later}
              onLaterChange={setLater}
              scheduleAt={scheduleAt}
              onScheduleAtChange={setScheduleAt}
              fromNumberId={fromNumberId}
              onFromNumberChange={setFromNumberId}
              sendWindow={sendWindow}
              onSendWindowChange={setSendWindow}
              onBack={() => go('personalize')}
              isProcessing={isProcessing}
            />
          )}
          {step === 'message' && (
            <InstagramMessageStep text={text} onTextChange={setText} onNext={() => go('review')} onBack={() => go('audience')} />
          )}
          {step === 'review' && (
            <InstagramReviewStep
              name={name}
              onNameChange={changeName}
              text={text}
              audience={audience}
              audienceLabel={audienceLabel}
              sending={igSending}
              onSend={handleInstagramSend}
              onBack={() => go('message')}
            />
          )}
        </div>
      </div>
    </div>
  );
}
