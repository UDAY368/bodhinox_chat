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
import { AlertTriangle, Loader2, Megaphone, Unplug } from 'lucide-react';
import { toast } from 'sonner';
import { useTranslations } from 'next-intl';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { GroupedListRow } from '@/components/ui/grouped-list';
import { InlineError } from '@/components/ui/inline-error';
import { PageLoading } from '@/components/ui/page-loading';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { useAuth } from '@/hooks/use-auth';
import { authFetch } from '@/lib/auth/client';
import type { MetaAdConnectionDto } from '@/lib/meta-ads/connection';
import { NumberSelect } from './numbers/number-select';
import { MetaAdAccounts } from './meta-ad-accounts';
import { useWhatsAppNumbers } from './numbers/use-whatsapp-numbers';
import { SettingsBlock, SettingsGroup, SettingsRow, SettingsSwitchRow } from './settings-row';

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

const nameWithId = (x: { id: string; name?: string | null }) => (x.name ? `${x.name} (${x.id})` : x.id);

export function MetaAdsCard() {
  const t = useTranslations('Settings.metaAds');
  const confirm = useConfirm();
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
    if (!(await confirm({ title: t('disconnectConfirm'), confirmLabel: t('disconnect'), destructive: true }))) return;
    const json = await call('/api/meta-ads/connection', { method: 'DELETE' });
    if (json) {
      toast.success(t('disconnected'));
      setChoices(null);
      setAdAccountId('');
      setPageId('');
      await load();
    }
  };

  const missing = connection && connection.status !== 'pending' ? FEATURES.filter((f) => (status?.missingScopes[f].length ?? 0) > 0) : [];
  const leadsNote = !!connection && connection.status === 'active' && status?.missingScopes.leads.length === 0 && !connection.pageSubscribedAt;
  const notes = status?.enabled && connection ? (
    <>
      {missing.length > 0 && (
        <ul className="space-y-1 text-xs text-amber-700 dark:text-amber-400">
          {missing.map((f) => (
            <li key={f} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {t('missingScopes', { feature: t(`features.${f}`), scopes: status.missingScopes[f].join(', ') })}
            </li>
          ))}
        </ul>
      )}
      {leadsNote && (
        <p className="text-xs text-muted-foreground">{t('leadsNotSubscribed')}</p>
      )}
      {connection.lastErrorCode && (
        <p className="text-xs text-muted-foreground">{t('lastError', { code: connection.lastErrorCode })}</p>
      )}
    </>
  ) : null;
  const hasNotes = missing.length > 0 || leadsNote || !!connection?.lastErrorCode;

  const primary = !status?.enabled || !canEdit ? undefined
    : !connection ? (
      <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void connect()} disabled={busy}>
        {busy && <Loader2 className="size-3.5 animate-spin" />} {busy ? t('connecting') : t('connect')}
      </Button>
    ) : pending && choices ? (
      <Button type="button" size="sm" className="min-h-11 sm:min-h-8" onClick={() => void finish()} disabled={busy || !adAccountId || !pageId}>
        {busy && <Loader2 className="size-3.5 animate-spin" />} {t('finish')}
      </Button>
    ) : undefined;

  return (
    <div className="space-y-6">
      <SettingsGroup
        title={<><Megaphone className="size-4" /> {t('title')}</>}
        footer={status?.enabled && !connection && !canEdit ? <>{t('description')} {t('adminOnly')}</> : t('description')}
        action={primary}
        more={[{ label: t('disconnect'), icon: Unplug, destructive: true, disabled: busy, hidden: !canEdit || !status?.enabled || !connection, onSelect: () => void disconnect() }]}
      >
        {!status && !loadFailed && <SettingsBlock><PageLoading rows={2} /></SettingsBlock>}
        {loadFailed && <SettingsBlock><InlineError message={t('loadFailed')} onRetry={() => void load()} /></SettingsBlock>}
        {status && !status.enabled && <SettingsBlock><p className="text-sm text-muted-foreground">{t('notConfigured')}</p></SettingsBlock>}
        {status?.enabled && !connection && (
          <GroupedListRow title={t('title')} trailing={<Badge variant="outline">{t('statusNotConnected')}</Badge>} />
        )}

        {status?.enabled && connection && (
          <>
            <GroupedListRow
              title={connection.adAccountName ? <>{t('adAccount')}: <span className="font-medium">{connection.adAccountName}</span></> : t('title')}
              subtitle={connection.pageName ? <>{t('page')}: {connection.pageName}</> : undefined}
              trailing={
                connection.status === 'active' ? <Badge variant="secondary">{t('statusActive')}</Badge>
                : connection.status === 'pending' ? <Badge variant="outline">{t('statusPending')}</Badge>
                : connection.status === 'token_invalid' ? <Badge variant="destructive">{t('statusTokenInvalid')}</Badge>
                : undefined
              }
              className="[&_.truncate]:whitespace-normal"
            />

            {pending && canEdit && (!choices ? (
              <SettingsBlock><PageLoading rows={2} /></SettingsBlock>
            ) : (
              <>
                <SettingsRow label={t('adAccount')} htmlFor="meta-ad-account">
                  <Select value={adAccountId || null} onValueChange={(v) => setAdAccountId(v ? String(v) : '')}>
                    <SelectTrigger id="meta-ad-account" className="min-h-11 w-full bg-card sm:min-h-9">
                      <SelectValue placeholder={t('chooseAdAccount')}>{(v: string | null) => {
                        const a = choices.adAccounts.find((x) => x.id === v);
                        return a ? nameWithId(a) : t('chooseAdAccount');
                      }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {choices.adAccounts.map((a) => (
                        <SelectItem key={a.id} value={a.id}>{nameWithId(a)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
                <SettingsRow label={t('page')} htmlFor="meta-page">
                  <Select value={pageId || null} onValueChange={(v) => setPageId(v ? String(v) : '')}>
                    <SelectTrigger id="meta-page" className="min-h-11 w-full bg-card sm:min-h-9">
                      <SelectValue placeholder={t('choosePage')}>{(v: string | null) => {
                        const p = choices.pages.find((x) => x.id === v);
                        return p ? nameWithId(p) : t('choosePage');
                      }}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {choices.pages.map((p) => (
                        <SelectItem key={p.id} value={p.id}>{nameWithId(p)}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SettingsRow>
              </>
            ))}

            {/* Permission gaps and the last error: an explanatory note, not a form. */}
            {hasNotes && <SettingsBlock className="space-y-1">{notes}</SettingsBlock>}

            {(connection.status === 'active' || connection.status === 'token_invalid') && (
              // The ad accounts list lays out its own rows.
              <SettingsBlock><MetaAdAccounts canEdit={canEdit && connection.status === 'active'} /></SettingsBlock>
            )}
          </>
        )}
      </SettingsGroup>

      {status?.enabled && connection?.status === 'active' && (
        <CapiSettings key={connection.capiWhatsappConfigId ?? ''} connection={connection} canEdit={canEdit} busy={busy} numbers={numbers} onSave={saveCapi} />
      )}
    </div>
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
    <SettingsGroup
      title={t('title')}
      footer={t('help')}
      action={canEdit && numberId !== connection.capiWhatsappConfigId ? (
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" disabled={disabled}
          onClick={() => void onSave({ capiWhatsappConfigId: numberId })}>
          {t('saveNumber')}
        </Button>
      ) : undefined}
    >
      <SettingsRow
        label={t('number')}
        htmlFor="meta-capi-number"
        hint={<>{t('numberHelp')}{connection.capiDatasetId && <span className="mt-0.5 block">{t('dataset', { id: connection.capiDatasetId })}</span>}</>}
      >
        <NumberSelect id="meta-capi-number" numbers={numbers} value={numberId} onChange={setNumberId}
          emptyLabel={t('chooseNumber')} disabled={disabled} />
      </SettingsRow>
      <SettingsSwitchRow
        title={t('enable')}
        control={<Switch checked={connection.capiEnabled} disabled={disabled || (!connection.capiEnabled && !connection.capiWhatsappConfigId)}
          onCheckedChange={(v: boolean) => void onSave({ capiEnabled: v })} aria-label={t('enable')} />}
      />
      <SettingsSwitchRow
        title={t('autoPurchase')}
        control={<Switch checked={connection.capiAutoPurchase} disabled={disabled}
          onCheckedChange={(v: boolean) => void onSave({ capiAutoPurchase: v })} aria-label={t('autoPurchase')} />}
      />
      <SettingsSwitchRow
        title={t('autoLead')}
        control={<Switch checked={connection.capiAutoLead} disabled={disabled}
          onCheckedChange={(v: boolean) => void onSave({ capiAutoLead: v })} aria-label={t('autoLead')} />}
      />
      <SettingsSwitchRow
        title={t('dealEvents')}
        control={<Switch checked={connection.capiDealEvents} disabled={disabled}
          onCheckedChange={(v: boolean) => void onSave({ capiDealEvents: v })} aria-label={t('dealEvents')} />}
      />
    </SettingsGroup>
  );
}
