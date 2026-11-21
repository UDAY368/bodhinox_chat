'use client';

/**
 * A contact's bookings (WP-D2), for the contact profile, the chat sidebar and
 * the composer: upcoming (next 3) and past (last 3), each opening
 * /appointments?id=<id>, with "New booking" opening the staff booking dialog
 * with the contact filled in. Loads one small paged request
 * (GET /api/appointments/contact/<id>); renders nothing when the plan has no
 * appointments. b4 mounts it; see the exports at the bottom for the composer.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { CalendarPlus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { GroupedList, GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { useAuth } from '@/hooks/use-auth';
import type { ContactBooking, ContactBookingsPage } from '@/lib/appointments/contact-bookings';
import { formatDate } from '@/lib/format/date';
import { AppointmentStatusBadge } from './appointment-status-badge';
import { NewAppointmentDialog } from './new-appointment-dialog';
import { abilitiesFor, apiRequest, useAppointmentConfig } from './shared';

export interface ContactAppointmentsCardProps {
  contactId: string;
  /** The chat this card sits beside, if any (kept for the mount contract; links go to the booking). */
  conversationId?: string | null;
  /** Tighter layout for the chat sidebar: no "Show more". */
  compact?: boolean;
  /** The contact's name, shown in the booking dialog. */
  contactName?: string | null;
}

type ListState = { items: ContactBooking[]; next: string | null; loadingMore: boolean };
export type CardState =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'unavailable' }
  | { state: 'ready'; upcoming: ListState; past: ListState };

const list = (page: ContactBookingsPage): ListState => ({ items: page.items, next: page.next, loadingMore: false });

/** The card's state from a response (pure; tested). */
export function cardStateFrom(result: { ok: true; data: { upcoming: ContactBookingsPage; past: ContactBookingsPage } } | { ok: false; status: number }): CardState {
  if (!result.ok) return result.status === 402 ? { state: 'unavailable' } : { state: 'failed' };
  return { state: 'ready', upcoming: list(result.data.upcoming), past: list(result.data.past) };
}

export function ContactAppointmentsCard({ contactId, compact = false, contactName = null }: ContactAppointmentsCardProps) {
  const { accountRole } = useAuth();
  const [card, setCard] = useState<CardState>({ state: 'loading' });

  const load = useCallback(async () => {
    setCard({ state: 'loading' });
    const r = await apiRequest<{ upcoming: ContactBookingsPage; past: ContactBookingsPage }>(
      `/api/appointments/contact/${encodeURIComponent(contactId)}`);
    setCard(cardStateFrom(r));
  }, [contactId]);
  const booking = useNewBookingDialog({ id: contactId, name: contactName }, () => void load());

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const more = async (kind: 'upcoming' | 'past') => {
    if (card.state !== 'ready') return;
    const cursor = card[kind].next;
    if (!cursor || card[kind].loadingMore) return;
    setCard({ ...card, [kind]: { ...card[kind], loadingMore: true } });
    const r = await apiRequest<ContactBookingsPage>(
      `/api/appointments/contact/${encodeURIComponent(contactId)}?kind=${kind}&limit=10&cursor=${encodeURIComponent(cursor)}`);
    setCard((prev) => {
      if (prev.state !== 'ready') return prev;
      const current = prev[kind];
      return { ...prev, [kind]: r.ok
        ? { items: [...current.items, ...r.data.items], next: r.data.next, loadingMore: false }
        : { ...current, loadingMore: false } };
    });
  };

  return (
    <>
      <ContactAppointmentsView card={card} compact={compact} canBook={abilitiesFor(accountRole).manage}
        onRetry={() => void load()} onNew={booking.open} onMore={(kind) => void more(kind)} />
      {booking.dialog}
    </>
  );
}

/** What the card shows for a state (presentational; rendered in tests). Nothing when the plan has no appointments. */
export function ContactAppointmentsView({ card, compact = false, canBook, onRetry, onNew, onMore }: {
  card: CardState; compact?: boolean; canBook: boolean;
  onRetry: () => void; onNew: () => void; onMore: (kind: 'upcoming' | 'past') => void;
}) {
  const t = useTranslations('Appointments.contactCard');
  const locale = useLocale();
  if (card.state === 'unavailable') return null;

  const newButton = canBook ? (
    <Button size="sm" variant="outline" onClick={onNew}>
      <CalendarPlus className="size-4" />{t('newBooking')}
    </Button>
  ) : null;

  const rows = (items: ContactBooking[]) => items.map((b) => (
    <GroupedListRow
      key={b.id}
      href={`/appointments?id=${b.id}`}
      title={b.service_name}
      subtitle={formatDate(b.start_at, { style: 'datetime', timeZone: b.timezone, locale })}
      trailing={<span className="flex items-center gap-1.5">
        {b.payment_status === 'pending' && b.status === 'held' ? <span className="text-footnote text-muted-foreground">{t('waitingForPayment')}</span> : null}
        <AppointmentStatusBadge status={b.status} />
      </span>}
    />
  ));

  const section = (kind: 'upcoming' | 'past', state: ListState): ReactNode => state.items.length === 0 ? null : (
    <GroupedList header={t(kind)}
      footer={!compact && state.next ? (
        <Button variant="ghost" size="sm" className="-mx-2" disabled={state.loadingMore} onClick={() => onMore(kind)}>
          {t('showMore')}
        </Button>
      ) : undefined}>
      {rows(state.items)}
    </GroupedList>
  );

  return (
    <section data-testid="contact-appointments-card" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-headline">{t('title')}</h3>
        {card.state === 'ready' && (card.upcoming.items.length > 0 || card.past.items.length > 0) ? newButton : null}
      </div>
      {card.state === 'loading' ? <PageLoading rows={compact ? 2 : 3} /> : null}
      {card.state === 'failed' ? <InlineError message={t('loadFailed')} onRetry={onRetry} /> : null}
      {card.state === 'ready' && card.upcoming.items.length === 0 && card.past.items.length === 0 ? (
        <EmptyState icon={CalendarPlus} title={t('empty')} action={newButton} />
      ) : null}
      {card.state === 'ready' ? <>{section('upcoming', card.upcoming)}{section('past', card.past)}</> : null}
    </section>
  );
}

/**
 * The staff booking dialog for one contact, with the configuration loaded only
 * once it is opened. For the composer's "+" menu:
 *   const booking = useNewBookingDialog({ id: contact.id, name: contact.name });
 *   <DropdownMenuItem onSelect={booking.open}>…</DropdownMenuItem>  and render {booking.dialog}
 */
export function useNewBookingDialog(contact: { id: string; name: string | null }, onBooked?: (id: string) => void): {
  open: () => void; dialog: ReactNode;
} {
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  return {
    open: show,
    dialog: open ? <NewBookingForContact contact={contact} onClose={() => setOpen(false)} onBooked={onBooked} /> : null,
  };
}

function NewBookingForContact({ contact, onClose, onBooked }: {
  contact: { id: string; name: string | null }; onClose: () => void; onBooked?: (id: string) => void;
}) {
  const t = useTranslations('Appointments.contactCard');
  const router = useRouter();
  const { config, reload } = useAppointmentConfig();
  if (config.state === 'failed')
    return <InlineError message={t('loadFailed')} onRetry={() => void reload()} />;
  if (config.state !== 'ready') return null;
  return (
    <NewAppointmentDialog
      open
      onOpenChange={(v) => { if (!v) onClose(); }}
      config={config.config}
      initialContact={contact}
      onBooked={(id) => {
        onClose();
        if (onBooked) onBooked(id);
        else router.push(`/appointments?id=${id}`);
      }}
    />
  );
}
