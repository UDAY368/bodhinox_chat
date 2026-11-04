'use client';
// Phase 11 (CRM-02): a contact's Instagram identities on the contact page.
// Shown only while Instagram is enabled and the contact has an identity.
// Admins may link an identity to another contact or undo a link; both
// conversation histories are always kept.
import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { AtSign, Link2, Loader2, Undo2 } from 'lucide-react';
import { authFetch } from '@/lib/auth/client';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { LinkIdentityDialog, type LinkableIdentity } from './link-identity-dialog';

interface IdentityRow {
  id: string;
  username: string | null;
  display_name: string | null;
  can_unlink: boolean;
}

interface IdentitiesResponse {
  enabled: boolean;
  can_link?: boolean;
  identities: IdentityRow[];
}

export function identityLabel(row: Pick<IdentityRow, 'username' | 'display_name'>, fallback: string): string {
  if (row.username) return `@${row.username}`;
  return row.display_name || fallback;
}

export function ContactIdentities({ contactId, onChanged }: { contactId: string; onChanged: () => void }) {
  const t = useTranslations('Contacts.identity');
  const [data, setData] = useState<IdentitiesResponse | null>(null);
  const [linking, setLinking] = useState<LinkableIdentity | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch(`/api/contacts/${contactId}/identities`);
      setData(res.ok ? ((await res.json()) as IdentitiesResponse) : null);
    } catch {
      setData(null);
    }
  }, [contactId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!data?.enabled || data.identities.length === 0) return null;

  async function unlink(row: IdentityRow) {
    const label = identityLabel(row, t('instagram'));
    if (!window.confirm(t('confirmUnlink', { identity: label }))) return;
    setBusyId(row.id);
    try {
      const res = await authFetch(`/api/contacts/${contactId}/identities/unlink`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ identity_id: row.id }),
      });
      const body = (await res.json().catch(() => null)) as { message?: string } | null;
      if (!res.ok) {
        toast.error(body?.message || t('failed'));
        return;
      }
      toast.success(t('unlinked'));
      await load();
      onChanged();
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <Label className="text-muted-foreground text-xs">{t('title')}</Label>
      <ul className="space-y-1.5">
        {data.identities.map((row) => {
          const label = identityLabel(row, t('instagram'));
          return (
            <li key={row.id} className="flex items-center gap-2 rounded-md bg-muted px-2 py-1.5 text-sm">
              <AtSign className="size-3.5 shrink-0 text-muted-foreground" aria-label={t('instagram')} />
              <span className="min-w-0 flex-1 truncate" title={row.display_name ?? undefined}>{label}</span>
              {data.can_link ? (
                row.can_unlink ? (
                  <Button size="sm" variant="ghost" className="h-7 px-2" disabled={busyId === row.id} onClick={() => unlink(row)}>
                    {busyId === row.id ? <Loader2 className="size-3.5 animate-spin" /> : <Undo2 className="size-3.5" />}
                    {t('unlink')}
                  </Button>
                ) : (
                  <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setLinking({ id: row.id, label })}
                    aria-label={t('link')} title={t('link')}>
                    <Link2 className="size-3.5" />
                    {t('linkShort')}
                  </Button>
                )
              ) : null}
            </li>
          );
        })}
      </ul>
      <LinkIdentityDialog
        open={linking !== null}
        onOpenChange={(open) => { if (!open) setLinking(null); }}
        contactId={contactId}
        identity={linking}
        onLinked={() => { void load(); onChanged(); }}
      />
    </div>
  );
}
