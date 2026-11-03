'use client';

import { useEffect, useState } from 'react';
import type { AudienceConfig } from '@/lib/broadcast-audience';
import { audienceReach } from '@/lib/audience/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, CalendarClock, FlaskConical, Send, Loader2, Users, Save } from 'lucide-react';
import { useTranslations } from 'next-intl';
import type { CampaignSendExtras } from '@/lib/whatsapp/template-send-params';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client';
import type { VariableMapping } from '@/lib/broadcast-create';

import { planAllows, usePlan } from '@/lib/billing/client';
import { UpgradeBadge } from '@/components/ui/upgrade-badge';
import { NumberSelect } from '@/components/settings/numbers/number-select';
import { CampaignCostEstimate } from '@/components/broadcasts/campaign-cost';
import { numberLabel, useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';

const TEST_NUMBERS_KEY = 'bodhinox.campaignTestNumbers';

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  /**
   * `scheduledAt` (ISO) sends later instead of now. `whatsappConfigId` is the
   * number chosen under "Send from" (null = the workspace default; the picker
   * only shows when the workspace has two or more numbers).
   */
  onSend: (scheduledAt?: string, options?: { whatsappConfigId: string | null }) => void;
  /** Variable mappings and header media, so a test send matches the real campaign. */
  variables: Record<string, VariableMapping>;
  headerMediaUrl?: string;
  /** Location, offer end and coupon code chosen in step 3. */
  sendExtras?: CampaignSendExtras;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  variables,
  headerMediaUrl,
  sendExtras,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const t = useTranslations('Broadcasts.wizard');
  const tn = useTranslations('whatsappNumbers');
  const { numbers: allNumbers } = useWhatsAppNumbers();
  // A template is approved per WhatsApp Business Account, so only numbers in
  // the template's WABA (or with no WABA on file) can send it.
  const templateWaba = (template as { waba_id?: string | null }).waba_id ?? null;
  const numbers = allNumbers.filter((n) => !templateWaba || !n.waba_id || n.waba_id === templateWaba);
  const defaultNumber = allNumbers.find((n) => n.is_default);
  // null = the workspace default number.
  const [fromNumberId, setFromNumberId] = useState<string | null>(null);
  // Shown in the summary and confirmation only when there is a choice to see.
  const sendingNumber = fromNumberId ? allNumbers.find((n) => n.id === fromNumberId) : defaultNumber;
  const sendFromLabel = allNumbers.length > 1 && sendingNumber ? numberLabel(sendingNumber, tn) : null;
  const [showConfirm, setShowConfirm] = useState(false);
  const canSchedule = planAllows(usePlan(), 'campaign_scheduling');
  const [later, setLater] = useState(false);
  // datetime-local value in the browser's own time zone.
  const [scheduleAt, setScheduleAt] = useState('');
  const scheduledDate = later && scheduleAt ? new Date(scheduleAt) : null;
  const scheduleValid = !later || (scheduledDate !== null && scheduledDate.getTime() > Date.now() + 60_000);
  // Test numbers are remembered per browser; storage can be unavailable (private mode).
  const [testNumbers, setTestNumbers] = useState(() => {
    try { return localStorage.getItem(TEST_NUMBERS_KEY) ?? ''; } catch { return ''; }
  });
  const [testing, setTesting] = useState(false);

  async function sendTest() {
    const phones = testNumbers.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
    if (!phones.length || phones.length > 3) {
      toast.error(t('scheduleSend.testNumbersInvalid'));
      return;
    }
    try { localStorage.setItem(TEST_NUMBERS_KEY, phones.join(', ')); } catch { /* not remembered */ }
    setTesting(true);
    try {
      const res = await authFetch('/api/broadcasts/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          templateId: template.id, phones, variables, headerMediaUrl: headerMediaUrl?.trim() || undefined,
          ...(fromNumberId ? { whatsappConfigId: fromNumberId } : {}),
          ...(sendExtras && Object.keys(sendExtras).length ? { sendExtras } : {}),
        }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('scheduleSend.testFailed'));
        return;
      }
      for (const r of (payload as { results: { phone: string; ok: boolean; error?: string }[] }).results) {
        if (r.ok) toast.success(t('scheduleSend.testSent', { phone: r.phone }));
        else toast.error(t('scheduleSend.testNotSent', { phone: r.phone, error: r.error ?? '' }));
      }
    } catch {
      toast.error(t('scheduleSend.testFailed'));
    } finally {
      setTesting(false);
    }
  }
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        setEstimatedReach((await audienceReach(audience)) ?? 0);
      } catch {
        setEstimatedReach(0);
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('scheduleSend.audienceAll')
      : audience.type === 'tags'
        ? t('scheduleSend.audienceTags')
        : audience.type === 'csv'
          ? t('scheduleSend.audienceCsv')
          : audience.type === 'segment'
            ? t('scheduleSend.audienceSegment')
            : audience.type === 'list'
              ? t('scheduleSend.audienceList')
              : t('scheduleSend.audienceField');

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('scheduleSend.title')}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t('scheduleSend.subtitle')}
        </p>
      </div>

      {/* Broadcast Name */}
      <div>
        <label className="mb-1.5 block text-sm font-medium text-foreground">{t('scheduleSend.broadcastName')}</label>
        <Input
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('scheduleSend.broadcastNamePlaceholder')}
          className="border-border bg-muted text-foreground placeholder:text-muted-foreground"
        />
      </div>

      {/* Send from: only when the workspace has more than one number. */}
      {allNumbers.length > 1 && (
        <div>
          <label htmlFor="broadcast-send-from" className="mb-1.5 block text-sm font-medium text-foreground">
            {tn('picker.sendFrom')}
          </label>
          <NumberSelect
            id="broadcast-send-from"
            numbers={numbers}
            value={fromNumberId}
            onChange={setFromNumberId}
            emptyLabel={
              defaultNumber
                ? tn('picker.defaultNumber', { name: numberLabel(defaultNumber, tn) })
                : tn('picker.defaultNumberUnset')
            }
            className="border-border bg-muted text-foreground h-9 w-full rounded-md border px-2 text-sm"
          />
          <p className="mt-1 text-xs text-muted-foreground">{tn('picker.sendFromHelp')}</p>
        </div>
      )}

      {/* Summary Card */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.summary')}</p>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.template')}</p>
            <p className="text-foreground">{template.name}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.audience')}</p>
            <p className="text-foreground">{audienceLabel}</p>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.estimatedReach')}</p>
            <div className="flex items-center gap-1.5">
              {loadingReach ? (
                <Loader2 className="h-3 w-3 animate-spin text-primary" />
              ) : (
                <>
                  <Users className="h-3.5 w-3.5 text-primary" />
                  <p className="font-medium text-foreground">{estimatedReach.toLocaleString()}</p>
                </>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs text-muted-foreground">{t('scheduleSend.language')}</p>
            <p className="text-foreground">{template.language ?? 'en_US'}</p>
          </div>
          {sendFromLabel && (
            <div>
              <p className="text-xs text-muted-foreground">{tn('picker.sendFrom')}</p>
              <p className="text-foreground">{sendFromLabel}</p>
            </div>
          )}
        </div>
        <CampaignCostEstimate templateId={template.id} audience={audience} />
      </div>

      {/* Test send */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-2">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.testTitle')}</p>
        <p className="text-xs text-muted-foreground">{t('scheduleSend.testHint')}</p>
        <div className="flex flex-wrap gap-2">
          <Input
            aria-label={t('scheduleSend.testNumbers')}
            value={testNumbers}
            onChange={(e) => setTestNumbers(e.target.value)}
            placeholder="+919876543210, +14155550123"
            className="min-w-[240px] flex-1 border-border bg-muted text-foreground placeholder:text-muted-foreground"
          />
          <Button variant="outline" onClick={sendTest} disabled={testing || !testNumbers.trim() || isProcessing}>
            {testing ? <Loader2 className="h-4 w-4 animate-spin" /> : <FlaskConical className="h-4 w-4" />}
            {t('scheduleSend.sendTest')}
          </Button>
        </div>
      </div>

      {/* When to send */}
      <div className="rounded-xl border border-border bg-card/50 p-4 space-y-3">
        <p className="text-sm font-medium text-foreground">{t('scheduleSend.whenLabel')}</p>
        <div className="flex flex-wrap gap-4 text-sm text-foreground">
          <label className="flex items-center gap-2">
            <input type="radio" name="send-when" checked={!later} onChange={() => setLater(false)} />
            {t('scheduleSend.whenNow')}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" name="send-when" checked={later} disabled={!canSchedule} onChange={() => setLater(true)} />
            {t('scheduleSend.whenLater')}
            {!canSchedule && <UpgradeBadge />}
          </label>
        </div>
        {later && (
          <div className="space-y-1">
            <Input
              type="datetime-local"
              aria-label={t('scheduleSend.scheduleAt')}
              value={scheduleAt}
              onChange={(e) => setScheduleAt(e.target.value)}
              className="w-60 border-border bg-muted text-foreground"
            />
            <p className="text-xs text-muted-foreground">
              {scheduleAt && !scheduleValid
                ? t('scheduleSend.scheduleTooSoon')
                : t('scheduleSend.scheduleHint', { zone: Intl.DateTimeFormat().resolvedOptions().timeZone })}
            </p>
          </div>
        )}
      </div>

      {/* Processing overlay */}
      {isProcessing && (
        <div className="rounded-xl border border-primary/20 bg-primary/5 p-4">
          <div className="mb-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
              <p className="text-sm font-medium text-foreground">{t('scheduleSend.sending')}</p>
            </div>
            <span className="text-xs font-medium text-primary">{progress}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted">
            <div
              className="h-1.5 rounded-full bg-primary transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-4">
        <Button
          variant="outline"
          onClick={onBack}
          disabled={isProcessing}
          className="border-border text-muted-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          {t('back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button
              variant="outline"
              onClick={onSaveDraft}
              disabled={!name.trim() || isProcessing}
              className="border-border text-muted-foreground hover:bg-muted disabled:opacity-50"
            >
              <Save className="h-4 w-4" />
              {t('scheduleSend.saveDraft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
          <DialogTrigger
            render={
              <Button
                disabled={!name.trim() || isProcessing || !scheduleValid}
                className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              />
            }
          >
            {later ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
            {later ? t('scheduleSend.scheduleBroadcast') : t('scheduleSend.sendNow')}
          </DialogTrigger>
          <DialogContent className="border-border bg-popover sm:max-w-md">
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('scheduleSend.confirmTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">
                {t.rich('scheduleSend.confirmDesc', {
                  count: estimatedReach,
                  template: template.name,
                  b: (chunks) => (
                    <span className="font-medium text-popover-foreground">{chunks}</span>
                  ),
                })}
                {sendFromLabel && (
                  <span className="mt-2 block">{t('scheduleSend.confirmSendFrom', { number: sendFromLabel })}</span>
                )}
                {scheduledDate && (
                  <span className="mt-2 block">
                    {t('scheduleSend.confirmScheduled', { when: scheduledDate.toLocaleString() })}
                  </span>
                )}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setShowConfirm(false)}
                className="border-border text-muted-foreground"
              >
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setShowConfirm(false);
                  onSend(scheduledDate?.toISOString(), { whatsappConfigId: fromNumberId });
                }}
                className="bg-primary text-primary-foreground hover:bg-primary/90"
              >
                {later ? <CalendarClock className="h-4 w-4" /> : <Send className="h-4 w-4" />}
                {later ? t('scheduleSend.scheduleBroadcast') : t('scheduleSend.sendNow')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        </div>
      </div>
    </div>
  );
}
