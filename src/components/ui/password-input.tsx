'use client';

import { useState, type ComponentProps } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from './input';
import { cn } from '@/lib/utils';

export function PasswordInput({ className, disabled, ...props }: Omit<ComponentProps<'input'>, 'type'>) {
  const [visible, setVisible] = useState(false);
  const t = useTranslations('PasswordInput');
  return (
    <div className="relative">
      <Input {...props} disabled={disabled} type={visible ? 'text' : 'password'} className={cn(className, 'pr-10')} />
      <button type="button" disabled={disabled} aria-label={visible ? t('hide') : t('show')}
        aria-pressed={visible} aria-controls={props.id}
        onClick={() => setVisible(value => !value)}
        className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-primary disabled:opacity-50">
        {visible ? <EyeOff className="size-4" aria-hidden="true" /> : <Eye className="size-4" aria-hidden="true" />}
      </button>
    </div>
  );
}
