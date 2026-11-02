'use client';

import { useMemo, useState } from 'react';
import { CheckIcon, ChevronDownIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';
import { TEMPLATE_LANGUAGES } from '@/lib/whatsapp/template-languages';
import { cn } from '@/lib/utils';
import { filterLanguages } from './template-studio-helpers';

/** Searchable picker over the language codes Meta accepts for templates. */
export function TemplateLanguageSelect({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (code: string) => void;
  id?: string;
}) {
  const t = useTranslations('Templates.studio.language');
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const matches = useMemo(() => filterLanguages(TEMPLATE_LANGUAGES, query), [query]);
  const current = TEMPLATE_LANGUAGES.find((l) => l.code === value);

  const choose = (code: string) => {
    onChange(code);
    setOpen(false);
    setQuery('');
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        id={id}
        aria-haspopup="listbox"
        className="flex h-8 w-full items-center justify-between gap-1.5 rounded-lg border border-input bg-transparent px-2.5 text-left text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <span className={cn('truncate', !value && 'text-muted-foreground')}>
          {current ? `${current.label} · ${current.code}` : value || t('placeholder')}
        </span>
        <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <Input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && matches[0]) {
              e.preventDefault();
              choose(matches[0].code);
            }
          }}
          placeholder={t('search')}
          aria-label={t('search')}
        />
        <div role="listbox" aria-label={t('label')} className="max-h-64 overflow-y-auto">
          {matches.length === 0 ? (
            <p className="px-2 py-3 text-center text-xs text-muted-foreground">
              {t('noMatch')}
            </p>
          ) : (
            matches.map((l) => (
              <button
                key={l.code}
                type="button"
                role="option"
                aria-selected={l.code === value}
                onClick={() => choose(l.code)}
                className="flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                <span className="truncate">{l.label}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {l.code}
                  {l.code === value && <CheckIcon className="size-3.5 text-primary" aria-hidden />}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
