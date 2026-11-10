'use client';
import { authFetch } from "@/lib/auth/client";

// ============================================================
// WebhooksSettings — Settings → API & webhooks
//
// Outbound webhook endpoints: Bodhinox POSTs signed JSON events to
// them. Any member sees the roster; admin+ can add, pause and delete
// (RequireRole here, admin-only routes + RLS on the server). The
// signing secret is revealed once at creation, like an API key.
// An endpoint switched off after a day of failed deliveries says so,
// and admins can open its delivery log (the last 100 attempts).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { AlertTriangle, Copy, History, Loader2, Plus, Trash2, Webhook } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { RequireRole } from '@/components/auth/require-role';
import { useAuth } from '@/hooks/use-auth';
import { useWorkspaceChannels } from '@/hooks/use-workspace-channels';
import {
  WEBHOOK_CHANNELS,
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  type WebhookChannel,
  type WebhookEvent,
} from '@/lib/webhooks/events';
import type { ApiWebhookEndpoint } from '@/lib/webhooks/endpoints';
import type { WebhookDelivery } from '@/lib/webhooks/manage';

/** Hours of failure before delivery switches an endpoint off (DISABLE_AFTER_FAILING_MINUTES / 60). */
const DISABLE_AFTER_HOURS = 24;
import { useTranslations } from 'next-intl';
import { SettingsPanelHead } from './settings-panel-head';

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function WebhooksSettings() {
  const { canEditSettings } = useAuth();
  const t = useTranslations('Settings.webhooks');

  const [webhooks, setWebhooks] = useState<ApiWebhookEndpoint[]>([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [logFor, setLogFor] = useState<ApiWebhookEndpoint | null>(null);
  // Channel choices appear once the workspace uses Instagram (or an endpoint already opted in).
  const { data: workspaceChannels } = useWorkspaceChannels();
  const showChannels = Boolean(workspaceChannels?.channels.instagram.enabled)
    || webhooks.some((w) => w.channels.includes('instagram'));

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/account/webhooks', { cache: 'no-store' });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('loadFailed'));
        return;
      }
      setWebhooks((payload as { webhooks: ApiWebhookEndpoint[] }).webhooks);
    } catch {
      toast.error(t('networkError'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function mutate(id: string, init: RequestInit, failedMessage: string) {
    setBusy(id);
    try {
      const res = await authFetch(`/api/account/webhooks/${id}`, init);
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || failedMessage);
        return false;
      }
      return true;
    } catch {
      toast.error(t('networkError'));
      return false;
    } finally {
      setBusy(null);
    }
  }

  async function setActive(hook: ApiWebhookEndpoint, isActive: boolean) {
    const ok = await mutate(
      hook.id,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive }),
      },
      t('updateFailed')
    );
    if (ok)
      setWebhooks((prev) =>
        prev.map((w) =>
          w.id === hook.id
            ? isActive
              ? { ...w, is_active: true, failure_count: 0, disabled_at: null, disabled_reason: null }
              : { ...w, is_active: false }
            : w
        )
      );
  }

  async function setChannels(hook: ApiWebhookEndpoint, channels: WebhookChannel[]) {
    const ok = await mutate(
      hook.id,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channels }),
      },
      t('updateFailed')
    );
    if (ok) setWebhooks((prev) => prev.map((w) => (w.id === hook.id ? { ...w, channels } : w)));
  }

  async function remove(hook: ApiWebhookEndpoint) {
    if (await mutate(hook.id, { method: 'DELETE' }, t('deleteFailed'))) {
      toast.success(t('deleted'));
      setWebhooks((prev) => prev.filter((w) => w.id !== hook.id));
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title={t('title')}
        description={t('description')}
        action={
          <RequireRole min="admin">
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              {t('add')}
            </Button>
          </RequireRole>
        }
      />

      {webhooks.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-10 text-center">
            <Webhook className="text-muted-foreground size-6" />
            <p className="text-muted-foreground mt-2 text-sm">{t('empty')}</p>
            <p className="text-muted-foreground mt-1 text-xs">
              {canEditSettings ? t('emptyAdminHint') : t('askAdminHint')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <ul className="divide-border divide-y">
              {webhooks.map((w) => (
                <li
                  key={w.id}
                  className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-foreground truncate font-mono text-xs">{w.url}</span>
                      {!w.is_active && (
                        <Badge className="border-border bg-muted text-muted-foreground text-[10px] tracking-wide uppercase">
                          {t('paused')}
                        </Badge>
                      )}
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {w.events.map((e) => (
                        <Badge key={e} className="border-border bg-muted text-muted-foreground text-[10px]">
                          {e}
                        </Badge>
                      ))}
                    </div>
                    {showChannels && (
                      <ChannelChecks
                        idPrefix={`webhook-${w.id}`}
                        value={w.channels}
                        disabled={!canEditSettings || busy === w.id}
                        onChange={(channels) => setChannels(w, channels)}
                      />
                    )}
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {t('created', { date: fmtDate(w.created_at) })}
                      {' · '}
                      {w.last_delivery_at
                        ? t('lastDelivery', { date: fmtDate(w.last_delivery_at) })
                        : t('noDelivery')}
                      {w.failure_count > 0 ? ` · ${t('failures', { count: w.failure_count })}` : ''}
                    </p>
                    {!w.is_active && w.disabled_at && (
                      <p role="status" className="mt-1.5 flex items-start gap-1.5 text-xs text-amber-500">
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                        {t('disabledNotice', { date: fmtDate(w.disabled_at), hours: DISABLE_AFTER_HOURS })}
                      </p>
                    )}
                  </div>

                  <RequireRole min="admin">
                    <div className="flex items-center gap-3 self-start sm:self-auto">
                      <Button variant="outline" size="sm" onClick={() => setLogFor(w)} aria-label={t('viewLog')}>
                        <History className="size-4" />
                      </Button>
                      <Switch
                        checked={w.is_active}
                        disabled={busy === w.id}
                        onCheckedChange={(checked) => setActive(w, checked)}
                        aria-label={w.is_active ? t('pause') : t('resume')}
                      />
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => remove(w)}
                        disabled={busy === w.id}
                        aria-label={t('delete')}
                        className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                      >
                        {busy === w.id ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                      </Button>
                    </div>
                  </RequireRole>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <CreateWebhookDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} showChannels={showChannels} />
      {logFor && <DeliveryLogDialog key={logFor.id} hook={logFor} onClose={() => setLogFor(null)} />}
    </section>
  );
}

// ------------------------------------------------------------
// Delivery log — the endpoint's latest attempts (admins and owners).
// ------------------------------------------------------------

// Mounted per endpoint (keyed), so each opening starts from a fresh loading state.
function DeliveryLogDialog({ hook, onClose }: { hook: ApiWebhookEndpoint; onClose: () => void }) {
  const t = useTranslations('Settings.webhooks');
  const [rows, setRows] = useState<WebhookDelivery[] | null>(null);
  const [failed, setFailed] = useState(false);
  const id = hook.id;

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/account/webhooks/${id}/deliveries`, { cache: 'no-store' })
      .then(async (res) => {
        const payload = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setFailed(true);
        else setRows((payload as { deliveries: WebhookDelivery[] }).deliveries);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  return (
    <Dialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent className="border-border bg-popover sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t('viewLog')}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            <span className="block truncate font-mono text-xs">{hook.url}</span>
            {t('logDesc')}
          </DialogDescription>
        </DialogHeader>
        {failed ? (
          <p className="text-sm text-red-400">{t('logLoadFailed')}</p>
        ) : rows === null ? (
          <div className="flex justify-center py-6">
            <Loader2 className="text-primary size-5 animate-spin" />
          </div>
        ) : rows.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('logEmpty')}</p>
        ) : (
          <ul className="divide-border max-h-80 divide-y overflow-y-auto text-xs">
            {rows.map((row) => (
              <li key={row.id} className="flex items-center gap-2 py-2">
                <Badge
                  className={
                    row.outcome === 'delivered'
                      ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-500'
                      : 'border-red-500/30 bg-red-500/10 text-red-400'
                  }
                >
                  {row.outcome === 'delivered' ? t('logDelivered') : t('logFailed')}
                </Badge>
                <span className="text-foreground font-mono">{row.event}</span>
                <span className="text-muted-foreground">
                  {t('logAttempt', { attempt: row.attempt })}
                  {row.http_status ? ` · HTTP ${row.http_status}` : ''}
                  {row.error && row.error !== 'http_status' ? ` · ${row.error}` : ''}
                </span>
                <span className="text-muted-foreground ml-auto shrink-0">{new Date(row.created_at).toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time secret reveal.
// ------------------------------------------------------------

/**
 * The channels an endpoint receives events from. The last checked channel
 * cannot be unchecked: an endpoint always receives at least one.
 */
function ChannelChecks({
  idPrefix,
  value,
  disabled,
  onChange,
}: {
  idPrefix: string;
  value: WebhookChannel[];
  disabled: boolean;
  onChange: (channels: WebhookChannel[]) => void;
}) {
  const t = useTranslations('Settings.webhooks.channels');
  return (
    <fieldset className="mt-1.5 space-y-1">
      <legend className="text-muted-foreground text-xs">{t('label')}</legend>
      <div className="flex flex-wrap gap-3">
        {WEBHOOK_CHANNELS.map((channel) => {
          const checked = value.includes(channel);
          const id = `${idPrefix}-${channel}`;
          return (
            <label key={channel} htmlFor={id} className="flex cursor-pointer items-center gap-1.5 text-xs text-foreground">
              <Checkbox
                id={id}
                checked={checked}
                disabled={disabled || (checked && value.length === 1)}
                onCheckedChange={(next) =>
                  onChange(WEBHOOK_CHANNELS.filter((c) => (c === channel ? next === true : value.includes(c))))
                }
              />
              {t(channel)}
            </label>
          );
        })}
      </div>
      <p className="text-muted-foreground text-xs">
        {value.includes('instagram') ? t('instagramNote') : t('help')}
      </p>
    </fieldset>
  );
}

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
  showChannels,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
  showChannels: boolean;
}) {
  const t = useTranslations('Settings.webhooks');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [channels, setChannels] = useState<WebhookChannel[]>(['whatsapp']);
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  function close() {
    setUrl('');
    setEvents([]);
    setChannels(['whatsapp']);
    setSubmitting(false);
    setSecret(null);
    onOpenChange(false);
  }

  async function handleCreate() {
    setSubmitting(true);
    try {
      const res = await authFetch('/api/account/webhooks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url.trim(), events, channels }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || t('createFailed'));
        return;
      }
      setSecret((payload as { webhook: { secret: string } }).webhook.secret);
      onCreated();
    } catch {
      toast.error(t('networkError'));
    } finally {
      setSubmitting(false);
    }
  }

  async function copySecret() {
    if (!secret) return;
    try {
      await navigator.clipboard.writeText(secret);
      toast.success(t('copySuccess'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent className="border-border bg-popover sm:max-w-md">
        {secret ? (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('secretTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t('secretDesc')}</DialogDescription>
            </DialogHeader>
            <div className="flex gap-2">
              <Input readOnly value={secret} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
              <Button type="button" variant="outline" onClick={copySecret}>
                <Copy className="size-4" />
                {t('copy')}
              </Button>
            </div>
            <DialogFooter>
              <Button onClick={close}>{t('done')}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle className="text-popover-foreground">{t('newTitle')}</DialogTitle>
              <DialogDescription className="text-muted-foreground">{t('newDesc')}</DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="webhook-url" className="text-muted-foreground">
                  {t('urlLabel')}
                </Label>
                <Input
                  id="webhook-url"
                  type="url"
                  inputMode="url"
                  value={url}
                  placeholder="https://example.com/bodhinox/webhook"
                  onChange={(e) => setUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-muted-foreground">{t('eventsLabel')}</Label>
                <div className="border-border space-y-2 rounded-md border p-3">
                  {WEBHOOK_EVENTS.map((event) => (
                    <label key={event} className="flex cursor-pointer items-start gap-2.5">
                      <Checkbox
                        checked={events.includes(event)}
                        onCheckedChange={(checked) =>
                          setEvents((prev) =>
                            checked === true ? [...prev, event] : prev.filter((e) => e !== event)
                          )
                        }
                        className="mt-0.5"
                      />
                      <span className="min-w-0">
                        <span className="text-foreground block font-mono text-xs">{event}</span>
                        <span className="text-muted-foreground block text-xs">
                          {WEBHOOK_EVENT_DESCRIPTIONS[event]}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </div>
              {showChannels && (
                <ChannelChecks idPrefix="webhook-new" value={channels} disabled={submitting} onChange={setChannels} />
              )}
            </div>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={close}
                className="border-border text-muted-foreground hover:bg-muted"
              >
                {t('cancel')}
              </Button>
              <Button onClick={handleCreate} disabled={submitting || !url.trim() || events.length === 0}>
                {submitting ? <Loader2 className="size-4 animate-spin" /> : null}
                {t('create')}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
