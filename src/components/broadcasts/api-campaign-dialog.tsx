'use client';

// Create an API campaign: a name and an approved template. Recipients are
// added later through POST /api/v1/broadcasts/{id}/recipients.

import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { OptionSelect } from '@/components/ui/option-select';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import { NumberSelect } from '@/components/settings/numbers/number-select';
import { numberLabel, useWhatsAppNumbers } from '@/components/settings/numbers/use-whatsapp-numbers';

export function ApiCampaignDialog({ open, onOpenChange, onCreated }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (id: string) => void;
}) {
  const t = useTranslations('Broadcasts.apiCampaign');
  const [name, setName] = useState('');
  const [templateId, setTemplateId] = useState('');
  const [templates, setTemplates] = useState<{ id: string; name: string; language: string | null; waba_id?: string | null }[]>([]);
  const tn = useTranslations('whatsappNumbers');
  const { numbers: allNumbers } = useWhatsAppNumbers();
  const defaultNumber = allNumbers.find((n) => n.is_default);
  // null = the workspace default number.
  const [fromNumberId, setFromNumberId] = useState<string | null>(null);
  // A template is approved per WhatsApp Business Account: only numbers in its WABA can send it.
  const templateWaba = templates.find((tpl) => tpl.id === templateId)?.waba_id ?? null;
  const numbers = allNumbers.filter((n) => !templateWaba || !n.waba_id || n.waba_id === templateWaba);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    createClient().from('message_templates').select('id,name,language,waba_id').eq('status', 'APPROVED').order('name')
      .then(({ data }) => setTemplates(data ?? []));
  }, [open]);

  async function create() {
    setBusy(true);
    try {
      const res = await authFetch('/api/broadcasts/api-campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim(), templateId, ...(fromNumberId ? { whatsappConfigId: fromNumberId } : {}) }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createFailed'));
        return;
      }
      onOpenChange(false);
      setName('');
      setTemplateId('');
      setFromNumberId(null);
      onCreated(payload.id);
    } catch {
      toast.error(t('createFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" size="md" className="w-full overflow-y-auto">
        <SheetHeader>
          <SheetTitle>{t('title')}</SheetTitle>
          <SheetDescription>{t('description')}</SheetDescription>
        </SheetHeader>
        <div className="space-y-3 px-4">
          <div className="space-y-1.5">
            <Label htmlFor="api-campaign-name" className="text-muted-foreground">{t('name')}</Label>
            <Input id="api-campaign-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="api-campaign-template" className="text-muted-foreground">{t('template')}</Label>
            <OptionSelect id="api-campaign-template" value={templateId} onValueChange={setTemplateId} className="h-9"
              options={[
                { value: '', label: t('chooseTemplate') },
                ...templates.map((tpl) => ({ value: tpl.id, label: `${tpl.name} (${tpl.language ?? 'en_US'})` })),
              ]} />
          </div>
          {allNumbers.length > 1 && (
            <div className="space-y-1.5">
              <Label htmlFor="api-campaign-send-from" className="text-muted-foreground">{tn('picker.sendFrom')}</Label>
              <NumberSelect
                id="api-campaign-send-from"
                numbers={numbers}
                value={fromNumberId}
                onChange={setFromNumberId}
                emptyLabel={defaultNumber ? tn('picker.defaultNumber', { name: numberLabel(defaultNumber, tn) }) : tn('picker.defaultNumberUnset')}
                className="h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground"
              />
            </div>
          )}
        </div>
        <SheetFooter className="sm:flex-row sm:justify-end">
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t('cancel')}</Button>
          <Button onClick={create} disabled={busy || !name.trim() || !templateId}>
            {busy && <Loader2 className="size-4 animate-spin" />}
            {t('create')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
