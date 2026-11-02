'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  TEMPLATE_DRAFT_CATEGORIES,
  TEMPLATE_DRAFT_LIMITS,
  TEMPLATE_DRAFT_TONES,
  type TemplateDraftCategory,
  type TemplateDraftTone,
} from '@/lib/whatsapp/template-ai';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';
import { TemplateLanguageSelect } from './template-language-select';
import { TemplatePreview } from './template-preview';
import type { TemplateDraftInput } from './types';

type Failure = { kind: 'not_configured' } | { kind: 'error'; message: string };

/** Brief the AI writer, review its draft, and hand it to the editor. */
export function TemplateAiDialog({
  open,
  onOpenChange,
  defaultLanguage,
  onUse,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  defaultLanguage: string;
  onUse: (draft: TemplateDraftInput) => void;
}) {
  const t = useTranslations('Templates.studio.ai');
  const [goal, setGoal] = useState('');
  const [tone, setTone] = useState<TemplateDraftTone>('friendly');
  const [category, setCategory] = useState<TemplateDraftCategory>('Marketing');
  const [language, setLanguage] = useState(defaultLanguage);
  const [business, setBusiness] = useState('');
  const [includeButtons, setIncludeButtons] = useState(true);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [draft, setDraft] = useState<TemplatePayload | null>(null);

  const generate = async () => {
    if (!goal.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await authFetch('/api/whatsapp/templates/ai-draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          goal: goal.trim(),
          tone,
          category,
          language,
          ...(business.trim() ? { business: business.trim() } : {}),
          include_buttons: includeButtons,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        draft?: TemplatePayload;
        error?: string;
        code?: string;
      };
      if (res.ok && data.draft) {
        setDraft(data.draft);
      } else if (res.status === 409 && data.code === 'ai_not_configured') {
        setFailure({ kind: 'not_configured' });
      } else if (res.status === 422) {
        setFailure({ kind: 'error', message: data.error || t('invalidDraft') });
      } else {
        setFailure({ kind: 'error', message: data.error || t('failed') });
      }
    } catch {
      setFailure({ kind: 'error', message: t('failed') });
    } finally {
      setBusy(false);
    }
  };

  const useDraft = () => {
    if (!draft) return;
    onUse({ ...draft, template_kind: 'standard' });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" aria-hidden /> {t('title')}
          </DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-2">
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void generate();
            }}
          >
            <div className="space-y-1.5">
              <Label htmlFor="tpl-ai-goal">{t('goal')}</Label>
              <Textarea
                id="tpl-ai-goal"
                value={goal}
                onChange={(e) => setGoal(e.target.value)}
                maxLength={TEMPLATE_DRAFT_LIMITS.goalMaxLength}
                placeholder={t('goalPlaceholder')}
                rows={3}
                required
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="tpl-ai-tone">{t('tone')}</Label>
                <Select
                  value={tone}
                  onValueChange={(v) => {
                    if (v) setTone(v as TemplateDraftTone);
                  }}
                >
                  <SelectTrigger id="tpl-ai-tone" className="w-full">
                    <SelectValue>{t(`tones.${tone}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_DRAFT_TONES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`tones.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tpl-ai-category">{t('category')}</Label>
                <Select
                  value={category}
                  onValueChange={(v) => {
                    if (v) setCategory(v as TemplateDraftCategory);
                  }}
                >
                  <SelectTrigger id="tpl-ai-category" className="w-full">
                    <SelectValue>{t(`categories.${category}`)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {TEMPLATE_DRAFT_CATEGORIES.map((v) => (
                      <SelectItem key={v} value={v}>
                        {t(`categories.${v}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-ai-language">{t('language')}</Label>
              <TemplateLanguageSelect
                id="tpl-ai-language"
                value={language}
                onChange={setLanguage}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="tpl-ai-business">{t('business')}</Label>
              <Input
                id="tpl-ai-business"
                value={business}
                onChange={(e) => setBusiness(e.target.value)}
                maxLength={TEMPLATE_DRAFT_LIMITS.businessMaxLength}
                placeholder={t('businessPlaceholder')}
              />
            </div>
            <div className="flex items-center gap-2">
              <Switch
                id="tpl-ai-buttons"
                checked={includeButtons}
                onCheckedChange={(v) => setIncludeButtons(Boolean(v))}
              />
              <Label htmlFor="tpl-ai-buttons">{t('includeButtons')}</Label>
            </div>
            <Button type="submit" disabled={busy || !goal.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" aria-hidden />}
              {busy ? t('generating') : draft ? t('regenerate') : t('generate')}
            </Button>
          </form>

          <div className="space-y-2" aria-live="polite">
            {failure?.kind === 'not_configured' && (
              <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm" role="alert">
                <p className="font-medium">{t('notConfiguredTitle')}</p>
                <p className="mt-1 text-muted-foreground">{t('notConfiguredHint')}</p>
                <Link href="/agents" className="mt-2 inline-block text-primary underline">
                  {t('openAgentSetup')}
                </Link>
              </div>
            )}
            {failure?.kind === 'error' && (
              <p className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive" role="alert">
                {failure.message}
              </p>
            )}
            {draft ? (
              <>
                <p className="text-xs text-muted-foreground">
                  {t('draftName', { name: draft.name })}
                </p>
                <TemplatePreview template={{ ...draft, template_kind: 'standard' }} />
                <p className="text-xs text-muted-foreground">{t('reviewHint')}</p>
              </>
            ) : (
              !failure && (
                <p className="text-sm text-muted-foreground">{t('emptyPreview')}</p>
              )
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={useDraft} disabled={!draft || busy}>
            {t('useDraft')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
