'use client';

/**
 * Settings > Ads: connect a Meta ad account and Facebook Page through Facebook
 * Login for Business, see which permissions each feature still needs, choose
 * the WhatsApp number and switches for the Conversions API, and disconnect.
 *
 * While Meta ads are off or not configured on this deployment the card only
 * says so: the Facebook SDK is loaded only after an admin clicks Connect, and
 * only when the status route says the feature is enabled, so a disabled
 * deployment never contacts Facebook from the browser. Members see the
 * connection read-only. Tokens never reach the browser.
 */

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Loader2, Megaphone } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { MetaAdConnectionDto } from '@/lib/meta-ads/connection';
import { NumberSelect } from './numbers/number-select';
import { MetaAdAccounts } from './meta-ad-accounts';
import { useWhatsAppNumbers } from './numbers/use-whatsapp-numbers';

const SDK_SRC = 'https://connect.facebook.net/en_US/sdk.js';
const GRAPH_VERSION = 'v27.0';
const FEATURES = ['insights', 'leads', 'capi'] as const;
type Feature = (typeof FEATURES)[number];
const ERRORS = new Set([
  'meta_ads_not_enabled', 'not_connected', 'already_connected', 'page_in_use', 'token_invalid', 'invalid_choice',
  'revoke_failed', 'meta_error', 'rate_limited', 'missing_scope', 'invalid_number', 'invalid_request', 'forbidden',
]);

type Status =
  | { enabled: false; reason: string; connection: null; missingScopes: Record<Feature, string[]> }
  | { enabled: true; appId: string; loginConfigId: string; connection: MetaAdConnectionDto | null; missingScopes: Record<Feature, string[]> };

interface Choices {
  adAccounts: { id: string; name: string | null; currency: string | null }[];
  pages: { id: string; name: string | null }[];
}

type FbSdk = NonNullable<Window['FB']>;
let sdkPromise: Promise<FbSdk> | null = null;

/** Loads the Facebook JS SDK once, on demand. */
function loadSdk(appId: string): Promise<FbSdk> {
  if (sdkPromise) return sdkPromise;
  sdkPromise = new Promise<FbSdk>((resolve, reject) => {
    const ready = () => {
      if (!window.FB) return reject(new Error('sdk'));
      window.FB.init({ appId, autoLogAppEvents: false, xfbml: false, version: GRAPH_VERSION });
      resolve(window.FB);
    };
    if (window.FB) return ready();
    window.fbAsyncInit = ready;
    const script = document.createElement('script');
    script.src = SDK_SRC;
    script.async = true;
    script.defer = true;
    script.crossOrigin = 'anonymous';
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error('sdk'));
    };
    document.body.appendChild(script);
  });
  return sdkPromise;
}

const selectClass = 'border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm';

export function MetaAdsCard() {
  const t = useTranslations('Settings.metaAds');
  const { canEditSettings: canEdit } = useAuth();
  const { numbers } = useWhatsAppNumbers();
  const [status, setStatus] = useState<Status | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [adAccountId, setAdAccountId] = useState('');
  const [pageId, setPageId] = useState('');

  const errorText = useCallback(
    (code: unknown) => (typeof code === 'string' && ERRORS.has(code) ? t(`errors.${code}`) : t('errors.generic')),
    [t],
  );

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch('/api/meta-ads/status', { cache: 'no-store' });
      if (!res.ok) throw new Error();
      setStatus((await res.json()) as Status);
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connection = status?.enabled ? status.connection : null;
  const pending = connection?.status === 'pending';

  // A pending connection needs the ad account and Page choice.
  useEffect(() => {
    if (!pending || !canEdit || choices) return;
    let live = true;
    void (async () => {
      const res = await authFetch('/api/meta-ads/connect/choices', { cache: 'no-store' });
      const json = await res.json().catch(() => ({}));
      if (!live) return;
      if (!res.ok) {
        toast.error(errorText(json.error));
        setChoices({ adAccounts: [], pages: [] });
        return;
      }
      setChoices(json as Choices);
    })();
    return () => {
      live = false;
    };
  }, [pending, canEdit, choices, errorText]);

  const call = async (url: string, init: RequestInit): Promise<Record<string, unknown> | null> => {
    setBusy(true);
    try {
      const res = await authFetch(url, init);
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        toast.error(res.status === 429 && !json.error ? t('errors.rate_limited') : errorText(json.error));
        return null;
      }
      return json;
    } catch {
      toast.error(t('errors.generic'));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!status?.enabled) return;
    setBusy(true);
    let accessToken: string | null = null;
    try {
      const fb = await loadSdk(status.appId);
      // The popup's user token, not a code: a JavaScript SDK login code cannot be
      // exchanged server side (Meta ties it to an internal redirect address).
      accessToken = await new Promise<string | null>((resolve) => {
        fb.login((response) => resolve(response.authResponse?.accessToken ?? null), {
          config_id: status.loginConfigId,
        });
      });
    } catch {
      setBusy(false);
      toast.error(t('sdkFailed'));
      return;
    }
    setBusy(false);
    if (!accessToken) {
      toast.error(t('loginCancelled'));
      return;
    }
    const json = await call('/api/meta-ads/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ accessToken }),
    });
    if (json) {
      setChoices(null);
      await load();
    }
  };

  const finish = async () => {
    const json = await call('/api/meta-ads/connection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ adAccountId, pageId }),
    });
    if (json) {
      toast.success(t('statusActive'));
      setChoices(null);
      await load();
    }
  };

  const saveCapi = async (patch: Record<string, unknown>) => {
    const json = await call('/api/meta-ads/connection', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    });
    if (json) {
      toast.success(t('capi.saved'));
      await load();
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t('disconnectConfirm'))) return;
    const json = await call('/api/meta-ads/connection', { method: 'DELETE' });
    if (json) {
      toast.success(t('disconnected'));
      setChoices(null);
      setAdAccountId('');
      setPageId('');
      await load();
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Megaphone className="size-4" /> {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!status && !loadFailed && <Loader2 className="size-4 animate-spin text-primary" />}
        {loadFailed && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            {t('loadFailed')}
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t('retry')}</Button>
          </div>
        )}
        {status && !status.enabled && <p className="text-sm text-muted-foreground">{t('notConfigured')}</p>}
        {status?.enabled && !connection && (
          <div className="space-y-2">
            <Badge variant="outline">{t('statusNotConnected')}</Badge>
            {canEdit ? (
              <div>
                <Button type="button" onClick={() => void connect()} disabled={busy}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} {busy ? t('connecting') : t('connect')}
                </Button>
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t('adminOnly')}</p>
            )}
          </div>
        )}

        {status?.enabled && connection && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {connection.status === 'active' && <Badge variant="secondary">{t('statusActive')}</Badge>}
              {connection.status === 'pending' && <Badge variant="outline">{t('statusPending')}</Badge>}
              {connection.status === 'token_invalid' && <Badge variant="destructive">{t('statusTokenInvalid')}</Badge>}
              {connection.adAccountName && (
                <span className="text-foreground">{t('adAccount')}: <span className="font-medium">{connection.adAccountName}</span></span>
              )}
              {connection.pageName && (
                <span className="text-foreground">{t('page')}: <span className="font-medium">{connection.pageName}</span></span>
              )}
              {canEdit && (
                <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void disconnect()} disabled={busy}>
                  {t('disconnect')}
                </Button>
              )}
            </div>

            {pending && canEdit && (
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
                {!choices ? (
                  <Loader2 className="size-4 animate-spin text-primary" />
                ) : (
                  <>
                    <div className="space-y-1">
                      <Label htmlFor="meta-ad-account">{t('adAccount')}</Label>
                      <select id="meta-ad-account" className={selectClass} value={adAccountId} onChange={(e) => setAdAccountId(e.target.value)}>
                        <option value="">{t('chooseAdAccount')}</option>
                        {choices.adAccounts.map((a) => (
                          <option key={a.id} value={a.id}>{a.name ? `${a.name} (${a.id})` : a.id}</option>
                        ))}
                      </select>
                    </div>
                    <div className="space-y-1">
                      <Label htmlFor="meta-page">{t('page')}</Label>
                      <select id="meta-page" className={selectClass} value={pageId} onChange={(e) => setPageId(e.target.value)}>
                        <option value="">{t('choosePage')}</option>
                        {choices.pages.map((p) => (
                          <option key={p.id} value={p.id}>{p.name ? `${p.name} (${p.id})` : p.id}</option>
                        ))}
                      </select>
                    </div>
                    <Button type="button" onClick={() => void finish()} disabled={busy || !adAccountId || !pageId}>
                      {busy && <Loader2 className="size-3.5 animate-spin" />} {t('finish')}
                    </Button>
                  </>
                )}
              </div>
            )}

            {connection.status !== 'pending' && FEATURES.some((f) => status.missingScopes[f].length > 0) && (
              <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
                {FEATURES.filter((f) => status.missingScopes[f].length > 0).map((f) => (
                  <li key={f} className="flex items-start gap-1.5">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    {t('missingScopes', { feature: t(`features.${f}`), scopes: status.missingScopes[f].join(', ') })}
                  </li>
                ))}
              </ul>
            )}
            {connection.status === 'active' && status.missingScopes.leads.length === 0 && !connection.pageSubscribedAt && (
              <p className="text-xs text-muted-foreground">{t('leadsNotSubscribed')}</p>
            )}
            {connection.lastErrorCode && (
              <p className="text-xs text-muted-foreground">{t('lastError', { code: connection.lastErrorCode })}</p>
            )}

            {(connection.status === 'active' || connection.status === 'token_invalid') && <MetaAdAccounts canEdit={canEdit && connection.status === 'active'} />}

            {connection.status === 'active' && (
              <CapiSettings key={connection.capiWhatsappConfigId ?? ''} connection={connection} canEdit={canEdit} busy={busy} numbers={numbers} onSave={saveCapi} />
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function CapiSettings({
  connection,
  canEdit,
  busy,
  numbers,
  onSave,
}: {
  connection: MetaAdConnectionDto;
  canEdit: boolean;
  busy: boolean;
  numbers: ReturnType<typeof useWhatsAppNumbers>['numbers'];
  onSave: (patch: Record<string, unknown>) => Promise<void>;
}) {
  const t = useTranslations('Settings.metaAds.capi');
  // Keyed on the saved number by the parent, so a save resets this draft.
  const [numberId, setNumberId] = useState<string | null>(connection.capiWhatsappConfigId);
  const disabled = !canEdit || busy;

  return (
    <div className="space-y-3 border-t border-border pt-4">
      <div>
        <h3 className="text-foreground text-sm font-semibold">{t('title')}</h3>
        <p className="text-muted-foreground text-xs">{t('help')}</p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="meta-capi-number">{t('number')}</Label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <NumberSelect id="meta-capi-number" numbers={numbers} value={numberId} onChange={setNumberId}
            emptyLabel={t('chooseNumber')} disabled={disabled} />
          {canEdit && numberId !== connection.capiWhatsappConfigId && (
            <Button type="button" size="sm" variant="outline" disabled={disabled}
              onClick={() => void onSave({ capiWhatsappConfigId: numberId })}>
              {t('saveNumber')}
            </Button>
          )}
        </div>
        <p className="text-muted-foreground text-xs">{t('numberHelp')}</p>
        {connection.capiDatasetId && <p className="text-muted-foreground text-xs">{t('dataset', { id: connection.capiDatasetId })}</p>}
      </div>
      <label className="flex items-start gap-3 text-sm">
        <Switch checked={connection.capiEnabled} disabled={disabled || (!connection.capiEnabled && !connection.capiWhatsappConfigId)}
          onCheckedChange={(v: boolean) => void onSave({ capiEnabled: v })} />
        <span className="text-foreground font-medium">{t('enable')}</span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <Switch checked={connection.capiAutoPurchase} disabled={disabled}
          onCheckedChange={(v: boolean) => void onSave({ capiAutoPurchase: v })} />
        <span className="text-foreground">{t('autoPurchase')}</span>
      </label>
      <label className="flex items-start gap-3 text-sm">
        <Switch checked={connection.capiAutoLead} disabled={disabled}
          onCheckedChange={(v: boolean) => void onSave({ capiAutoLead: v })} />
        <span className="text-foreground">{t('autoLead')}</span>
      </label>
    </div>
  );
}
