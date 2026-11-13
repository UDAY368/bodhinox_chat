'use client';

// One custom field value control for its type: text, number, date or a
// choice list. The server checks the value again (custom-field-types.ts).
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

export const FIELD_SELECT =
  'h-9 w-full min-w-0 rounded-lg border border-border bg-card px-2.5 text-sm text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-60';

export function CustomFieldInput({
  id,
  type,
  choices,
  value,
  onChange,
  onCommit,
  disabled,
  className,
  ariaLabel,
}: {
  id?: string;
  type: string;
  choices: string[];
  value: string;
  onChange: (value: string) => void;
  /** Called when the person leaves the control (or picks a choice): the profile saves then. */
  onCommit?: (value: string) => void;
  disabled?: boolean;
  className?: string;
  ariaLabel?: string;
}) {
  const t = useTranslations('Contacts.redesign');
  if (type === 'choice')
    return (
      <select
        id={id}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          onCommit?.(e.target.value);
        }}
        className={cn(FIELD_SELECT, className)}
      >
        <option value="">{t('fieldsTab.notSet')}</option>
        {choices.map((c) => (
          <option key={c} value={c}>{c}</option>
        ))}
        {value && !choices.includes(value) && <option value={value}>{value}</option>}
      </select>
    );
  return (
    <Input
      id={id}
      aria-label={ariaLabel}
      type={type === 'number' ? 'number' : type === 'date' ? 'date' : 'text'}
      inputMode={type === 'number' ? 'decimal' : undefined}
      step={type === 'number' ? 'any' : undefined}
      value={value}
      maxLength={1000}
      disabled={disabled}
      placeholder={t('profile.add')}
      onChange={(e) => onChange(e.target.value)}
      onBlur={(e) => onCommit?.(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
      }}
      className={cn('min-w-0', className)}
    />
  );
}
