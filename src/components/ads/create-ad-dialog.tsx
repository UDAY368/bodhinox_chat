'use client';

// "Create ad" (admins, ad management on): a four-step dialog that makes a
// click-to-WhatsApp, click-to-Instagram-Direct, instant-form lead or website
// traffic ad on the connected Page. 1. Goal and ad account; 2. audience,
// budget and schedule; 3. the ad (image, text, button); 4. review, then
// "Create paused" or "Publish" (Meta reviews a published ad before it runs).
// The image uploads to the ad account first (POST /api/meta-ads/images); the
// ad is then queued (POST /api/meta-ads/drafts) and made by the worker; its
// progress shows in "Ads created in Bodhinox".

import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Globe, ImagePlus, Loader2, MessageCircle, UserPlus } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { authFetch } from '@/lib/auth/client';
import { isCurrencyCode, parseMoney } from '@/lib/commerce/money';
import { cn } from '@/lib/utils';
import type { LinkedAdAccount } from '@/lib/meta-ads/accounts';

type Kind = 'whatsapp' | 'instagram_direct' | 'lead_form' | 'website';
const KINDS: { kind: Kind; icon: typeof Globe }[] = [
  { kind: 'whatsapp', icon: MessageCircle },
  { kind: 'instagram_direct', icon: AtSign },
  { kind: 'lead_form', icon: UserPlus },
  { kind: 'website', icon: Globe },
];
/** Mirrors CTA_TYPES in src/lib/meta-ads/create.ts (not imported: that module is server-only). */
const CTAS: Record<'lead_form' | 'website', string[]> = {
  lead_form: ['SIGN_UP', 'LEARN_MORE', 'APPLY_NOW', 'GET_QUOTE', 'SUBSCRIBE', 'DOWNLOAD'],
  website: ['LEARN_MORE', 'SHOP_NOW', 'SIGN_UP', 'BOOK_TRAVEL', 'CONTACT_US', 'ORDER_NOW', 'GET_OFFER', 'APPLY_NOW', 'SUBSCRIBE', 'DOWNLOAD'],
};
const COMMON_COUNTRIES = ['IN', 'US', 'GB', 'AE', 'SA', 'SG', 'AU', 'CA', 'DE', 'BR', 'ID', 'MX'];
const ERRORS = new Set(['invalid_request', 'invalid_choice', 'missing_scope', 'over_budget_cap', 'token_invalid', 'manage_not_enabled',
  'not_connected', 'rate_limited', 'meta_error']);

const localInput = (ms: number) => {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface CreateAdDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accounts: LinkedAdAccount[];
  /** Preselected ad account (the page's selection), else the primary one. */
  adAccountId: string | null;
  pageName: string | null;
  onCreated: () => void;
}

export function CreateAdDialog({ open, onOpenChange, accounts, adAccountId, pageName, onCreated }: CreateAdDialogProps) {
  const t = useTranslations('Ads.create');
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [kind, setKind] = useState<Kind>('whatsapp');
  const [account, setAccount] = useState<string>('');
  const [name, setName] = useState('');
  const [budget, setBudget] = useState('');
  const [start, setStart] = useState(() => localInput(Date.now()));
  const [end, setEnd] = useState('');
  const [countries, setCountries] = useState<string[]>(['IN']);
  const [countryInput, setCountryInput] = useState('');
  const [ageMin, setAgeMin] = useState(18);
  const [ageMax, setAgeMax] = useState(65);
  const [gender, setGender] = useState<'all' | '1' | '2'>('all');
  const [primaryText, setPrimaryText] = useState('');
  const [headline, setHeadline] = useState('');
  const [description, setDescription] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [leadFormId, setLeadFormId] = useState('');
  const [cta, setCta] = useState('');
  const [whatsappNumber, setWhatsappNumber] = useState('');
  const [welcome, setWelcome] = useState('');
  const [image, setImage] = useState<{ hash: string; url: string | null; preview: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [forms, setForms] = useState<{ id: string; name: string | null }[] | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // A fresh dialog each time it opens.
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAccount(adAccountId ?? accounts.find((a) => a.isPrimary)?.adAccountId ?? accounts[0]?.adAccountId ?? '');
  }, [open, adAccountId, accounts]);

  useEffect(() => {
    if (!open || kind !== 'lead_form' || forms) return;
    authFetch('/api/meta-ads/leads/forms', { cache: 'no-store' })
      .then(async (res) => (res.ok ? ((await res.json()) as { forms: { id: string; name: string | null }[] }).forms : []))
      .then(setForms)
      .catch(() => setForms([]));
  }, [open, kind, forms]);

  const currency = accounts.find((a) => a.adAccountId === account)?.currency ?? null;
  const budgetMinor = useMemo(() => {
    if (!budget.trim() || !currency || !isCurrencyCode(currency)) return null;
    try {
      const minor = parseMoney(budget, currency);
      return minor > 0 ? minor : null;
    } catch {
      return null;
    }
  }, [budget, currency]);

  const errorText = (code: unknown) => t(`errors.${typeof code === 'string' && ERRORS.has(code) ? code : 'generic'}`);

  const upload = async (file: File) => {
    if (!account) return;
    if (!/^image\/(jpeg|png)$/.test(file.type) || file.size > 8 * 1024 * 1024) {
      toast.error(t('imageRules'));
      return;
    }
    setUploading(true);
    try {
      const form = new FormData();
      form.set('file', file);
      form.set('adAccountId', account);
      const res = await authFetch('/api/meta-ads/images', { method: 'POST', body: form });
      const body = (await res.json().catch(() => ({}))) as { hash?: string; url?: string | null; error?: string };
      if (!res.ok || !body.hash) throw new Error(body.error ?? 'generic');
      setImage({ hash: body.hash, url: body.url ?? null, preview: URL.createObjectURL(file) });
    } catch (error) {
      toast.error(errorText(error instanceof Error ? error.message : null));
    } finally {
      setUploading(false);
    }
  };

  const addCountry = (code: string) => {
    const c = code.trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(c) && !countries.includes(c) && countries.length < 25) setCountries([...countries, c]);
    setCountryInput('');
  };

  const stepValid = [
    !!account,
    !!name.trim() && budgetMinor !== null && countries.length > 0 && ageMin <= ageMax && (!end || Date.parse(end) > Date.parse(start) + 86_400_000),
    !!primaryText.trim() && !!image && (kind !== 'website' || /^https:\/\/\S+$/.test(linkUrl.trim())) && (kind !== 'lead_form' || !!leadFormId),
    true,
  ];

  const submit = async (publish: boolean) => {
    if (budgetMinor === null || !image) return;
    setBusy(true);
    try {
      const res = await authFetch('/api/meta-ads/drafts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'create', adAccountId: account, kind, name: name.trim(), dailyBudgetMinor: budgetMinor,
          startTime: new Date(start).toISOString(), endTime: end ? new Date(end).toISOString() : null,
          countries, ageMin, ageMax, genders: gender === 'all' ? [] : [Number(gender)],
          primaryText: primaryText.trim(), headline: headline.trim() || null, description: description.trim() || null,
          linkUrl: kind === 'website' ? linkUrl.trim() : null, leadFormId: kind === 'lead_form' ? leadFormId : null,
          ctaType: kind === 'lead_form' || kind === 'website' ? (cta || CTAS[kind][0]) : undefined,
          imageHash: image.hash, imageUrl: image.url, whatsappNumber: kind === 'whatsapp' && whatsappNumber.trim() ? whatsappNumber.trim() : null,
          welcomeMessage: kind === 'whatsapp' && welcome.trim() ? welcome.trim() : null, publish,
        }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'generic');
      toast.success(publish ? t('publishedToast') : t('createdToast'));
      onOpenChange(false);
      onCreated();
    } catch (error) {
      toast.error(errorText(error instanceof Error ? error.message : null));
    } finally {
      setBusy(false);
    }
  };

  const steps = [t('steps.goal'), t('steps.audience'), t('steps.ad'), t('steps.review')];

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl" data-testid="create-ad-dialog">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{pageName ? t('descriptionPage', { page: pageName }) : t('description')}</DialogDescription>
        </DialogHeader>

        <ol className="flex flex-wrap gap-2 text-xs" aria-label={t('progress')}>
          {steps.map((label, i) => (
            <li key={label} aria-current={i === step ? 'step' : undefined}
              className={cn('rounded-full px-2.5 py-1 font-medium', i === step ? 'bg-primary text-primary-foreground' : i < step ? 'bg-primary/10 text-primary' : 'bg-muted text-muted-foreground')}>
              {i + 1}. {label}
            </li>
          ))}
        </ol>

        {step === 0 && (
          <div className="space-y-4">
            <div role="radiogroup" aria-label={t('goal')} className="grid gap-3 sm:grid-cols-2">
              {KINDS.map(({ kind: k, icon: Icon }) => (
                <button key={k} type="button" role="radio" aria-checked={kind === k} onClick={() => setKind(k)}
                  className={cn('flex items-start gap-3 rounded-xl border p-4 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                    kind === k ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/60')}>
                  <Icon className="mt-0.5 size-5 shrink-0 text-primary" />
                  <span>
                    <span className="block text-sm font-semibold text-foreground">{t(`kinds.${k}.title`)}</span>
                    <span className="mt-0.5 block text-xs text-muted-foreground">{t(`kinds.${k}.body`)}</span>
                  </span>
                </button>
              ))}
            </div>
            {accounts.length > 1 && (
              <div className="space-y-1">
                <Label htmlFor="create-ad-account">{t('adAccount')}</Label>
                <select id="create-ad-account" value={account} onChange={(e) => { setAccount(e.target.value); setImage(null); }}
                  className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm">
                  {accounts.map((a) => <option key={a.adAccountId} value={a.adAccountId}>{a.name ?? a.adAccountId}{a.currency ? ` · ${a.currency}` : ''}</option>)}
                </select>
              </div>
            )}
            {kind === 'instagram_direct' && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t('instagramNote')}</p>}
            {kind === 'whatsapp' && <p className="rounded-lg bg-muted px-3 py-2 text-xs text-muted-foreground">{t('whatsappNote')}</p>}
          </div>
        )}

        {step === 1 && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="create-ad-name">{t('name')}</Label>
              <Input id="create-ad-name" value={name} maxLength={200} onChange={(e) => setName(e.target.value)} placeholder={t('namePlaceholder')} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-ad-budget">{t('dailyBudget', { currency: currency ?? '' })}</Label>
              <Input id="create-ad-budget" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} placeholder="500" />
              {budget && budgetMinor === null && <p className="text-xs text-destructive">{t('budgetInvalid')}</p>}
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-ad-gender">{t('gender')}</Label>
              <select id="create-ad-gender" value={gender} onChange={(e) => setGender(e.target.value as 'all' | '1' | '2')} className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm">
                <option value="all">{t('genders.all')}</option>
                <option value="1">{t('genders.men')}</option>
                <option value="2">{t('genders.women')}</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-ad-start">{t('start')}</Label>
              <Input id="create-ad-start" type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-ad-end">{t('end')}</Label>
              <Input id="create-ad-end" type="datetime-local" value={end} min={start} onChange={(e) => setEnd(e.target.value)} />
              <p className="text-xs text-muted-foreground">{t('endHint')}</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-ad-age-min">{t('ageMin')}</Label>
              <Input id="create-ad-age-min" type="number" min={18} max={65} value={ageMin} onChange={(e) => setAgeMin(Math.min(65, Math.max(18, Number(e.target.value) || 18)))} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="create-ad-age-max">{t('ageMax')}</Label>
              <Input id="create-ad-age-max" type="number" min={18} max={65} value={ageMax} onChange={(e) => setAgeMax(Math.min(65, Math.max(18, Number(e.target.value) || 65)))} />
            </div>
            <div className="space-y-2 sm:col-span-2">
              <Label htmlFor="create-ad-country">{t('countries')}</Label>
              <div className="flex flex-wrap gap-1.5">
                {countries.map((c) => (
                  <button key={c} type="button" onClick={() => setCountries(countries.filter((x) => x !== c))}
                    aria-label={t('removeCountry', { country: c })}
                    className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary hover:bg-primary/20">{c} ×</button>
                ))}
              </div>
              <div className="flex gap-2">
                <Input id="create-ad-country" value={countryInput} maxLength={2} placeholder={t('countryPlaceholder')}
                  onChange={(e) => setCountryInput(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCountry(countryInput); } }} className="w-28" />
                <div className="flex flex-wrap gap-1">
                  {COMMON_COUNTRIES.filter((c) => !countries.includes(c)).slice(0, 8).map((c) => (
                    <button key={c} type="button" onClick={() => addCountry(c)} className="rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted">+ {c}</button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {step === 2 && (
          <div className="grid gap-4 sm:grid-cols-[1fr_14rem]">
            <div className="space-y-4">
              <div className="space-y-1">
                <Label htmlFor="create-ad-text">{t('primaryText')}</Label>
                <Textarea id="create-ad-text" value={primaryText} maxLength={2000} rows={4} onChange={(e) => setPrimaryText(e.target.value)} placeholder={t('primaryTextPlaceholder')} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="create-ad-headline">{t('headline')}</Label>
                <Input id="create-ad-headline" value={headline} maxLength={255} onChange={(e) => setHeadline(e.target.value)} />
              </div>
              {kind !== 'instagram_direct' && (
                <div className="space-y-1">
                  <Label htmlFor="create-ad-description">{t('descriptionField')}</Label>
                  <Input id="create-ad-description" value={description} maxLength={255} onChange={(e) => setDescription(e.target.value)} />
                </div>
              )}
              {kind === 'website' && (
                <div className="space-y-1">
                  <Label htmlFor="create-ad-link">{t('linkUrl')}</Label>
                  <Input id="create-ad-link" type="url" value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://" />
                </div>
              )}
              {kind === 'lead_form' && (
                <div className="space-y-1">
                  <Label htmlFor="create-ad-form">{t('leadForm')}</Label>
                  <select id="create-ad-form" value={leadFormId} onChange={(e) => setLeadFormId(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm">
                    <option value="">{forms === null ? t('loadingForms') : t('chooseForm')}</option>
                    {(forms ?? []).map((f) => <option key={f.id} value={f.id}>{f.name ?? f.id}</option>)}
                  </select>
                  {forms !== null && forms.length === 0 && <p className="text-xs text-muted-foreground">{t('noForms')}</p>}
                </div>
              )}
              {(kind === 'lead_form' || kind === 'website') && (
                <div className="space-y-1">
                  <Label htmlFor="create-ad-cta">{t('cta')}</Label>
                  <select id="create-ad-cta" value={cta || CTAS[kind][0]} onChange={(e) => setCta(e.target.value)} className="h-9 w-full rounded-lg border border-border bg-card px-2.5 text-sm">
                    {CTAS[kind].map((c) => <option key={c} value={c}>{t(`ctas.${c}`)}</option>)}
                  </select>
                </div>
              )}
              {kind === 'whatsapp' && (
                <>
                  <div className="space-y-1">
                    <Label htmlFor="create-ad-wa">{t('whatsappNumber')}</Label>
                    <Input id="create-ad-wa" value={whatsappNumber} onChange={(e) => setWhatsappNumber(e.target.value)} placeholder="+91 98765 43210" />
                    <p className="text-xs text-muted-foreground">{t('whatsappNumberHint')}</p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="create-ad-welcome">{t('welcome')}</Label>
                    <Input id="create-ad-welcome" value={welcome} maxLength={300} onChange={(e) => setWelcome(e.target.value)} placeholder={t('welcomePlaceholder')} />
                  </div>
                </>
              )}
            </div>
            <div className="space-y-2">
              <Label>{t('image')}</Label>
              <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading || !account}
                className="flex aspect-square w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-border bg-muted/40 text-muted-foreground hover:bg-muted"
                aria-label={image ? t('replaceImage') : t('uploadImage')}>
                {uploading ? <Loader2 className="size-6 animate-spin" />
                  // A local preview of the chosen file (blob: URL).
                  // eslint-disable-next-line @next/next/no-img-element
                  : image ? <img src={image.preview} alt={t('imageAlt')} className="size-full object-cover" />
                  : <span className="flex flex-col items-center gap-1 text-xs"><ImagePlus className="size-6" />{t('uploadImage')}</span>}
              </button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ''; }} />
              <p className="text-xs text-muted-foreground">{t('imageRules')}</p>
            </div>
          </div>
        )}

        {step === 3 && (
          <dl className="grid gap-x-6 gap-y-2 rounded-xl border border-border bg-card p-4 text-sm sm:grid-cols-2">
            {[
              [t('goal'), t(`kinds.${kind}.title`)],
              [t('adAccount'), accounts.find((a) => a.adAccountId === account)?.name ?? account],
              [t('name'), name],
              [t('dailyBudgetPlain'), `${budget} ${currency ?? ''}`],
              [t('schedule'), `${new Date(start).toLocaleString()}${end ? ` – ${new Date(end).toLocaleString()}` : ` · ${t('noEnd')}`}`],
              [t('audience'), `${countries.join(', ')} · ${ageMin}–${ageMax}${gender === 'all' ? '' : ` · ${t(gender === '1' ? 'genders.men' : 'genders.women')}`}`],
            ].map(([label, value]) => (
              <div key={label}>
                <dt className="text-xs text-muted-foreground">{label}</dt>
                <dd className="font-medium text-foreground">{value}</dd>
              </div>
            ))}
            <p className="text-xs text-muted-foreground sm:col-span-2">{t('reviewNote')}</p>
          </dl>
        )}

        <DialogFooter className="gap-2">
          {step > 0 && <Button type="button" variant="outline" onClick={() => setStep(step - 1)} disabled={busy}>{t('back')}</Button>}
          {step < 3 && <Button type="button" onClick={() => setStep(step + 1)} disabled={!stepValid[step]}>{t('next')}</Button>}
          {step === 3 && (
            <>
              <Button type="button" variant="outline" onClick={() => void submit(false)} disabled={busy}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} {t('createPaused')}
              </Button>
              <Button type="button" onClick={() => void submit(true)} disabled={busy}>
                {busy && <Loader2 className="size-3.5 animate-spin" />} {t('publish')}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
