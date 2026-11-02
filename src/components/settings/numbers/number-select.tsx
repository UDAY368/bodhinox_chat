'use client';

// A plain <select> of the workspace's WhatsApp numbers. `emptyLabel` names
// what the empty value means where it is used ("All numbers" for a flow
// trigger, "Default number" for a campaign); value '' maps to null.
// Disconnected numbers are not offered, except the current value, which keeps
// its name with a "(disconnected)" marker so saving does not silently change it.

import { useTranslations } from 'next-intl';
import { numberLabel, type WhatsAppNumberDto } from './use-whatsapp-numbers';

/**
 * The numbers a picker offers: connected ones only, plus `currentId` when an
 * existing record still points at a disconnected number, so it keeps showing
 * (and saving does not silently change it) without being offered for new
 * choices.
 */
export function pickableNumbers<T extends Pick<WhatsAppNumberDto, 'id' | 'removed'>>(
  numbers: T[],
  currentId?: string | null
): T[] {
  return numbers.filter((n) => !n.removed || n.id === currentId);
}

/** numberLabel, marked "(disconnected)" for a number an admin disconnected. */
export function numberOptionLabel(
  n: Pick<WhatsAppNumberDto, 'display_name' | 'phone_number_id' | 'removed'>,
  t: (key: 'unnamedNumber' | 'picker.disconnectedSuffix', values: Record<string, string>) => string
): string {
  const name = numberLabel(n, t);
  return n.removed ? t('picker.disconnectedSuffix', { name }) : name;
}

interface NumberSelectProps {
  id?: string;
  numbers: WhatsAppNumberDto[];
  value: string | null;
  onChange: (value: string | null) => void;
  emptyLabel: string;
  disabled?: boolean;
  className?: string;
}

export function NumberSelect({ id, numbers, value, onChange, emptyLabel, disabled, className }: NumberSelectProps) {
  const t = useTranslations('whatsappNumbers');
  const options = pickableNumbers(numbers, value);
  // A stored id the list does not have at all (another WABA, or gone) still shows.
  const known = value === null || options.some((n) => n.id === value);
  return (
    <select
      id={id}
      value={value ?? ''}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value || null)}
      className={className ?? 'border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm'}
    >
      <option value="">{emptyLabel}</option>
      {options.map((n) => (
        <option key={n.id} value={n.id}>
          {numberOptionLabel(n, t)}
          {n.is_default ? ` · ${t('defaultBadge')}` : ''}
        </option>
      ))}
      {!known && <option value={value ?? ''}>{t('picker.disconnectedNumber')}</option>}
    </select>
  );
}
