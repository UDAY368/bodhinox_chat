'use client';

/**
 * Settings -> AI assistant (Phase 13): the workspace switches for
 * summaries, suggested replies, intent/lead assessment and business
 * insights, plus an optional monthly token cap. Admins with 'ai.settings'
 * only (GET/PUT /api/ai/settings). Every feature is off until turned on
 * here, and still needs the deployment switch and a configured key, which
 * the status line explains. Saving a switch calls no AI provider.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, Sparkles } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { authFetch } from '@/lib/auth/client';

export type AiToggle = 'summaries_enabled' | 'suggestions_enabled' | 'assessment_enabled' | 'insights_enabled';

export interface AiSettingsView {
  settings: Record<AiToggle, boolean> & { monthly_token_cap: number | null; updated_at: string | null };
  deployment_enabled: boolean;
  configured: boolean;
}

/** Each switch with its AiSettings.features label key. */
export const AI_TOGGLES: { key: AiToggle; feature: 'summary' | 'suggest' | 'assess' | 'insights' }[] = [
  { key: 'summaries_enabled', feature: 'summary' },
  { key: 'suggestions_enabled', feature: 'suggest' },
  { key: 'assessment_enabled', feature: 'assess' },
  { key: 'insights_enabled', feature: 'insights' },
];

/** The cap typed in the box: null for empty, a positive whole number, or 'invalid'. */
export function parseCapInput(raw: string): number | null | 'invalid' {
  const text = raw.trim().replace(/[,\s_]/g, '');
  if (!text) return null;
  if (!/^\d+$/.test(text)) return 'invalid';
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 && n <= 1_000_000_000_000 ? n : 'invalid';
}

/** Which status line applies: the deployment switch first, then the key. */
export function aiStatus(view: Pick<AiSettingsView, 'deployment_enabled' | 'configured'>): 'deploymentOff' | 'notConfigured' | 'ready' {
  if (!view.deployment_enabled) return 'deploymentOff';
  if (!view.configured) return 'notConfigured';
  return 'ready';
}

export function AiAssistantSettings() {
  const t = useTranslations('AiAssistantSettings');
  const ts = useTranslations('AiSettings');
  const [view, setView] = useState<AiSettingsView | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState('');

  const apply = useCallback((next: AiSettingsView) => {
    setView(next);
    setCap(next.settings.monthly_token_cap === null ? '' : String(next.settings.monthly_token_cap));
  }, []);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch('/api/ai/settings', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      apply(await res.json());
    } catch {
      setLoadFailed(true);
    }
  }, [apply]);

  useEffect(() => { void load(); }, [load]);

  const save = async (patch: Partial<Record<AiToggle, boolean>> & { monthly_token_cap?: number | null }) => {
    setBusy(true);
    try {
      const res = await authFetch('/api/ai/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      if (!res.ok) throw new Error();
      apply(await res.json());
      toast.success(t('saved'));
    } catch {
      toast.error(t('saveFailed'));
    } finally {
      setBusy(false);
    }
  };

  const saveCap = () => {
    const parsed = parseCapInput(cap);
    if (parsed === 'invalid') {
      toast.error(t('capInvalid'));
      return;
    }
    void save({ monthly_token_cap: parsed });
  };

  const status = view ? aiStatus(view) : null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Sparkles className="size-4" aria-hidden="true" /> {t('title')}
        </CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {loadFailed && (
          <div className="flex items-center gap-3 text-sm">
            <p className="text-destructive">{t('loadFailed')}</p>
            <Button type="button" size="sm" variant="outline" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {!view && !loadFailed && <Loader2 className="text-muted-foreground size-4 animate-spin" aria-label={t('loading')} />}
        {view && status && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm" role="status">
              <Badge variant={status === 'ready' ? 'secondary' : 'outline'}>
                {status === 'ready' ? ts('status.ready') : t(`badge.${status}`)}
              </Badge>
              {status === 'deploymentOff' && <span className="text-muted-foreground">{ts('status.deploymentOff')} {t('deploymentOffHelp')}</span>}
              {status === 'notConfigured' && (
                <span className="text-muted-foreground">
                  {ts('status.notConfigured')}{' '}
                  <Link href="/agents" className="text-primary underline-offset-2 hover:underline">{t('openAgents')}</Link>
                </span>
              )}
            </div>

            <p className="text-muted-foreground text-sm">{ts('staffReviewNote')}</p>

            <div className="divide-border divide-y rounded-lg border">
              {AI_TOGGLES.map(({ key, feature }) => (
                <label key={key} className="flex items-start gap-3 p-3 text-sm">
                  <Switch
                    checked={view.settings[key]}
                    onCheckedChange={(v: boolean) => void save({ [key]: v })}
                    disabled={busy}
                    aria-describedby={`ai-toggle-${feature}-help`}
                  />
                  <span className="min-w-0">
                    <span className="text-foreground block font-medium">{ts(`features.${feature}`)}</span>
                    <span id={`ai-toggle-${feature}-help`} className="text-muted-foreground block text-xs">{t(`help.${feature}`)}</span>
                  </span>
                </label>
              ))}
            </div>

            <div className="space-y-2">
              <Label htmlFor="ai-token-cap">{ts('monthlyTokenCap')}</Label>
              <div className="flex max-w-sm gap-2">
                <Input
                  id="ai-token-cap"
                  inputMode="numeric"
                  value={cap}
                  onChange={(e) => setCap(e.target.value)}
                  placeholder={t('capPlaceholder')}
                  disabled={busy}
                />
                <Button type="button" variant="outline" onClick={saveCap} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />}
                  {t('saveCap')}
                </Button>
              </div>
              <p className="text-muted-foreground text-xs">{ts('monthlyTokenCapHint')}</p>
            </div>

            <p className="text-muted-foreground text-xs">
              {ts('autonomousNote')}{' '}
              <Link href="/agents" className="text-primary underline-offset-2 hover:underline">{t('autonomousLink')}</Link>
            </p>
            {view.settings.updated_at && (
              <p className="text-muted-foreground text-xs">{t('updatedAt', { date: new Date(view.settings.updated_at).toLocaleString() })}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
