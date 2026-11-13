'use client';

import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import { BellOff, CheckCircle2, CircleDashed, Loader2 } from 'lucide-react';
import { useFormatter, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { authFetch } from '@/lib/auth/client';
import { consentView, type ConsentStatus } from '@/lib/contacts/consent-view';
import type { Contact } from '@/types';
import { cn } from '@/lib/utils';

const CHIP: Record<ConsentStatus, string> = {
  opted_in: 'bg-emerald-500/12 text-emerald-700 dark:text-emerald-300',
  opted_out: 'bg-red-500/10 text-red-700 dark:text-red-300',
  none: 'bg-muted text-muted-foreground',
};
const ICON = { opted_in: CheckCircle2, opted_out: BellOff, none: CircleDashed } as const;
const LABEL = { opted_in: 'optedIn', opted_out: 'optedOut', none: 'none' } as const;

/** A small consent pill: Opted in / Opted out / No opt-in. */
export function ConsentChip({ contact, className }: { contact: Partial<Contact> | null | undefined; className?: string }) {
  const t = useTranslations('Inbox.consent');
  const { status } = consentView(contact);
  const Icon = ICON[status];
  return (
    <span
      data-consent={status}
      className={cn('inline-flex h-5 shrink-0 items-center gap-1 rounded-full px-2 text-[11px] font-medium', CHIP[status], className)}
    >
      <Icon className="size-3" aria-hidden />
      {t(LABEL[status])}
    </span>
  );
}

type ConsentFields = Pick<Contact, 'opted_out_at' | 'opt_out_source' | 'opted_in_at' | 'opt_in_source'>;

interface ConsentSectionProps {
  contact: Contact;
  canEdit: boolean;
  onChanged: (fields: ConsentFields) => void;
}

/**
 * WhatsApp consent in the contact panel: the current state, since when and how,
 * and the agent's opt-in / opt-out. Recording an opt-in asks for confirmation,
 * since it allows templates and broadcasts to this customer.
 */
export function ConsentSection({ contact, canEdit, onChanged }: ConsentSectionProps) {
  const t = useTranslations('Inbox.consent');
  const format = useFormatter();
  const view = consentView(contact);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Keyboard focus follows the confirm step: into it, back to Record opt-in on cancel,
  // and to the section heading once the change is saved (its buttons change).
  const headingRef = useRef<HTMLHeadingElement>(null);
  const optInRef = useRef<HTMLButtonElement>(null);
  const yesRef = useRef<HTMLButtonElement>(null);
  const openConfirm = () => {
    flushSync(() => setConfirming(true));
    yesRef.current?.focus();
  };
  const cancelConfirm = () => {
    flushSync(() => setConfirming(false));
    optInRef.current?.focus();
  };

  const change = async (state: 'opted_in' | 'opted_out') => {
    setBusy(true);
    try {
      const res = await authFetch(`/api/contacts/${encodeURIComponent(contact.id)}/consent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      if (!res.ok) throw new Error('consent');
      const data = (await res.json()) as { contact: ConsentFields };
      flushSync(() => {
        onChanged(data.contact);
        setConfirming(false);
      });
      headingRef.current?.focus();
      toast.success(t('updated', { status: t(LABEL[consentView(data.contact).status]) }));
    } catch {
      toast.error(t('failed'));
    } finally {
      setBusy(false);
    }
  };

  const sourceKey = view.source ? (`${view.status === 'opted_out' ? 'out' : 'in'}.${view.source}` as const) : null;

  return (
    <section aria-labelledby="consent-title" data-consent-section={view.status}>
      <div className="flex items-center justify-between gap-2">
        <h3 id="consent-title" ref={headingRef} tabIndex={-1} className="outline-none">{t('title')}</h3>
        <ConsentChip contact={contact} />
      </div>
      <p className="text-muted-foreground mt-1.5 text-[13px] leading-5">
        {view.at
          ? t('since', {
              when: format.dateTime(new Date(view.at), { dateStyle: 'medium' }),
              how: sourceKey ? t(`source.${sourceKey}`) : t('source.unknown'),
            })
          : t('noneYet')}
      </p>
      <p className="text-muted-foreground mt-1 text-xs leading-4">{t(`hint.${view.status}`)}</p>

      {canEdit && !confirming && (
        <div className="mt-3 flex flex-wrap gap-2">
          {view.status !== 'opted_in' && (
            <button
              ref={optInRef}
              type="button"
              disabled={busy}
              onClick={openConfirm}
              className="bg-muted hover:bg-muted/70 inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold transition-colors duration-150 disabled:opacity-50"
            >
              <CheckCircle2 className="size-3.5" aria-hidden />
              {t('recordOptIn')}
            </button>
          )}
          {view.status !== 'opted_out' && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void change('opted_out')}
              className="border-border hover:bg-muted inline-flex h-8 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-medium text-red-700 transition-colors duration-150 disabled:opacity-50 dark:text-red-300"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <BellOff className="size-3.5" aria-hidden />}
              {t('optOut')}
            </button>
          )}
        </div>
      )}
      {canEdit && confirming && (
        <div role="group" aria-label={t('recordOptIn')} aria-describedby="consent-confirm-text" className="bg-muted/60 mt-3 rounded-xl p-3">
          <p id="consent-confirm-text" className="text-[13px] leading-5">{t('confirmOptIn')}</p>
          <div className="mt-2.5 flex gap-2">
            <button
              ref={yesRef}
              type="button"
              disabled={busy}
              onClick={() => void change('opted_in')}
              className="bg-primary text-primary-foreground inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-semibold disabled:opacity-60"
            >
              {busy && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
              {t('confirm')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={cancelConfirm}
              className="hover:bg-muted inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium"
            >
              {t('cancel')}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/** Above the composer when the customer has opted out: what is still allowed. */
export function OptedOutBanner({ contact }: { contact: Partial<Contact> | null | undefined }) {
  const t = useTranslations('Inbox.consent');
  const format = useFormatter();
  const view = consentView(contact);
  if (view.status !== 'opted_out' || !view.at) return null;
  return (
    <div
      role="status"
      data-opted-out-banner
      className="mx-3 mb-2 flex items-start gap-2 rounded-xl bg-red-500/8 px-3.5 py-2.5 text-[13px] leading-5 text-red-800 @2xl:mx-6 dark:text-red-200"
    >
      <BellOff className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>
        {t('banner', {
          when: format.dateTime(new Date(view.at), { dateStyle: 'medium' }),
          how: view.source ? t(`source.out.${view.source}`) : t('source.unknown'),
        })}
      </span>
    </div>
  );
}
