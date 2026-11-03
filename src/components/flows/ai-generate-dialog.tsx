'use client';

// "Generate with AI": describe a goal, get a new DRAFT flow (never active).
// The server builds, validates and saves it; we just open it in the builder.

import { useState } from 'react';
import { toast } from 'sonner';
import { Loader2, Sparkles } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/auth/client';

const GOAL_MAX = 2000;

export interface AiGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Called with the new draft flow's id. */
  onCreated: (flowId: string) => void;
}

export function AiGenerateDialog({ open, onOpenChange, onCreated }: AiGenerateDialogProps) {
  const t = useTranslations('AiFlowGenerator');
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);

  async function generate() {
    const text = goal.trim();
    if (!text) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/ai/generate-flow', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal: text }),
      });
      const payload = (await res.json().catch(() => ({}))) as { flow?: { id: string }; issues?: string[]; error?: string };
      if (!res.ok || !payload.flow) {
        toast.error(payload.error || t('failed'));
        return;
      }
      if (payload.issues?.length) toast.warning(t('createdWithIssues', { count: payload.issues.length }));
      else toast.success(t('created'));
      setGoal('');
      onOpenChange(false);
      onCreated(payload.flow.id);
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="ai-flow-goal" className="text-muted-foreground">{t('goalLabel')}</Label>
          <Textarea
            id="ai-flow-goal"
            value={goal}
            maxLength={GOAL_MAX}
            rows={5}
            placeholder={t('goalPlaceholder')}
            onChange={(e) => setGoal(e.target.value)}
            disabled={busy}
            className="bg-muted"
          />
          <p className="text-xs text-muted-foreground">{t('draftNote')}</p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>{t('cancel')}</Button>
          <Button onClick={generate} disabled={busy || !goal.trim()}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />}
            {busy ? t('generating') : t('generate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A "Generate with AI" button that owns its dialog — the one-line mount for the flows page. */
export function AiGenerateFlowButton({ onCreated, disabled }: { onCreated: (flowId: string) => void; disabled?: boolean }) {
  const t = useTranslations('AiFlowGenerator');
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant="outline" onClick={() => setOpen(true)} disabled={disabled}>
        <Sparkles className="size-4" />
        {t('button')}
      </Button>
      <AiGenerateDialog open={open} onOpenChange={setOpen} onCreated={onCreated} />
    </>
  );
}
