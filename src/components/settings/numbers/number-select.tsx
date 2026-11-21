'use client';

// A menu of the workspace's WhatsApp numbers. `emptyLabel` names what no
// number means where it is used ("All numbers" for a flow trigger, "Default
// number" for a campaign); that choice maps to null.
// Disconnected numbers are not offered, except the current value, which keeps
// its name with a "(disconnected)" marker so saving does not silently change it.

import { useTranslations } from 'next-intl';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
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

/** The menu value standing for "no number" (null). */
export const NO_NUMBER = '__none__';

type NumberT = (key: 'unnamedNumber' | 'picker.disconnectedSuffix' | 'picker.disconnectedNumber' | 'defaultBadge', values?: Record<string, string>) => string;

/**
 * The picker's choices in order (pure): the empty choice, the pickable numbers,
 * and a stored id the list does not have at all (another WABA, or gone), so it
 * still shows.
 */
export function numberSelectOptions(
  numbers: WhatsAppNumberDto[],
  value: string | null,
  emptyLabel: string,
  t: NumberT,
): { value: string; label: string }[] {
  const options = pickableNumbers(numbers, value);
  const known = value === null || options.some((n) => n.id === value);
  return [
    { value: NO_NUMBER, label: emptyLabel },
    ...options.map((n) => ({
      value: n.id,
      label: `${numberOptionLabel(n, (key, values) => t(key, values))}${n.is_default ? ` · ${t('defaultBadge')}` : ''}`,
    })),
    ...(!known && value !== null ? [{ value, label: t('picker.disconnectedNumber') }] : []),
  ];
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
  const options = numberSelectOptions(numbers, value, emptyLabel, t as unknown as NumberT);
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v;
  return (
    <Select
      value={value ?? NO_NUMBER}
      disabled={disabled}
      onValueChange={(next) => onChange(!next || next === NO_NUMBER ? null : String(next))}
    >
      <SelectTrigger id={id} className={cn('min-h-11 w-full bg-card sm:min-h-9', className)}>
        <SelectValue>{(v: string) => labelOf(v)}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
