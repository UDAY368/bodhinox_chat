'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step0Details, type CampaignChannel } from '@/components/broadcasts/step0-details';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { AiCampaignAssistant } from '@/components/broadcasts/ai-campaign-assistant';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { InstagramMessageStep, InstagramReviewStep } from '@/components/broadcasts/instagram-steps';
import { prefillFromBroadcast } from '@/components/broadcasts/wizard-prefill';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import type { AudienceConfig, CsvAudienceRow } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-create';
import { createInstagramCampaign } from '@/lib/broadcasts/campaign-client';
import type { CampaignSendExtras } from '@/lib/whatsapp/template-send-params';
import { csvValueColumns } from '@/lib/broadcast-csv';
import { fetchSegments } from '@/lib/audience/client';
import { presetSegmentAudience } from '@/components/broadcasts/preset-segment';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

type StepKey = 'details' | 'template' | 'audience' | 'personalize' | 'send' | 'message' | 'review';
// The prototype's order: Details (name and channel) first. WhatsApp keeps its four template steps;
// Instagram writes a text and reviews who is inside their 24-hour window.
const WHATSAPP_STEPS: StepKey[] = ['details', 'template', 'audience', 'personalize', 'send'];
const INSTAGRAM_STEPS: StepKey[] = ['details', 'audience', 'message', 'review'];
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
  const { accountId } = useAuth();
  const { data: channelState } = useWorkspaceChannels();
  const enabled = channelState?.enabled ?? ['whatsapp'];
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [channel, setChannel] = useState<CampaignChannel>('whatsapp');
  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<Record<string, VariableMapping>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [trackedUrl, setTrackedUrl] = useState('');
  const [sendExtras, setSendExtras] = useState<CampaignSendExtras>({});
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [igSending, setIgSending] = useState(false);

  const steps = channel === 'instagram' ? INSTAGRAM_STEPS : WHATSAPP_STEPS;
  const step = steps[Math.min(currentStep, steps.length - 1)];
  const go = (key: StepKey) => setCurrentStep(Math.max(0, steps.indexOf(key)));

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

  // ?from= (Duplicate, or a draft's Edit) starts from that campaign of this workspace.
  useEffect(() => {
    if (!fromId || !UUID.test(fromId)) return;
    let cancelled = false;
    (async () => {
      const db = createClient();
      const { data: row } = await db.from('broadcasts').select('*').eq('id', fromId).maybeSingle();
      if (cancelled || !row) return;
      const prefill = prefillFromBroadcast(row, editingDraft ? undefined : (n) => tc('wizard.copyName', { name: n }));
      setName(prefill.name);
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
    if (!editingDraft || !fromId || !UUID.test(fromId)) return;
    await createClient().from('broadcasts').delete().eq('id', fromId).eq('status', 'draft');
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
        },
        variables,
        headerMediaUrl,
        scheduledAt,
        trackedUrl: trackedUrl.trim() || undefined,
        sendExtras,
        whatsappConfigId: options?.whatsappConfigId ?? null,
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
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it from the list (Edit) to finish the flow later: the
   * wizard reopens with its name, channel, template, mappings and audience.
   */
  async function handleSaveDraft() {
    if (!name.trim() || (channel === 'whatsapp' && !template)) {
      toast.error(t('toastGiveName'));
      return;
    }
    const db = createClient();
    const {
      data: { session },
    } = await db.auth.getSession();
    const user = session?.user;
    if (!user) {
      toast.error(t('toastNotSignedIn'));
      return;
    }
    if (!accountId) {
      toast.error(t('toastNotLinked'));
      return;
    }

    const { error } = await db.from('broadcasts').insert({
      user_id: user.id,
      account_id: accountId,
      name: name.trim(),
      template_name: channel === 'instagram' ? '' : template!.name,
      template_language: channel === 'instagram' ? 'en_US' : template!.language ?? 'en_US',
      template_variables: channel === 'instagram' ? {} : variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
        excludeTagIds: audience.excludeTagIds,
        customField: audience.customField,
        segmentId: audience.segmentId,
        listId: audience.listId,
      },
      status: 'draft',
      channel,
      ...(channel === 'instagram' ? { message_text: text.slice(0, 1000) } : {}),
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    await retireDraft().catch(() => undefined);
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  const stepLabel = (key: StepKey) => (key === 'details' || key === 'message' || key === 'review'
    ? tc(`wizard.steps.${key}`)
    : t(`steps.${key}`));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

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
                onClick={() => setCurrentStep(index)}
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
              name={name}
              onNameChange={setName}
              channel={channel}
              onChannelChange={(next) => {
                setChannel(next);
                setCurrentStep(0);
                // Instagram campaigns cannot use a CSV audience.
                if (next === 'instagram' && audience.type === 'csv') setAudience({ type: 'all' });
              }}
              whatsappAvailable={enabled.includes('whatsapp')}
              instagramAvailable={enabled.includes('instagram')}
              onNext={() => setCurrentStep(1)}
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
              onBack={() => go('details')}
            />
          )}
          {step === 'audience' && (
            <Step2SelectAudience
              channel={channel}
              audience={audience}
              onUpdate={setAudience}
              onNext={() => go(channel === 'instagram' ? 'message' : 'personalize')}
              onBack={() => go(channel === 'instagram' ? 'details' : 'template')}
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
              onNameChange={setName}
              template={template}
              audience={audience}
              onSend={handleSend}
              variables={variables}
              headerMediaUrl={headerMediaUrl}
              sendExtras={sendExtras}
              onSaveDraft={handleSaveDraft}
              onBack={() => go('personalize')}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
          {step === 'message' && (
            <InstagramMessageStep text={text} onTextChange={setText} onNext={() => go('review')} onBack={() => go('audience')} />
          )}
          {step === 'review' && (
            <InstagramReviewStep
              name={name.trim()}
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
