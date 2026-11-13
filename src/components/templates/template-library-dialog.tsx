'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Loader2, Search } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { authFetch } from '@/lib/auth/client';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { TemplatePreview } from './template-preview';
import {
  filterLibrary,
  libraryDraft,
  type LibraryEntry,
  type LibraryFilter,
} from './template-studio-helpers';
import type { TemplateDraftInput } from './types';

interface LibraryResponse {
  language: string;
  templates: LibraryEntry[];
}

function Chip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-0.5 text-xs transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none',
        active
          ? 'border-primary bg-primary/15 text-primary'
          : 'border-border text-muted-foreground hover:bg-muted'
      )}
    >
      {children}
    </button>
  );
}

/** Browse ready-written templates by industry and start a draft from one. */
export function TemplateLibraryDialog({
  open,
  onOpenChange,
  onUse,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  onUse: (draft: TemplateDraftInput) => void;
}) {
  const t = useTranslations('Templates.studio.library');
  const [data, setData] = useState<LibraryResponse | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<LibraryFilter>({
    query: '',
    industry: null,
    category: null,
  });

  // The library is static per locale: load once, the first time it opens.
  useEffect(() => {
    if (!open || data) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await authFetch('/api/whatsapp/templates/library');
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as LibraryResponse;
        if (!cancelled) {
          setData(body);
          setFailed(false);
        }
      } catch {
        if (!cancelled) setFailed(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, data, attempt]);

  const industries = useMemo(() => {
    const seen = new Map<string, string>();
    for (const e of data?.templates ?? []) seen.set(e.industry, e.industry_label);
    return [...seen];
  }, [data]);

  const shown = useMemo(
    () => filterLibrary(data?.templates ?? [], filter),
    [data, filter]
  );

  const use = (entry: LibraryEntry) => {
    if (!data) return;
    onUse(libraryDraft(entry, data.language));
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[90vh] flex-col sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-2">
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={filter.query}
              onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
              placeholder={t('search')}
              aria-label={t('search')}
              className="pl-8"
            />
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('industry')}>
            <Chip
              active={filter.industry === null}
              onClick={() => setFilter((f) => ({ ...f, industry: null }))}
            >
              {t('allIndustries')}
            </Chip>
            {industries.map(([id, label]) => (
              <Chip
                key={id}
                active={filter.industry === id}
                onClick={() => setFilter((f) => ({ ...f, industry: id }))}
              >
                {label}
              </Chip>
            ))}
          </div>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('category')}>
            {([null, 'Marketing', 'Utility'] as const).map((c) => (
              <Chip
                key={c ?? 'all'}
                active={filter.category === c}
                onClick={() => setFilter((f) => ({ ...f, category: c }))}
              >
                {c === null ? t('allCategories') : t(`categories.${c}`)}
              </Chip>
            ))}
          </div>
        </div>

        <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
          {failed ? (
            <div className="flex items-center gap-2 py-6 text-sm text-destructive" role="alert">
              {t('loadFailed')}
              <Button
                variant="outline"
                size="xs"
                onClick={() => {
                  setFailed(false);
                  setAttempt((n) => n + 1);
                }}
              >
                {t('retry')}
              </Button>
            </div>
          ) : !data ? (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
              <Loader2 className="size-4 animate-spin" aria-hidden /> {t('loading')}
            </div>
          ) : shown.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
          ) : (
            <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {shown.map((entry) => (
                <li
                  key={entry.slug}
                  className="flex flex-col gap-2 rounded-xl border border-border bg-card p-3 transition-shadow duration-150 hover:shadow-sm"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{entry.title}</p>
                      <p className="line-clamp-2 text-xs text-muted-foreground">
                        {entry.description}
                      </p>
                    </div>
                    <Badge variant="secondary">{t(`categories.${entry.category}`)}</Badge>
                  </div>
                  <TemplatePreview template={libraryDraft(entry, data.language)} />
                  <div className="mt-auto flex items-center justify-between gap-2">
                    <span className="text-xs text-muted-foreground">{entry.industry_label}</span>
                    <Button
                      size="sm"
                      onClick={() => use(entry)}
                      aria-label={t('useNamed', { title: entry.title })}
                    >
                      {t('use')}
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
