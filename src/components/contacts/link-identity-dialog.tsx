'use client';
// Phase 11 (CRM-02): an admin links an Instagram identity to another contact.
// Nothing is matched automatically; the admin picks the target and confirms a
// message naming both contacts. The server re-checks everything.
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, Search } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { createClient } from '@/lib/data/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

export interface LinkableIdentity {
  id: string;
  label: string;
}

interface Candidate {
  id: string;
  name: string | null;
  phone: string | null;
}

interface LinkIdentityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string;
  identity: LinkableIdentity | null;
  onLinked: () => void;
}

const NOTE_MAX = 200;

export function LinkIdentityDialog({ open, onOpenChange, contactId, identity, onLinked }: LinkIdentityDialogProps) {
  const t = useTranslations('Contacts.identity');
  const [query, setQuery] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [searching, setSearching] = useState(false);
  const [target, setTarget] = useState<Candidate | null>(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) {
      setQuery('');
      setCandidates([]);
      setTarget(null);
      setNote('');
    }
  }, [open]);

  useEffect(() => {
    const term = query.trim();
    if (!open || term.length < 2) {
      setCandidates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(async () => {
      setSearching(true);
      const escaped = term.replace(/[\\%_]/g, (m) => `\\${m}`);
      const { data } = await createClient()
        .from('contacts')
        .select('id,name,phone')
        .ilike('name', `%${escaped}%`)
        .neq('id', contactId)
        .order('name')
        .limit(20);
      if (!cancelled) {
        setCandidates((data ?? []) as Candidate[]);
        setSearching(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query, contactId]);

  const targetLabel = (c: Candidate) => c.name || c.phone || t('unnamed');

  async function confirm() {
    if (!identity || !target) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/contacts/${contactId}/identities/link`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity_id: identity.id, target_contact_id: target.id, note: note.trim() || null }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        toast.error(body?.message || t('failed'));
        return;
      }
      toast.success(t('linked'));
      onOpenChange(false);
      onLinked();
    } catch {
      toast.error(t('failed'));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('link')}</DialogTitle>
          <DialogDescription>{t('linkHint')}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="identity-link-search" className="text-xs text-muted-foreground">{t('pickContact')}</Label>
            <div className="relative">
              <Search className="absolute left-2 top-2 size-4 text-muted-foreground" aria-hidden />
              <Input
                id="identity-link-search"
                value={query}
                onChange={(e) => { setQuery(e.target.value); setTarget(null); }}
                placeholder={t('searchPlaceholder')}
                className="h-8 pl-8 text-sm"
                autoComplete="off"
              />
            </div>
            <div className="max-h-48 overflow-y-auto rounded-xl border border-border" role="listbox" aria-label={t('pickContact')}>
              {searching ? (
                <p className="flex items-center gap-2 p-2 text-xs text-muted-foreground"><Loader2 className="size-3 animate-spin" />{t('searching')}</p>
              ) : candidates.length === 0 ? (
                <p className="p-2 text-xs text-muted-foreground">{query.trim().length < 2 ? t('typeToSearch') : t('noMatches')}</p>
              ) : (
                candidates.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    role="option"
                    aria-selected={target?.id === c.id}
                    onClick={() => setTarget(c)}
                    className={`flex w-full flex-col items-start px-2 py-1.5 text-left text-sm hover:bg-muted ${target?.id === c.id ? 'bg-muted' : ''}`}
                  >
                    <span className="truncate">{targetLabel(c)}</span>
                    {c.name && c.phone ? <span className="text-xs text-muted-foreground">{c.phone}</span> : null}
                  </button>
                ))
              )}
            </div>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="identity-link-note" className="text-xs text-muted-foreground">{t('note')}</Label>
            <Textarea
              id="identity-link-note"
              value={note}
              maxLength={NOTE_MAX}
              onChange={(e) => setNote(e.target.value)}
              className="min-h-[60px] text-sm"
            />
          </div>
          {identity && target ? (
            <p className="rounded-md bg-muted p-2 text-sm" role="status">
              {t('confirmLink', { identity: identity.label, contact: targetLabel(target) })}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>{t('cancel')}</Button>
          <Button onClick={confirm} disabled={!identity || !target || saving}>
            {saving ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
