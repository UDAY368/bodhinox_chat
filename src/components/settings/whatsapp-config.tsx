'use client';
import { authFetch } from '@/lib/auth/client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  RotateCcw,
  Store,
} from 'lucide-react';
import { createClient } from '@/lib/data/client';
import { useAuth } from '@/hooks/use-auth';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@/components/ui/card';
import { IceBreakersCard } from './ice-breakers-card';
import { FormsEncryptionCard } from './forms-encryption-card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Switch } from '@/components/ui/switch';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';
import { NumbersList } from './numbers/numbers-list';
import { EmbeddedSignupButton } from './numbers/embedded-signup-button';
import { BusinessProfileDialog } from './numbers/business-profile-dialog';
import { GreenTickChecklist } from './numbers/green-tick-checklist';
import { numberLabel, useWhatsAppNumbers } from './numbers/use-whatsapp-numbers';

const MASKED_TOKEN = '••••••••••••••••';

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
// 'number_disconnected': an admin disconnected this number; it needs reconnecting, not fixing.
type ResetReason = 'token_corrupted' | 'meta_api_error' | 'number_disconnected' | null;

// Meta ids are decimal digit strings — mirrors the server-side check in
// POST /api/whatsapp/config so the obvious paste mistakes get a named
// field before a round-trip.
const META_ID_RE = /^\d+$/;

// `meta` object the config route attaches to every failed Meta call
// (issue #505): what a user quotes to Meta support.
type MetaErrorMeta = {
  code: number | null;
  subcode: number | null;
  fbtrace_id: string | null;
  step: string;
  field?: string | null;
  message?: string | null;
};
type MetaFailure = { message: string; meta: MetaErrorMeta | null };
type WabaSubscription = {
  checked: boolean;
  subscribed: boolean | null;
  app_id_match: boolean | null;
  error?: string;
};

/** What a failed health check (GET /api/whatsapp/config) asks the user to do. */
function healthResetReason(payload: { needs_reset?: boolean; reason?: string }): ResetReason {
  if (payload.needs_reset) return 'token_corrupted';
  if (payload.reason === 'disconnected') return 'number_disconnected';
  if (payload.reason === 'meta_api_error') return 'meta_api_error';
  return null;
}

export function WhatsAppConfig() {
  const t = useTranslations('Settings.whatsapp');
  const tn = useTranslations('whatsappNumbers');
  const db = createClient();
  // A workspace can connect several numbers (whatsapp_config rows keyed by
  // account_id). The list at the top picks which one the form below edits;
  // "Add number manually" empties the form to connect another one. Every
  // read is keyed off `accountId` so all members see the same numbers.
  const {
    user,
    accountId,
    loading: authLoading,
    profileLoading,
    canEditSettings,
  } = useAuth();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [config, setConfig] = useState<WhatsAppConfigType | null>(null);
  const { numbers, reload: reloadNumbers } = useWhatsAppNumbers();
  const selectedNumber = config ? numbers.find((n) => n.id === config.id) ?? null : null;
  // True while the form is connecting an additional number.
  const [adding, setAdding] = useState(false);
  // The business profile dialog of the number the form is showing.
  const [profileOpen, setProfileOpen] = useState(false);
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState<string>('');
  // Structured details of the last failed Meta call (health check or
  // save) — rendered as small muted text under the actionable message.
  const [statusMeta, setStatusMeta] = useState<MetaErrorMeta | null>(null);
  const [saveFailure, setSaveFailure] = useState<MetaFailure | null>(null);
  const [wabaSubscription, setWabaSubscription] =
    useState<WabaSubscription | null>(null);
  // Guards against re-hydrating the form when the load effect below
  // re-runs for reasons unrelated to actually switching accounts —
  // e.g. Supabase's onAuthStateChange fires a token refresh (new
  // `user` object, profileLoading flips true/false) when the browser
  // tab regains focus. Without this, that churn calls fetchConfig()
  // again and overwrites whatever the user typed but hadn't saved yet.
  const loadedAccountIdRef = useRef<string | null>(null);

  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(false);
  const [verifyEdited, setVerifyEdited] = useState(false);

  // Inbound-media mirror (issue #466). Unlike everything else on this
  // page it is NOT part of handleSave: that path insists on re-entering
  // the access token so it can re-verify with Meta, which is a silly
  // toll to pay for flipping a boolean. The switch writes straight to
  // the row instead — RLS (migration 017) restricts whatsapp_config
  // UPDATE to admins, hence the canEditSettings gate below; without it
  // a viewer's toggle would match zero rows and appear to work.
  const [mirrorMedia, setMirrorMedia] = useState(true);
  const [savingMirror, setSavingMirror] = useState(false);

  // True once /register has succeeded on Meta's side (timestamp set
  // in the row). When false, the saved config is metadata-only and
  // Meta will silently drop every inbound event — that's the
  // multi-number bug that prompted this work.
  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  type RegistrationProbe = {
    live: boolean;
    checks: Record<string, boolean | null>;
    errors?: string[];
    last_registration_error?: string | null;
    registered_at?: string | null;
    subscribed_apps_at?: string | null;
  };
  const [registrationProbe, setRegistrationProbe] =
    useState<RegistrationProbe | null>(null);

  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  const fetchConfig = useCallback(
    async (acctId: string, wantedId: string | null) => {
      setLoading(true);
      setAdding(false);
      try {
        // Load the workspace's numbers (token columns never reach the
        // browser) and edit the requested one, else the default, else the
        // oldest.
        const { data: rows, error } = await db
          .from('whatsapp_config')
          .select('*')
          .eq('account_id', acctId)
          .order('is_default', { ascending: false })
          .order('created_at', { ascending: true });

        if (error) {
          console.error('Failed to load config row:', error.code ?? 'unknown');
        }
        const list = (rows ?? []) as WhatsAppConfigType[];
        const data = list.find((row) => row.id === wantedId) ?? list[0] ?? null;

        if (data) {
          setConfig(data);
          setPhoneNumberId(data.phone_number_id || '');
          setWabaId(data.waba_id || '');
          setAccessToken(MASKED_TOKEN);
          // Same treatment as the access token: the row carries the encrypted
          // value, which is enough to know one exists. Show a mask instead of
          // an empty box so nobody concludes the token was never saved.
          setVerifyToken(data.verify_token ? MASKED_TOKEN : '');
          setVerifyEdited(false);
          setPin('');
          setTokenEdited(false);
          // Undefined on a row read before migration 039 — treat that as
          // on, matching the webhook's own default.
          setMirrorMedia(data.mirror_inbound_media !== false);
        } else {
          setConfig(null);
          setPhoneNumberId('');
          setWabaId('');
          setAccessToken('');
          setVerifyToken('');
          setPin('');
          setTokenEdited(false);
          setVerifyEdited(false);
          setMirrorMedia(true);
        }
        // Clear any stale probe result when reloading the row.
        setRegistrationProbe(null);

        // Then verify health via the API (decrypts token + pings Meta)
        if (data) {
          try {
            const res = await authFetch(
              `/api/whatsapp/config?id=${encodeURIComponent(data.id)}`,
              { method: 'GET' }
            );
            const payload = await res.json();

            if (payload.connected) {
              setConnectionStatus('connected');
              setResetReason(null);
              setStatusMessage('');
              setStatusMeta(null);
              setWabaSubscription(payload.waba_subscription ?? null);
            } else {
              setConnectionStatus('disconnected');
              setResetReason(healthResetReason(payload));
              setStatusMessage(payload.reason === 'disconnected' ? '' : payload.message || '');
              setStatusMeta(payload.meta ?? null);
              setWabaSubscription(null);
            }
          } catch (err) {
            console.error('Health check failed:', err);
            setConnectionStatus('disconnected');
          }
        } else {
          setConnectionStatus('disconnected');
          setResetReason(null);
          setStatusMessage('');
          setStatusMeta(null);
          setWabaSubscription(null);
        }
      } catch (err) {
        console.error('fetchConfig error:', err);
        toast.error(t('loadFailed'));
      } finally {
        setLoading(false);
      }
    },
    [db, t]
  );

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user?.id || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfig(accountId, null);
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfig]);

  // Empty the form to connect another number; the list stays as it is.
  function startAdding() {
    setAdding(true);
    setConfig(null);
    setPhoneNumberId('');
    setWabaId('');
    setAccessToken('');
    setVerifyToken('');
    setPin('');
    setTokenEdited(false);
    setVerifyEdited(false);
    setShowToken(false);
    setConnectionStatus('unknown');
    setResetReason(null);
    setStatusMessage('');
    setStatusMeta(null);
    setSaveFailure(null);
    setWabaSubscription(null);
    setRegistrationProbe(null);
  }

  async function handleNumbersChanged(change: { removedId?: string }) {
    await reloadNumbers();
    if (accountId && change.removedId && change.removedId === config?.id) {
      await fetchConfig(accountId, null);
    }
  }

  async function handleToggleMirrorMedia(next: boolean) {
    if (!config || !accountId || savingMirror) return;
    // Optimistic — the switch should feel instant; a failure rolls it
    // back rather than leaving the UI ahead of the row.
    const previous = mirrorMedia;
    setMirrorMedia(next);
    setSavingMirror(true);
    try {
      const { error } = await db.rpc('set_media_retention', {
        p_enabled: next,
      });
      if (error) throw new Error(error.message);
      setConfig({ ...config, mirror_inbound_media: next });
    } catch (error) {
      console.error('Failed to update media retention setting:', error);
      setMirrorMedia(previous);
      toast.error(t('mirrorInboundSaveFailed'));
    } finally {
      setSavingMirror(false);
    }
  }

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error(t('phoneNumberIdRequired'));
      return;
    }
    if (!META_ID_RE.test(phoneNumberId.trim())) {
      toast.error(t('phoneNumberIdNotNumeric'));
      return;
    }
    if (wabaId.trim() && !META_ID_RE.test(wabaId.trim())) {
      toast.error(t('wabaIdNotNumeric'));
      return;
    }
    if (!config && (!accessToken.trim() || !tokenEdited)) {
      toast.error(t('accessTokenRequired'));
      return;
    }

    try {
      setSaving(true);

      // Always POST through the API — it verifies with Meta and encrypts
      // the access_token server-side with ENCRYPTION_KEY. Skipping this
      // and writing direct to Supabase stores the token in plaintext,
      // which then fails decryption on every subsequent health check.
      const payload: Record<string, unknown> = {
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        // Only sent when the user actually typed one. Left out otherwise
        // (undefined is dropped from the JSON body) so the server keeps the
        // stored token instead of nulling it — see resolveVerifyTokenForSave.
        ...(verifyEdited &&
        verifyToken.trim() &&
        verifyToken.trim() !== MASKED_TOKEN
          ? { verify_token: verifyToken.trim() }
          : {}),
        // Optional — only sent when the user filled it in. The server
        // requires it on first save or when changing numbers; for a
        // simple token rotation, leaving it blank skips re-register.
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (config) {
        // Existing config — reuse stored encrypted token by decrypting on the
        // server. But our POST handler requires an access_token to verify
        // with Meta. If the user didn't change the token, we need to signal
        // that. Simplest: require token re-entry if they're updating.
        toast.error(t('reenterAccessToken'));
        setSaving(false);
        return;
      }

      const res = await authFetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        // The route names the failing step and which field to check
        // (issue #505). Keep the details on screen — a toast is too
        // short-lived to copy a trace id out of.
        setSaveFailure({
          message: data.error || t('saveFailed'),
          meta: data.meta ?? null,
        });
        toast.error(data.error || t('saveFailed'), { duration: 10000 });
        setSaving(false);
        return;
      }
      setSaveFailure(null);

      // The route now returns a structured outcome:
      //   * registered=true   → number is live, events will flow
      //   * registered=false  → credentials saved but /register
      //                         failed; UI shows the specific error
      //                         and a retry path. registration_error
      //                         is human-readable from Meta.
      if (data.registered === false && data.registration_error) {
        setSaveFailure({
          message: t('savedButRegistrationFailed', {
            error: data.registration_error,
          }),
          meta: data.meta ?? null,
        });
        toast.error(
          t('savedButRegistrationFailed', { error: data.registration_error }),
          { duration: 12000 }
        );
      } else if (data.registration_skipped) {
        // Credentials saved + verified, but /register was skipped
        // because no PIN was supplied (e.g. a Meta test number).
        // Don't claim the number is "Live" — point at the
        // Registration status banner instead.
        toast.success(t('savedRegistrationSkipped'), { duration: 10000 });
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? t('liveWithName', { name: data.phone_info.verified_name })
            : t('connectedGeneric')
        );
        // Clear the PIN so subsequent saves don't accidentally
        // re-register (which would void the active subscription if
        // the PIN became stale).
        setPin('');
      }

      await reloadNumbers();
      if (accountId) await fetchConfig(accountId, data.number_id ?? config?.id ?? null);
    } catch (err) {
      console.error('Save error:', err);
      toast.error(t('saveFailed'));
    } finally {
      setSaving(false);
    }
  }

  async function handleTestConnection() {
    try {
      setTesting(true);
      const res = await authFetch(
        `/api/whatsapp/config${config ? `?id=${encodeURIComponent(config.id)}` : ''}`,
        { method: 'GET' }
      );
      const payload = await res.json();

      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        setStatusMeta(null);
        setWabaSubscription(payload.waba_subscription ?? null);
        toast.success(
          payload.phone_info?.verified_name
            ? t('connectedTo', { name: payload.phone_info.verified_name })
            : t('apiConnectionOk')
        );
      } else {
        setConnectionStatus('disconnected');
        setResetReason(healthResetReason(payload));
        setStatusMeta(payload.meta ?? null);
        setWabaSubscription(null);
        if (payload.reason === 'disconnected') {
          // Not a failure: an admin disconnected it. Say how to bring it back.
          setStatusMessage('');
          toast.info(t('numberDisconnectedHint'), { duration: 10000 });
        } else {
          setStatusMessage(payload.message || '');
          toast.error(payload.message || t('apiConnectionFailed'), {
            duration: 10000,
          });
        }
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      toast.error(t('connectionTestFailed'));
    } finally {
      setTesting(false);
    }
  }

  async function handleVerifyRegistration() {
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await authFetch(
        `/api/whatsapp/config/verify-registration${config ? `?id=${encodeURIComponent(config.id)}` : ''}`,
        { method: 'GET' }
      );
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success(t('fullyWired'));
      } else {
        toast.error(t('notFullyRegistered'), { duration: 8000 });
      }
      if (accountId) await fetchConfig(accountId, config?.id ?? null);
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error(t('verifyEndpointUnreachable'));
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleReset() {
    if (!config) return;
    // The same soft disconnect as the numbers list, so the same warning:
    // the token is removed, campaigns are held and live flows go to draft.
    if (
      !confirm(
        tn('settings.disconnectConfirmHold', {
          name: numberLabel(selectedNumber ?? { display_name: null, phone_number_id: config.phone_number_id }, tn),
          isDefault: String(selectedNumber?.is_default ?? false),
        })
      )
    ) {
      return;
    }

    try {
      setResetting(true);
      const res = await authFetch(
        `/api/whatsapp/config?id=${encodeURIComponent(config.id)}`,
        { method: 'DELETE' }
      );
      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || t('resetFailed'));
        return;
      }

      // The server says what changed: new default, flows drafted, campaigns held.
      if (typeof data.message === 'string' && data.message) {
        toast.success(data.message, { duration: 10_000 });
      } else {
        toast.success(t('resetDone'));
      }
      await reloadNumbers();
      if (accountId) {
        await fetchConfig(accountId, null);
        return;
      }
      setConfig(null);
      setPhoneNumberId('');
      setWabaId('');
      setAccessToken('');
      setVerifyToken('');
      setTokenEdited(false);
      setVerifyEdited(false);
      setConnectionStatus('disconnected');
      setResetReason(null);
      setStatusMessage('');
      setStatusMeta(null);
      setSaveFailure(null);
      setWabaSubscription(null);
    } catch (err) {
      console.error('Reset error:', err);
      toast.error(t('resetFailed'));
    } finally {
      setResetting(false);
    }
  }

  function handleCopyWebhookUrl() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success(t('webhookCopied'));
  }

  if (loading) {
    return (
      <section className="animate-in fade-in-50 duration-200">
        <SettingsPanelHead title={t('title')} description={t('description')} />
        <div className="flex items-center justify-center py-12">
          <Loader2 className="text-primary size-6 animate-spin" />
        </div>
      </section>
    );
  }

  const showResetBanner = resetReason === 'token_corrupted';
  // An admin disconnected this number: a reconnect hint, not an error.
  const numberDisconnected = resetReason === 'number_disconnected' || Boolean(selectedNumber?.removed);

  // Step + code + trace id in small muted text, so a user can quote
  // them to Meta support (issue #505). The step names are wire values
  // from the route, shown verbatim.
  const renderMetaDetails = (meta: MetaErrorMeta) => (
    <div className="text-muted-foreground mt-2 space-y-0.5 text-[11px] leading-relaxed break-all">
      <p>
        {t('metaErrorStep')}: <code>{meta.step}</code>
        {meta.code !== null && meta.code !== undefined && (
          <>
            {' · '}
            {t('metaErrorCode')}:{' '}
            <code>
              {meta.code}
              {meta.subcode !== null && meta.subcode !== undefined
                ? `/${meta.subcode}`
                : ''}
            </code>
          </>
        )}
        {meta.fbtrace_id && (
          <>
            {' · '}
            {t('metaErrorTrace')}: <code>{meta.fbtrace_id}</code>
          </>
        )}
      </p>
      {meta.message && (
        <p>
          {t('metaErrorMessage')}: {meta.message}
        </p>
      )}
      <p>{t('metaErrorDetailsHint')}</p>
    </div>
  );

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead title={t('title')} description={t('description')} />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        {/* Main config form */}
        <div className="space-y-6">
          {canEditSettings && <div className="flex justify-end"><EmbeddedSignupButton canEdit onConnected={() => void reloadNumbers()} /></div>}
          {/* Every connected number; picks which one the form below edits. */}
          {(numbers.length > 0 || adding) && (
            <NumbersList
              numbers={numbers}
              selectedId={config?.id ?? null}
              adding={adding}
              canEdit={canEditSettings}
              onSelect={(id) => {
                if (accountId) void fetchConfig(accountId, id);
              }}
              onAdd={startAdding}
              onChanged={handleNumbersChanged}
            />
          )}

          {/* Corrupted-token reset banner */}
          {showResetBanner && (
            <Alert className="border-amber-500/30 bg-amber-500/10">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-500" />
                <div className="flex-1">
                  <AlertTitle className="mb-1 text-amber-800 dark:text-amber-200">
                    {t('tokenCorrupted')}
                  </AlertTitle>
                  <AlertDescription className="text-sm text-amber-800/90 dark:text-amber-100/80">
                    {statusMessage}
                  </AlertDescription>
                  <Button
                    onClick={handleReset}
                    disabled={resetting}
                    size="sm"
                    className="mt-3 bg-amber-600 text-white hover:bg-amber-700"
                  >
                    {resetting ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        {t('resetting')}
                      </>
                    ) : (
                      <>
                        <RotateCcw className="size-4" />
                        {t('resetConfig')}
                      </>
                    )}
                  </Button>
                </div>
              </div>
            </Alert>
          )}

          {/* Last save failed — why, which field, and what to quote to Meta */}
          {saveFailure && (
            <Alert className="border-red-500/30 bg-red-500/10">
              <div className="flex items-start gap-3">
                <XCircle className="mt-0.5 size-5 shrink-0 text-red-400" />
                <div className="min-w-0 flex-1">
                  <AlertTitle className="mb-1 text-red-800 dark:text-red-200">
                    {t('lastSaveFailed')}
                  </AlertTitle>
                  <AlertDescription className="text-sm text-red-800/90 dark:text-red-100/80">
                    {saveFailure.message}
                  </AlertDescription>
                  {saveFailure.meta && renderMetaDetails(saveFailure.meta)}
                </div>
              </div>
            </Alert>
          )}

          {/* Connection Status */}
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {connectionStatus === 'connected' ? (
                <CheckCircle2 className="text-primary size-4" />
              ) : numberDisconnected ? (
                <AlertTriangle className="size-4 text-amber-500" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {connectionStatus === 'connected'
                  ? t('credentialsValid')
                  : numberDisconnected
                    ? t('numberDisconnectedTitle')
                    : t('notConnected')}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {connectionStatus === 'connected'
                ? t('connectedDesc')
                : numberDisconnected
                  ? t('numberDisconnectedHint')
                  : statusMessage || t('notConnectedDesc')}
            </AlertDescription>
            {connectionStatus === 'connected' && wabaSubscription?.checked && (
              <p
                className={
                  'mt-1 text-xs ' +
                  (wabaSubscription.subscribed === false
                    ? 'text-amber-700 dark:text-amber-300'
                    : 'text-muted-foreground')
                }
              >
                {wabaSubscription.subscribed === false
                  ? t('wabaNotSubscribed')
                  : wabaSubscription.subscribed === true
                    ? t('wabaSubscribed')
                    : wabaSubscription.error}
              </p>
            )}
            {connectionStatus !== 'connected' &&
              statusMeta &&
              renderMetaDetails(statusMeta)}
          </Alert>

          {/* Registration Status — the "is it actually live?" check.
            Credentials being valid is necessary but not sufficient;
            without a successful /register call the number won't
            receive inbound events. Surface this dimension separately
            so users don't trust a misleading green banner. */}
          {config && (
            <Alert
              className={
                isRegistered
                  ? 'border-emerald-500/30 bg-emerald-500/10'
                  : 'border-amber-500/30 bg-amber-500/10'
              }
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  {isRegistered ? (
                    <CheckCircle2 className="size-4 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="size-4 text-amber-500" />
                  )}
                  <AlertTitle
                    className={
                      'mb-0 ' +
                      (isRegistered ? 'text-emerald-800 dark:text-emerald-200' : 'text-amber-800 dark:text-amber-200')
                    }
                  >
                    {isRegistered ? t('registered') : t('notRegistered')}
                  </AlertTitle>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleVerifyRegistration}
                  disabled={verifyingRegistration}
                  className="border-border text-foreground hover:bg-muted h-7 bg-transparent"
                >
                  {verifyingRegistration ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  {t('verifyWithMeta')}
                </Button>
              </div>
              <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
                {isRegistered ? (
                  <span
                    dangerouslySetInnerHTML={{
                      __html: t('subscribedSince', {
                        date: config.registered_at
                          ? new Date(config.registered_at).toLocaleString()
                          : t('unknownDate'),
                      }),
                    }}
                  />
                ) : lastRegistrationError ? (
                  <>
                    {t('lastAttemptFailed')}
                    <span className="text-red-700 dark:text-red-300">
                      &quot;{lastRegistrationError}&quot;
                    </span>
                    . {t('retryHint')}
                  </>
                ) : (
                  <>{t('noRegistrationHint')}</>
                )}
              </AlertDescription>

              {registrationProbe && (
                <div className="border-border bg-card/60 mt-3 space-y-1.5 rounded border px-3 py-2 text-[11px]">
                  <p className="text-foreground font-medium">
                    {t('diagnosticLastRun')}
                    <span
                      className={
                        registrationProbe.live
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-amber-500'
                      }
                    >
                      {registrationProbe.live ? t('live') : t('notLive')}
                    </span>
                  </p>
                  <ul className="text-muted-foreground space-y-0.5">
                    {Object.entries(registrationProbe.checks).map(([k, v]) => (
                      <li key={k} className="flex items-center gap-1.5">
                        {v === true ? (
                          <CheckCircle2 className="size-3 shrink-0 text-emerald-400" />
                        ) : v === false ? (
                          <XCircle className="size-3 shrink-0 text-red-400" />
                        ) : (
                          <span className="border-border size-3 shrink-0 rounded-full border" />
                        )}
                        <code className="text-muted-foreground">{k}</code>
                      </li>
                    ))}
                  </ul>
                  {(registrationProbe.errors ?? []).length > 0 && (
                    <ul className="space-y-0.5 pt-1 text-red-700 dark:text-red-300">
                      {registrationProbe.errors?.map((e, i) => (
                        <li key={i}>• {e}</li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </Alert>
          )}

          {/* API Credentials */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {adding
                  ? tn('settings.addingTitle')
                  : selectedNumber && numbers.length > 1
                    ? tn('settings.editing', { name: numberLabel(selectedNumber, tn) })
                    : t('apiCredentialsTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {adding ? tn('settings.addingDesc') : t('apiCredentialsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('phoneNumberId')}
                </Label>
                <Input
                  placeholder={t('phoneNumberIdPlaceholder')}
                  value={phoneNumberId}
                  // A saved number keeps its id: a different id is another
                  // number, connected through "Add number manually".
                  readOnly={Boolean(config)}
                  onChange={(e) => setPhoneNumberId(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                {config && (
                  <p className="text-muted-foreground text-xs">
                    {tn('settings.phoneLocked')}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('wabaId')}</Label>
                <Input
                  placeholder={t('wabaIdPlaceholder')}
                  value={wabaId}
                  onChange={(e) => setWabaId(e.target.value)}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('accessToken')}
                </Label>
                <div className="relative">
                  <Input
                    type={showToken ? 'text' : 'password'}
                    placeholder={t('accessTokenPlaceholder')}
                    value={accessToken}
                    onChange={(e) => {
                      setAccessToken(e.target.value);
                      setTokenEdited(true);
                    }}
                    onFocus={() => {
                      if (accessToken === MASKED_TOKEN) {
                        setAccessToken('');
                        setTokenEdited(true);
                      }
                    }}
                    className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowToken(!showToken)}
                    className="text-muted-foreground hover:text-foreground absolute top-1/2 right-2 -translate-y-1/2 transition-colors"
                  >
                    {showToken ? (
                      <EyeOff className="size-4" />
                    ) : (
                      <Eye className="size-4" />
                    )}
                  </button>
                </div>
                {config && !tokenEdited && (
                  <p className="text-muted-foreground text-xs">
                    {t('tokenHidden')}
                  </p>
                )}
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('webhookVerifyToken')}
                </Label>
                <Input
                  placeholder={t('webhookVerifyTokenPlaceholder')}
                  value={verifyToken}
                  onChange={(e) => {
                    setVerifyToken(e.target.value);
                    setVerifyEdited(true);
                  }}
                  onFocus={() => {
                    if (verifyToken === MASKED_TOKEN) {
                      setVerifyToken('');
                      setVerifyEdited(true);
                    }
                  }}
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
                />
                <p className="text-muted-foreground text-xs">
                  {config?.verify_token && !verifyEdited
                    ? t('webhookVerifyTokenSaved')
                    : t('webhookVerifyTokenHint')}
                </p>
              </div>

              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('twoStepPin')}
                  <span className="text-muted-foreground ml-1">
                    {t('optional')}
                  </span>
                </Label>
                <Input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  placeholder={t('pinPlaceholder')}
                  value={pin}
                  onChange={(e) =>
                    setPin(e.target.value.replace(/\D/g, '').slice(0, 6))
                  }
                  className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
                />
                <p className="text-muted-foreground text-xs leading-relaxed">
                  <span dangerouslySetInnerHTML={{ __html: t('pinHint') }} />
                </p>
              </div>
            </CardContent>
          </Card>

          {/* Webhook URL */}
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground">
                {t('webhookTitle')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('webhookDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <Label className="text-muted-foreground">
                  {t('webhookUrl')}
                </Label>
                <div className="flex gap-2">
                  <Input
                    readOnly
                    value={webhookUrl}
                    className="bg-muted border-border text-muted-foreground font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={handleCopyWebhookUrl}
                    aria-label={t('copyWebhookUrl')}
                    className="border-border text-muted-foreground hover:text-foreground hover:bg-muted shrink-0"
                  >
                    <Copy className="size-4" />
                  </Button>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* The business profile of the number the form is showing (Meta's copy).
              Hidden for a removed number: it has no token, so the route answers 409. */}
          {config && selectedNumber && !selectedNumber.removed && (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">{t('businessProfileTitle')}</CardTitle>
                <CardDescription className="text-muted-foreground">
                  {t('businessProfileDesc', { name: numberLabel(selectedNumber, tn) })}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <Button type="button" variant="outline" size="sm" onClick={() => setProfileOpen(true)}>
                  <Store className="size-3.5" />
                  {canEditSettings ? t('businessProfileEdit') : t('businessProfileView')}
                </Button>
                <BusinessProfileDialog
                  key={selectedNumber.id}
                  numberId={selectedNumber.id}
                  numberLabel={numberLabel(selectedNumber, tn)}
                  open={profileOpen}
                  onOpenChange={setProfileOpen}
                  canEdit={canEditSettings}
                />
              </CardContent>
            </Card>
          )}

          {/* Both are per number; they start on the number the form is showing. */}
          {config && <IceBreakersCard key={config.id} numberId={config.id} canEdit={canEditSettings} />}

          {config && <FormsEncryptionCard key={config.id} numberId={config.id} canEdit={canEditSettings} />}

          {/* Attachment retention. Only meaningful once a number is
            connected, since it governs what the webhook does with
            inbound media. */}
          {config && (
            <Card>
              <CardHeader>
                <CardTitle className="text-foreground">
                  {t('mediaTitle')}
                </CardTitle>
                <CardDescription className="text-muted-foreground">
                  {t('mediaDesc')}
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="border-border flex items-center justify-between gap-4 rounded-md border p-3">
                  <div>
                    <p className="text-foreground text-sm font-medium">
                      {t('mirrorInbound')}
                    </p>
                    <p className="text-muted-foreground text-xs">
                      {t('mirrorInboundDesc')}
                    </p>
                    {!mirrorMedia && (
                      <p className="mt-1 text-xs text-amber-600 dark:text-amber-500">
                        {t('mirrorInboundOffWarning')}
                      </p>
                    )}
                  </div>
                  <Switch
                    checked={mirrorMedia}
                    onCheckedChange={handleToggleMirrorMedia}
                    disabled={savingMirror || !canEditSettings}
                    aria-label={t('mirrorInbound')}
                  />
                </div>
              </CardContent>
            </Card>
          )}

          {/* Action Buttons */}
          <div className="flex flex-wrap gap-3">
            <Button
              onClick={handleSave}
              disabled={saving}
              className="bg-primary hover:bg-primary/90 text-primary-foreground"
            >
              {saving ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('saving')}
                </>
              ) : (
                t('saveConfig')
              )}
            </Button>
            {adding && numbers.length > 0 && (
              <Button
                variant="ghost"
                onClick={() => {
                  if (accountId) void fetchConfig(accountId, null);
                }}
                disabled={saving}
              >
                {tn('settings.cancel')}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleTestConnection}
              disabled={testing || !config}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {testing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  {t('testing')}
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  {t('testConnection')}
                </>
              )}
            </Button>
            {config && !numberDisconnected && (
              <Button
                variant="outline"
                onClick={handleReset}
                disabled={resetting}
                className="border-red-500/30 text-red-600 dark:text-red-400 hover:bg-red-500/10 hover:text-red-700 dark:hover:text-red-300"
              >
                {resetting ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    {t('resetting')}
                  </>
                ) : (
                  <>
                    <RotateCcw className="size-4" />
                    {t('resetConfig')}
                  </>
                )}
              </Button>
            )}
          </div>
        </div>

        {/* Setup Instructions Sidebar */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-foreground text-base">
                {t('setupInstructions')}
              </CardTitle>
              <CardDescription className="text-muted-foreground">
                {t('setupInstructionsDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Accordion>
                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        1
                      </span>
                      {t('step1')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li dangerouslySetInnerHTML={{ __html: t('step1_1') }} />
                      <li>{t('step1_2')}</li>
                      <li>{t('step1_3')}</li>
                      <li>{t('step1_4')}</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        2
                      </span>
                      {t('step2')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>{t('step2_1')}</li>
                      <li>{t('step2_2')}</li>
                      <li>{t('step2_3')}</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        3
                      </span>
                      {t('step3')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>{t('step3_1')}</li>
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step3_2') }}
                      />
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step3_3') }}
                      />
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step3_4') }}
                      />
                    </ol>
                  </AccordionContent>
                </AccordionItem>

                <AccordionItem className="border-border">
                  <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
                    <span className="flex items-center gap-2">
                      <span className="bg-primary text-primary-foreground flex size-5 items-center justify-center rounded-full text-xs font-bold">
                        4
                      </span>
                      {t('step4')}
                    </span>
                  </AccordionTrigger>
                  <AccordionContent className="text-muted-foreground">
                    <ol className="list-inside list-decimal space-y-1 text-sm">
                      <li>{t('step4_1')}</li>
                      <li>{t('step4_2')}</li>
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step4_3') }}
                      />
                      <li
                        dangerouslySetInnerHTML={{ __html: t.raw('step4_4') }}
                      />
                      <li>{t('step4_5')}</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <div className="border-border mt-4 border-t pt-4">
                <a
                  href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:text-primary/80 inline-flex items-center gap-1.5 text-sm transition-colors"
                >
                  <ExternalLink className="size-3.5" />
                  {t('metaDocs')}
                </a>
              </div>
            </CardContent>
          </Card>

          {/* Green tick guidance; the display-name step follows the shown number's name status. */}
          {config && <GreenTickChecklist nameStatus={selectedNumber?.name_status ?? null} />}
        </div>
      </div>
    </section>
  );
}
