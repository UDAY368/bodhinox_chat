'use client';

// Contacts > Find duplicates (admins and owners): likely duplicate pairs from
// GET /api/contacts/duplicates, paged on the server ("Show more"). Each pair
// is one grouped list: why it was found, the two contacts, then "Merge…"
// (opens the merge sheet, ./merge-sheet.tsx) and "Not duplicates" (hides the
// pair for good).
import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { AtSign, ChevronLeft, MessageCircle, UsersRound } from 'lucide-react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Button, buttonVariants } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageHeader } from '@/components/ui/page-header';
import { useCan } from '@/hooks/use-can';
import { authFetch } from '@/lib/auth/client';
import type { DuplicateContact, DuplicatePair } from '@/lib/contacts/duplicates';
import { MergeSheet } from './merge-sheet';

type Load = 'loading' | 'ready' | 'error';

function ContactSubtitle({ contact }: { contact: DuplicateContact }) {
  const t = useTranslations('Contacts.duplicates');
  const locale = useLocale();
  const parts = [
    contact.phone,
    contact.email,
    t('conversations', { count: contact.conversations }),
    contact.created_at ? t('added', { date: new Date(contact.created_at).toLocaleDateString(locale, { dateStyle: 'medium' }) }) : null,
  ].filter(Boolean);
  return <span className="tabular-nums">{parts.join(' · ')}</span>;
}

function ContactChannels({ contact }: { contact: DuplicateContact }) {
  const t = useTranslations('Contacts.duplicates');
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      {contact.phone && <MessageCircle className="size-4" aria-label={t('whatsapp')} />}
      {contact.instagram && <AtSign className="size-4" aria-label={t('instagram')} />}
    </span>
  );
}

function PlaceholderGroup() {
  return (
    <GroupedList header={<span className="inline-block h-3 w-24 animate-pulse rounded bg-muted" />}>
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex min-h-14 flex-col justify-center gap-1.5 px-4 py-2.5" aria-hidden>
          <span className="h-4 w-40 animate-pulse rounded bg-muted" />
          <span className="h-3 w-56 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </GroupedList>
  );
}

export default function ContactDuplicatesPage() {
  const t = useTranslations('Contacts.duplicates');
  const canAdmin = useCan('edit-settings');
  const [pairs, setPairs] = useState<DuplicatePair[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [load, setLoad] = useState<Load>('loading');
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [merging, setMerging] = useState<DuplicatePair | null>(null);

  const fetchPage = useCallback(async (after: string | null) => {
    const query = new URLSearchParams({ limit: '20' });
    if (after) query.set('cursor', after);
    const res = await authFetch(`/api/contacts/duplicates?${query}`, { cache: 'no-store' }).catch(() => null);
    if (!res?.ok) throw new Error('load_failed');
    return (await res.json()) as { pairs: DuplicatePair[]; next_cursor: string | null };
  }, []);

  const reload = useCallback(async () => {
    setLoad('loading');
    try {
      const page = await fetchPage(null);
      setPairs(page.pairs);
      setCursor(page.next_cursor);
      setLoad('ready');
    } catch {
      setLoad('error');
    }
  }, [fetchPage]);

  useEffect(() => {
    if (canAdmin) void reload();
  }, [canAdmin, reload]);

  const showMore = async () => {
    if (!cursor) return;
    setMore(true);
    try {
      const page = await fetchPage(cursor);
      setPairs((current) => [...current, ...page.pairs]);
      setCursor(page.next_cursor);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setMore(false);
    }
  };

  const key = (pair: DuplicatePair) => `${pair.contacts[0].id}.${pair.contacts[1].id}`;

  const dismiss = async (pair: DuplicatePair) => {
    setBusy(key(pair));
    const res = await authFetch('/api/contacts/duplicates/dismiss', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contact_ids: [pair.contacts[0].id, pair.contacts[1].id] }),
    }).catch(() => null);
    setBusy(null);
    if (!res?.ok) {
      toast.error(t('dismissFailed'));
      return;
    }
    setPairs((current) => current.filter((p) => key(p) !== key(pair)));
    toast.success(t('dismissed'));
  };

  return (
    <div className="min-w-0">
      <Link href="/contacts" className="-ml-1 mb-1 inline-flex min-h-11 items-center gap-1 text-sm text-primary">
        <ChevronLeft className="size-4" />
        {t('back')}
      </Link>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      {!canAdmin ? (
        <EmptyState icon={UsersRound} title={t('adminsOnly')} />
      ) : load === 'error' ? (
        <InlineError message={t('loadFailed')} onRetry={() => void reload()} />
      ) : load === 'ready' && pairs.length === 0 ? (
        <EmptyState
          icon={UsersRound}
          title={t('empty')}
          action={<Link href="/contacts" className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}>{t('back')}</Link>}
        />
      ) : (
        <div className="space-y-6">
          {load === 'loading'
            ? [0, 1, 2].map((i) => <PlaceholderGroup key={i} />)
            : pairs.map((pair) => (
              <GroupedList key={key(pair)} header={pair.reasons.map((reason) => t(`reason.${reason}`)).join(' · ')}>
                {pair.contacts.map((contact) => (
                  <GroupedListRow
                    key={contact.id}
                    href={`/contacts/${contact.id}`}
                    title={<span className="font-semibold">{contact.name?.trim() || t('noName')}</span>}
                    subtitle={<ContactSubtitle contact={contact} />}
                    trailing={<ContactChannels contact={contact} />}
                  />
                ))}
                <GroupedListRow
                  title={<span className="text-primary">{t('merge')}…</span>}
                  onClick={busy === key(pair) ? undefined : () => setMerging(pair)}
                />
                <GroupedListRow
                  title={t('notDuplicates')}
                  onClick={busy === key(pair) ? undefined : () => void dismiss(pair)}
                  className={busy === key(pair) ? 'opacity-50' : undefined}
                />
              </GroupedList>
            ))}
          {cursor && load === 'ready' && (
            <div className="flex justify-center">
              <Button variant="outline" className="min-h-11" disabled={more} onClick={() => void showMore()}>{t('showMore')}</Button>
            </div>
          )}
        </div>
      )}

      <MergeSheet
        pair={merging}
        onOpenChange={(open) => !open && setMerging(null)}
        onMerged={(mergedId) => {
          setMerging(null);
          setPairs((current) => current.filter((pair) => !pair.contacts.some((c) => c.id === mergedId)));
        }}
      />
    </div>
  );
}
