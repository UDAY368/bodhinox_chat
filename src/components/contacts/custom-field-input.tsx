'use client';

// One custom field value control for its type: text, number, date or a
// choice list. The server checks the value again (custom-field-types.ts).
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { OptionSelect } from '@/components/ui/option-select';


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
      <OptionSelect
        id={id}
        aria-label={ariaLabel}
        value={value}
        disabled={disabled}
        onValueChange={(next) => {
          onChange(next);
          onCommit?.(next);
        }}
        className={cn('h-9', className)}
        options={[
          { value: '', label: t('fieldsTab.notSet') },
          ...choices.map((c) => ({ value: c, label: c })),
          ...(value && !choices.includes(value) ? [{ value, label: value }] : []),
        ]}
      />
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
