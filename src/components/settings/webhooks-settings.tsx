'use client';
import { authFetch } from "@/lib/auth/client";

// ============================================================
// WebhooksSettings — Settings → API & webhooks
//
// Outbound webhook endpoints: Bodhinox POSTs signed JSON events to
// them. Any member sees the roster; admin+ can add, pause and delete
// (RequireRole here, admin-only routes + RLS on the server). The
// signing secret is revealed once at creation, like an API key.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Plus, Trash2, Webhook } from 'lucide-react';

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
import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  type WebhookEvent,
} from '@/lib/webhooks/events';
import type { ApiWebhookEndpoint } from '@/lib/webhooks/endpoints';
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
            ? { ...w, is_active: isActive, failure_count: isActive ? 0 : w.failure_count }
            : w
        )
      );
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
                    <p className="text-muted-foreground mt-1.5 text-xs">
                      {t('created', { date: fmtDate(w.created_at) })}
                      {' · '}
                      {w.last_delivery_at
                        ? t('lastDelivery', { date: fmtDate(w.last_delivery_at) })
                        : t('noDelivery')}
                      {w.failure_count > 0 ? ` · ${t('failures', { count: w.failure_count })}` : ''}
                    </p>
                  </div>

                  <RequireRole min="admin">
                    <div className="flex items-center gap-3 self-start sm:self-auto">
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

      <CreateWebhookDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={load} />
    </section>
  );
}

// ------------------------------------------------------------
// Create dialog — form → one-time secret reveal.
// ------------------------------------------------------------

function CreateWebhookDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => void;
}) {
  const t = useTranslations('Settings.webhooks');
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<WebhookEvent[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);

  function close() {
    setUrl('');
    setEvents([]);
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
        body: JSON.stringify({ url: url.trim(), events }),
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
