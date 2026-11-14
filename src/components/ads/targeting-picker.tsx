'use client';

// A search box over Meta's targeting options (GET /api/meta-ads/targeting):
// interests, cities and regions, or languages. Chosen options show as chips;
// results are fetched after a short pause in typing, latest query wins.

import { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Input } from '@/components/ui/input';
import { authFetch } from '@/lib/auth/client';
import { formatNumber } from './ads-shared';

export interface TargetingChoice {
  type: 'interest' | 'region' | 'city' | 'locale';
  id: string;
  name: string;
  detail: string | null;
  countryCode: string | null;
  size: number | null;
}

const DEBOUNCE_MS = 300;

export function TargetingPicker({ id, label, help, type, chosen, max, onAdd, onRemove }: {
  id: string;
  label: string;
  help?: string;
  type: 'interest' | 'place' | 'locale';
  chosen: TargetingChoice[];
  max: number;
  onAdd: (choice: TargetingChoice) => void;
  onRemove: (choice: TargetingChoice) => void;
}) {
  const t = useTranslations('Ads.create.targeting');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<TargetingChoice[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const latest = useRef(0);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setResults(null); setLoading(false); return; }
    const ticket = ++latest.current;
    setLoading(true);
    const timer = setTimeout(() => {
      authFetch(`/api/meta-ads/targeting?type=${type}&q=${encodeURIComponent(q)}`, { cache: 'no-store' })
        .then(async (res) => {
          if (!res.ok) throw new Error();
          return ((await res.json()) as { options: TargetingChoice[] }).options;
        })
        .then((options) => { if (ticket === latest.current) { setResults(options); setFailed(false); } })
        .catch(() => { if (ticket === latest.current) { setResults([]); setFailed(true); } })
        .finally(() => { if (ticket === latest.current) setLoading(false); });
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, type]);

  const isChosen = (o: TargetingChoice) => chosen.some((c) => c.type === o.type && c.id === o.id);
  const full = chosen.length >= max;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="text-sm font-medium text-foreground">{label}</label>
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {chosen.map((c) => (
            <button key={`${c.type}:${c.id}`} type="button" onClick={() => onRemove(c)} aria-label={t('remove', { name: c.name })}
              className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20">
              {c.name}{c.type === 'city' || c.type === 'region' ? (c.countryCode ? ` · ${c.countryCode}` : '') : ''} <X className="size-3" />
            </button>
          ))}
        </div>
      )}
      <div className="relative">
        <Input id={id} value={query} disabled={full} maxLength={100} autoComplete="off"
          placeholder={full ? t('full', { max }) : t(`placeholder.${type}`)} onChange={(e) => setQuery(e.target.value)} />
        {loading && <Loader2 className="absolute right-2.5 top-2.5 size-4 animate-spin text-muted-foreground" />}
      </div>
      {results && (
        <ul className="max-h-48 overflow-y-auto rounded-lg border border-border bg-card" role="listbox" aria-label={label}>
          {results.length === 0 ? (
            <li className="px-3 py-2 text-xs text-muted-foreground">{failed ? t('failed') : t('none')}</li>
          ) : results.map((o) => (
            <li key={`${o.type}:${o.id}`}>
              <button type="button" role="option" aria-selected={isChosen(o)} disabled={isChosen(o) || full}
                onClick={() => { onAdd(o); setQuery(''); setResults(null); }}
                className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted disabled:opacity-50">
                <span className="min-w-0">
                  <span className="block truncate text-foreground">{o.name}</span>
                  {(o.detail || o.type === 'city' || o.type === 'region') && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {o.type === 'city' || o.type === 'region' ? `${t(`kinds.${o.type}`)}${o.detail ? ` · ${o.detail}` : ''}` : o.detail}
                    </span>
                  )}
                </span>
                {o.size !== null && <span className="shrink-0 text-xs text-muted-foreground">{t('size', { size: formatNumber(o.size) })}</span>}
              </button>
            </li>
          ))}
        </ul>
      )}
      {help && <p className="text-xs text-muted-foreground">{help}</p>}
    </div>
  );
}
