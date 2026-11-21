'use client';

// Ads → Audiences: Meta custom audiences built in Bodhinox. A customer list is
// a contact segment uploaded to Meta (hashed) and re-uploaded every 6 hours; a
// lookalike reaches people like those in a customer list. Every member sees
// the list; admins create, sync, re-check and remove (the audience itself stays
// in the Meta ad account). Ads use them from the Create ad dialog.

import { useCallback, useEffect, useState } from 'react';
import { ExternalLink, Loader2, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import { LoadingRows } from '@/components/ads/ads-ui';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { OptionSelect } from '@/components/contacts/option-select';
import { authFetch } from '@/lib/auth/client';
import { fetchSegments, type SegmentSummary } from '@/lib/audience/client';
import { cn } from '@/lib/utils';
import type { LinkedAdAccount } from '@/lib/meta-ads/accounts';
import type { AudienceDto } from '@/lib/meta-ads/audiences';
import { formatNumber } from './ads-shared';

const POLL_MS = 5_000;
const MAX_POLLS = 60;

async function post(body: Record<string, unknown>): Promise<{ audience?: AudienceDto }> {
  const res = await authFetch('/api/meta-ads/audiences', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  // Meta ads routes answer { error: <code>, message }.
  if (!res.ok) throw Object.assign(new Error('failed'), { code: typeof payload.error === 'string' ? payload.error : undefined });
  return payload;
}

export function AudiencesPanel({ canManage, accounts, refreshKey = 0 }: {
  canManage: boolean; accounts: LinkedAdAccount[]; refreshKey?: number;
}) {
  const t = useTranslations('Ads.audiences');
  const [audiences, setAudiences] = useState<AudienceDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ kind: 'customer_list' } | { kind: 'lookalike'; origin: AudienceDto } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/meta-ads/audiences', { cache: 'no-store' });
      if (res.ok) setAudiences(((await res.json()) as { audiences: AudienceDto[] }).audiences);
      else setAudiences((list) => list ?? []);
    } catch {
      setAudiences((list) => list ?? []);
    }
  }, []);
  useEffect(() => { void load(); }, [load, refreshKey]);

  const running = audiences?.some((a) => a.status === 'queued') ?? false;
  useEffect(() => {
    if (!running) return;
    let polls = 0;
    const timer = setInterval(() => { polls += 1; if (polls > MAX_POLLS) clearInterval(timer); else void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [running, load]);

  const act = async (audience: AudienceDto, body: Record<string, unknown>) => {
    setBusy(audience.id);
    try {
      const result = await post({ id: audience.id, ...body });
      if (body.action === 'remove') setAudiences((list) => list?.filter((a) => a.id !== audience.id && a.originId !== audience.id) ?? null);
      else if (result.audience) setAudiences((list) => list?.map((a) => (a.id === audience.id ? result.audience! : a)) ?? null);
      if (body.action === 'recheck') toast.message(result.audience?.status === 'unknown' ? t('stillUnknown') : t('found'));
    } catch {
      toast.error(t('actionFailed'));
    } finally {
      setBusy(null);
    }
  };

  const size = (a: AudienceDto) => a.matchedLower === null && a.matchedUpper === null ? '—'
    : a.matchedUpper && a.matchedLower !== a.matchedUpper
      ? t('sizeRange', { lower: formatNumber(a.matchedLower ?? 0), upper: formatNumber(a.matchedUpper) })
      : formatNumber(a.matchedLower ?? a.matchedUpper ?? 0);
  const accountName = (id: string) => accounts.find((a) => a.adAccountId === id)?.name ?? id;

  return (
    <section aria-labelledby="audiences-title" className="space-y-3" data-testid="ads-audiences">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="audiences-title" className="text-sm font-semibold text-foreground">{t('title')}</h2>
          <p className="text-xs text-muted-foreground">{t('description')}</p>
        </div>
        {canManage && accounts.length > 0 && (
          <Button type="button" size="sm" onClick={() => setCreating({ kind: 'customer_list' })} data-testid="new-audience">
            <Plus className="size-4" /> {t('new')}
          </Button>
        )}
      </div>

      {audiences === null ? (
        <LoadingRows rows={3} />
      ) : audiences.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center">
          <Users className="mx-auto size-6 text-muted-foreground" aria-hidden />
          <p className="mt-2 text-sm font-medium text-foreground">{t('emptyTitle')}</p>
          <p className="mx-auto mt-1 max-w-md text-xs text-muted-foreground">{t('emptyBody')}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border/70 rounded-xl border border-border bg-card">
          {audiences.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1 basis-60">
                <p className="truncate text-sm font-medium text-foreground">{a.name}</p>
                <p className="text-xs text-muted-foreground">
                  {a.kind === 'customer_list'
                    ? t('fromSegment', { segment: a.segmentName ?? t('segmentDeleted') })
                    : a.kind === 'lookalike' ? t('lookalikeOf', { percent: a.lookalikePercent ?? 1, country: a.lookalikeCountry ?? '' })
                    : t(`ruleOf.${a.ruleSource ?? 'page'}`, { days: a.retentionDays ?? 30 })}
                  {accounts.length > 1 && ` · ${accountName(a.adAccountId)}`}
                </p>
              </div>
              <div className="text-right text-xs text-muted-foreground">
                <p><span className="font-medium text-foreground">{size(a)}</span> {t('matched')}</p>
                {a.kind === 'customer_list' && a.uploadedCount !== null && <p>{t('uploaded', { count: formatNumber(a.uploadedCount) })}</p>}
                {a.lastSyncedAt && <p>{t('synced', { at: new Date(a.lastSyncedAt).toLocaleString() })}</p>}
              </div>
              <span className={cn('rounded-full px-2 py-0.5 text-xs font-medium',
                a.status === 'ready' ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                  : a.status === 'failed' ? 'bg-destructive/10 text-destructive'
                  : a.status === 'unknown' ? 'bg-amber-500/10 text-amber-700 dark:text-amber-300'
                  : 'bg-muted text-muted-foreground')}>
                {a.status === 'queued' && <Loader2 className="mr-1 inline size-3 animate-spin" />}
                {t(`status.${a.status}`)}
              </span>
              {canManage && (
                <div className="flex flex-wrap items-center gap-1.5">
                  {a.kind === 'customer_list' && (
                    <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                      <Switch checked={a.autoSync} disabled={busy === a.id} aria-label={t('autoSync')}
                        onCheckedChange={(next) => void act(a, { action: 'auto_sync', autoSync: next })} />
                      {t('autoSync')}
                    </label>
                  )}
                  {a.kind === 'customer_list' && a.metaAudienceId && (a.status === 'ready' || a.status === 'failed') && (
                    <Button type="button" size="sm" variant="outline" disabled={busy === a.id} onClick={() => void act(a, { action: 'sync' })}>
                      <RefreshCw className="size-3.5" /> {t('syncNow')}
                    </Button>
                  )}
                  {a.kind === 'customer_list' && a.status === 'ready' && (
                    <Button type="button" size="sm" variant="outline" onClick={() => setCreating({ kind: 'lookalike', origin: a })}>
                      {t('makeLookalike')}
                    </Button>
                  )}
                  {a.status === 'unknown' && (
                    <Button type="button" size="sm" variant="outline" disabled={busy === a.id} onClick={() => void act(a, { action: 'recheck' })}>{t('recheck')}</Button>
                  )}
                  <Button type="button" size="icon" variant="ghost" disabled={busy === a.id} aria-label={t('remove', { name: a.name })}
                    onClick={() => void act(a, { action: 'remove' })}>
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              )}
              {a.status === 'failed' && a.lastErrorCode && (
                <p className="basis-full text-xs text-destructive">
                  {a.lastErrorCode === 'terms_not_accepted' ? (
                    <>
                      {t('errors.terms_not_accepted')}{' '}
                      <a href={`https://business.facebook.com/ads/manage/customaudiences/tos/?act=${encodeURIComponent(a.adAccountId)}`}
                        target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium underline">
                        {t('acceptTerms')} <ExternalLink className="size-3" />
                      </a>
                    </>
                  ) : t.has(`errors.${a.lastErrorCode}`) ? t(`errors.${a.lastErrorCode}`) : t('errors.generic', { code: a.lastErrorCode })}
                </p>
              )}
              {a.status === 'ready' && a.lastErrorCode === 'empty_segment' && (
                <p className="basis-full text-xs text-amber-700 dark:text-amber-300">{t('errors.empty_segment')}</p>
              )}
            </li>
          ))}
        </ul>
      )}
      {audiences?.some((a) => a.status === 'unknown') && <p className="text-xs text-muted-foreground">{t('unknownHelp')}</p>}
      <p className="text-xs text-muted-foreground">{t('privacy')}</p>

      {creating && (
        <NewAudienceDialog
          creating={creating}
          accounts={accounts}
          onClose={() => setCreating(null)}
          onCreated={(audience) => { setAudiences((list) => [audience, ...(list ?? [])]); setCreating(null); }}
        />
      )}
    </section>
  );
}

const COUNTRIES = ['IN', 'US', 'GB', 'AE', 'SA', 'SG', 'AU', 'CA', 'DE', 'ID', 'MY', 'PH', 'BR', 'MX', 'ZA', 'NG', 'KE'];

function NewAudienceDialog({ creating, accounts, onClose, onCreated }: {
  creating: { kind: 'customer_list' } | { kind: 'lookalike'; origin: AudienceDto };
  accounts: LinkedAdAccount[];
  onClose: () => void;
  onCreated: (audience: AudienceDto) => void;
}) {
  const t = useTranslations('Ads.audiences');
  const lookalike = creating.kind === 'lookalike' ? creating.origin : null;
  const [segments, setSegments] = useState<SegmentSummary[] | null>(null);
  const [segmentId, setSegmentId] = useState('');
  const [adAccountId, setAdAccountId] = useState(lookalike?.adAccountId ?? accounts.find((a) => a.isPrimary)?.adAccountId ?? accounts[0]?.adAccountId ?? '');
  const [name, setName] = useState(lookalike ? t('lookalikeName', { name: lookalike.name, percent: 1 }) : '');
  const [country, setCountry] = useState(lookalike?.lookalikeCountry ?? 'IN');
  const [percent, setPercent] = useState(1);
  const [autoSync, setAutoSync] = useState(true);
  // Where a new (non-lookalike) audience comes from: your contacts, or a rule Meta keeps up to date.
  const [source, setSource] = useState<'contacts' | 'page' | 'instagram' | 'pixel'>('contacts');
  const [retention, setRetention] = useState(90);
  const [pixelId, setPixelId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (lookalike) return;
    fetchSegments().then(setSegments).catch(() => setSegments([]));
  }, [lookalike]);

  const valid = name.trim().length > 0 && !!adAccountId
    && (lookalike ? true : source === 'contacts' ? !!segmentId : source === 'pixel' ? /^\d{1,32}$/.test(pixelId.trim()) : true);
  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const body = lookalike
        ? { action: 'create', kind: 'lookalike', adAccountId, name: name.trim(), originId: lookalike.id, country, percent }
        : source === 'contacts' ? { action: 'create', kind: 'customer_list', adAccountId, name: name.trim(), segmentId, autoSync }
        : source === 'pixel' ? { action: 'create', kind: 'website', adAccountId, name: name.trim(), pixelId: pixelId.trim(), retentionDays: retention }
        : { action: 'create', kind: 'engagement', adAccountId, name: name.trim(), source, retentionDays: retention };
      const result = await post(body);
      toast.success(t('created'));
      onCreated(result.audience!);
    } catch (e) {
      const code = (e as { code?: string }).code;
      setError(code === 'name_taken' ? t('errors.name_taken') : code === 'limit_reached' ? t('errors.limit_reached')
        : code === 'missing_scope' ? t('errors.missing_scope') : t('actionFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet open onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <SheetContent size="md" className="w-full overflow-y-auto" data-testid="new-audience-dialog">
        <SheetHeader>
          <SheetTitle>{lookalike ? t('newLookalikeTitle') : source === 'contacts' ? t('newTitle') : t('newRuleTitle')}</SheetTitle>
          <SheetDescription>{lookalike ? t('newLookalikeDescription', { name: lookalike.name }) : source === 'contacts' ? t('newDescription') : t('newRuleDescription')}</SheetDescription>
        </SheetHeader>
        <div className="space-y-4 px-4">
          {!lookalike && (
            <div role="radiogroup" aria-label={t('source')} className="grid gap-2 sm:grid-cols-2" data-testid="audience-source">
              {(['contacts', 'page', 'instagram', 'pixel'] as const).map((k) => (
                <button key={k} type="button" role="radio" aria-checked={source === k} onClick={() => setSource(k)}
                  className={cn('rounded-xl border p-3 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring',
                    source === k ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/60')}>
                  <span className="block font-medium text-foreground">{t(`sources.${k}.title`)}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{t(`sources.${k}.body`)}</span>
                </button>
              ))}
            </div>
          )}
          {!lookalike && source !== 'contacts' && (
            <div className="grid gap-4 sm:grid-cols-2">
              {source === 'pixel' && (
                <div className="space-y-1">
                  <Label htmlFor="audience-pixel">{t('pixel')}</Label>
                  <Input id="audience-pixel" inputMode="numeric" value={pixelId} onChange={(e) => setPixelId(e.target.value)} placeholder="1234567890" />
                  <p className="text-xs text-muted-foreground">{t('pixelHelp')}</p>
                </div>
              )}
              <div className="space-y-1">
                <Label htmlFor="audience-retention">{t('retention')}</Label>
                <OptionSelect id="audience-retention" value={String(retention)} onValueChange={(v) => setRetention(Number(v))}
                  options={[30, 60, 90, 180, 365].map((d) => ({ value: String(d), label: t('days', { days: d }) }))} />
              </div>
            </div>
          )}
          {!lookalike && source === 'contacts' && (
            <div className="space-y-1">
              <Label htmlFor="audience-segment">{t('segment')}</Label>
              {segments === null ? <Loader2 className="size-4 animate-spin text-muted-foreground" />
                : segments.length === 0 ? <p className="text-xs text-muted-foreground">{t('noSegments')}</p>
                : (
                  <OptionSelect id="audience-segment" value={segmentId} placeholder={t('chooseSegment')}
                    onValueChange={(v) => { setSegmentId(v); if (!name) setName(segments.find((s) => s.id === v)?.name ?? ''); }}
                    options={segments.map((s) => ({ value: s.id, label: s.name }))} />
                )}
              <p className="text-xs text-muted-foreground">{t('segmentHelp')}</p>
            </div>
          )}
          <div className="space-y-1">
            <Label htmlFor="audience-name">{t('name')}</Label>
            <Input id="audience-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} />
          </div>
          {!lookalike && accounts.length > 1 && (
            <div className="space-y-1">
              <Label htmlFor="audience-account">{t('adAccount')}</Label>
              <OptionSelect id="audience-account" value={adAccountId} onValueChange={setAdAccountId}
                options={accounts.map((a) => ({ value: a.adAccountId, label: a.name ?? a.adAccountId }))} />
            </div>
          )}
          {lookalike ? (
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="audience-country">{t('country')}</Label>
                <OptionSelect id="audience-country" value={country} onValueChange={setCountry}
                  options={[...new Set([country, ...COUNTRIES])].map((c) => ({ value: c, label: c }))} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="audience-percent">{t('size')}</Label>
                <OptionSelect id="audience-percent" value={String(percent)}
                  onValueChange={(v) => { const p = Number(v); setPercent(p); setName(t('lookalikeName', { name: lookalike.name, percent: p })); }}
                  options={Array.from({ length: 10 }, (_, i) => i + 1).map((p) => ({ value: String(p), label: t('percent', { percent: p }) }))} />
                <p className="text-xs text-muted-foreground">{t('sizeHelp')}</p>
              </div>
            </div>
          ) : source === 'contacts' && (
            <label className="flex items-center gap-2 text-sm text-foreground">
              <Switch checked={autoSync} onCheckedChange={setAutoSync} aria-label={t('autoSync')} />
              {t('autoSyncHelp')}
            </label>
          )}
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <SheetFooter className="flex-row justify-end">
          <Button type="button" variant="outline" onClick={onClose} disabled={busy}>{t('cancel')}</Button>
          <Button type="button" onClick={() => void submit()} disabled={!valid || busy}>
            {busy && <Loader2 className="size-4 animate-spin" />} {t('create')}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
