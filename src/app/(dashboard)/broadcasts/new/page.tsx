'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { toast } from 'sonner';
import { MessageTemplate } from '@/types';
import { Step1ChooseTemplate } from '@/components/broadcasts/step1-choose-template';
import { AiCampaignAssistant } from '@/components/broadcasts/ai-campaign-assistant';
import { Step2SelectAudience } from '@/components/broadcasts/step2-select-audience';
import { Step3Personalize } from '@/components/broadcasts/step3-personalize';
import { Step4ScheduleSend } from '@/components/broadcasts/step4-schedule-send';
import { useBroadcastSending } from '@/hooks/use-broadcast-sending';
import type { AudienceConfig, CsvAudienceRow } from '@/lib/broadcast-audience';
import type { VariableMapping } from '@/lib/broadcast-create';
import type { CampaignSendExtras } from '@/lib/whatsapp/template-send-params';
import { csvValueColumns } from '@/lib/broadcast-csv';
import { fetchSegments } from '@/lib/audience/client';
import { presetSegmentAudience } from '@/components/broadcasts/preset-segment';
import { Check } from 'lucide-react';
import { useTranslations } from 'next-intl';

const steps = [
  { label: 'template', key: 'template' },
  { label: 'audience', key: 'audience' },
  { label: 'personalize', key: 'personalize' },
  { label: 'send', key: 'send' },
] as const;

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
  const presetSegmentId = useSearchParams().get('segmentId');
  const t = useTranslations('Broadcasts.new');
  const { accountId } = useAuth();
  const { createAndSendBroadcast, isProcessing, progress } = useBroadcastSending();

  const [currentStep, setCurrentStep] = useState(0);
  const [template, setTemplate] = useState<MessageTemplate | null>(null);
  const [audience, setAudience] = useState<AudienceConfig>({ type: 'all' });
  const [variables, setVariables] = useState<Record<string, VariableMapping>>({});
  const [headerMediaUrl, setHeaderMediaUrl] = useState('');
  const [trackedUrl, setTrackedUrl] = useState('');
  const [sendExtras, setSendExtras] = useState<CampaignSendExtras>({});
  const [name, setName] = useState('');

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
      router.push(`/broadcasts/${broadcastId}`);
    } catch (err) {
      // Previously swallowed with console.error — the wizard would
      // just no-op, leaving the user confused. Surface the reason.
      const message = err instanceof Error ? err.message : t('broadcastFailed');
      console.error('Broadcast failed:', err);
      toast.error(message);
    }
  }

  /**
   * Writes a draft broadcast row — no recipients, no sending. The user
   * can revisit it via the list page to finish the flow later. We
   * don't persist the in-progress audience/variable config here
   * because the current schema doesn't carry it past `audience_filter`
   * and `template_variables`; those are enough for the user to
   * recognize the draft but not to exactly round-trip into the wizard.
   * A full resume-draft UX is a future polish.
   */
  async function handleSaveDraft() {
    if (!template || !name.trim()) {
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
      template_name: template.name,
      template_language: template.language ?? 'en_US',
      template_variables: variables,
      audience_filter: {
        type: audience.type,
        tagIds: audience.tagIds,
        segmentId: audience.segmentId,
        listId: audience.listId,
      },
      status: 'draft',
    });

    if (error) {
      toast.error(t('toastFailedDraft', { error: error.message }));
      return;
    }
    toast.success(t('toastDraftSaved'));
    router.push('/broadcasts');
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-[22px] font-bold leading-tight tracking-tight text-foreground">{t('title')}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('subtitle')}
        </p>
      </div>

      {/* Step Indicator: underlined steps, numbered dots */}
      <ol className="flex gap-1 overflow-x-auto [scrollbar-width:none]">
        {steps.map((step, index) => {
          const isActive = index === currentStep;
          const isCompleted = index < currentStep;

          return (
            <li
              key={step.key}
              aria-current={isActive ? 'step' : undefined}
              className={`flex min-w-0 items-center gap-2 border-b-2 px-1 pb-2.5 pt-1.5 text-[13px] font-medium whitespace-nowrap transition-colors duration-150 ${
                isActive ? 'flex-1 border-primary text-foreground' : isCompleted ? 'flex-1 border-primary text-muted-foreground' : 'flex-none border-border text-muted-foreground sm:flex-1'
              }`}
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
                {t(`steps.${step.label}`)}
              </span>
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
          {currentStep === 0 && (
            <AiCampaignAssistant
              onApply={(draft) => {
                if (draft.template.id !== template?.id) setSendExtras({});
                setTemplate(draft.template);
                setVariables(draft.variables);
                if (draft.audience) setAudience(draft.audience);
              }}
            />
          )}
          {currentStep === 0 && (
            <Step1ChooseTemplate
              selectedTemplate={template}
              onSelect={(picked) => {
                setTemplate(picked);
                // Location, offer end and coupon belong to one template.
                if (picked.id !== template?.id) setSendExtras({});
              }}
              onNext={() => setCurrentStep(1)}
              onBack={() => router.push('/broadcasts')}
            />
          )}
          {currentStep === 1 && (
            <Step2SelectAudience
              audience={audience}
              onUpdate={setAudience}
              onNext={() => setCurrentStep(2)}
              onBack={() => setCurrentStep(0)}
            />
          )}
          {currentStep === 2 && template && (
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
              onNext={() => setCurrentStep(3)}
              onBack={() => setCurrentStep(1)}
            />
          )}
          {currentStep === 3 && template && (
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
              onBack={() => setCurrentStep(2)}
              isProcessing={isProcessing}
              progress={progress}
            />
          )}
        </div>
      </div>
    </div>
  );
}
