'use client';

// Create an API campaign: a name and an approved template. Recipients are
// added later through POST /api/v1/broadcasts/{id}/recipients.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';

export function ApiCampaignDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('Broadcasts.apiCampaign');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<{ id: string; name: string; language: string | null }[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    createClient().from('message_templates').select('id,name,language').eq('status', 'APPROVED').order('name')
      .then(({ data }) => setTemplates(data ?? []));
  }, [open]);

  async function create() {
    setBusy(true);
    try {
      const res = await authFetch('/api/broadcasts/api-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), templateId }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createFailed'));
        return;
      }
      onOpenChange(false);
      setName('');
      setTemplateId('');
      onCreated(payload.id);
    } catch {
      toast.error(t('createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('title')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">{t('description')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="api-campaign-name" className="text-muted-foreground">{t('name')}</Label>
            <Input id="api-campaign-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-campaign-template" className="text-muted-foreground">{t('template')}</Label>
            <select id="api-campaign-template" value={templateId} onChange={(e) => setTemplateId(e.target.value)}
              className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground">
              <option value="">{t('chooseTemplate')}</option>
              {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name} ({tpl.language ?? 'en_US'})</option>)}
            </select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={create} disabled={busy || !name.trim() || !templateId}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
