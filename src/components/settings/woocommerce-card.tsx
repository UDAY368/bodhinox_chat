'use client';

// WooCommerceCard — Settings → connect a WooCommerce store and choose which
// WhatsApp template each order event sends. Admin only (the routes refuse
// everyone else). The webhook secret is shown once, right after connecting,
// together with the delivery URL to paste into WooCommerce.

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, ShoppingBag, Trash2 } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { PageLoading } from '@/components/ui/page-loading';
import { useConfirm } from '@/components/ui/confirm-dialog';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';
import { authFetch } from '@/lib/auth/client';
import type { CommerceEventName } from '@/lib/commerce/event-rules';
import { CommerceRulesEditor } from './commerce-rules-editor';
import { SettingsPanelHead } from './settings-panel-head';
import { cn } from '@/lib/utils';
import { SETTINGS_ROW_HAIRLINE, SettingsBlock, SettingsGroup, SettingsMoreMenu, SettingsRow } from './settings-row';

interface WooStore {
  id: string;
  store_url: string;
  consent_meta_key: string | null;
  connected_at: string;
  delivery_url: string;
}

const WOO_EVENTS: CommerceEventName[] = ['order_created', 'order_paid', 'order_fulfilled', 'order_cancelled'];
const WOO_FIELDS = [
  'customer_name', 'order_number', 'order_id', 'order_status', 'total', 'currency', 'item_count',
  'payment_method', 'payment_url', 'store_url',
];

export function WooCommerceCard() {
  return (
    <RequireRole min="admin">
      <WooCommerceCardInner />
    </RequireRole>
  );
}

function WooCommerceCardInner() {
  const t = useTranslations('Integrations.woocommerce');
  const confirm = useConfirm();
  const [stores, setStores] = useState<WooStore[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [storeUrl, setStoreUrl] = useState('');
  const [consentKey, setConsentKey] = useState('');
  const [created, setCreated] = useState<{ store: WooStore; webhookSecret: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await authFetch('/api/integrations/woocommerce', { cache: 'no-store' });
      const payload = (await res.json().catch(() => ({}))) as { stores?: WooStore[] };
      if (!res.ok) {
        toast.error(t('loadFailed'));
        return;
      }
      setStores(payload.stores ?? []);
    } catch {
      toast.error(t('loadFailed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function connect() {
    setBusy(true);
    try {
      const res = await authFetch('/api/integrations/woocommerce', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ storeUrl, consentMetaKey: consentKey.trim() || null }),
      });
      const payload = (await res.json().catch(() => ({}))) as {
        store?: WooStore; webhookSecret?: string; code?: string;
      };
      if (!res.ok || !payload.store || !payload.webhookSecret) {
        toast.error(payload.code && t.has(`errors.${payload.code}`) ? t(`errors.${payload.code}`) : t('connectFailed'));
        return;
      }
      setCreated({ store: payload.store, webhookSecret: payload.webhookSecret });
      setStores((prev) => [...prev, payload.store!]);
      setStoreUrl('');
      setConsentKey('');
    } catch {
      toast.error(t('connectFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function disconnect(id: string) {
    if (!(await confirm({ title: t('disconnectConfirm'), confirmLabel: t('disconnect'), destructive: true }))) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/integrations/woocommerce?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 404) {
        toast.error(t('disconnectFailed'));
        return;
      }
      setStores((prev) => prev.filter((s) => s.id !== id));
      toast.success(t('disconnected'));
    } catch {
      toast.error(t('disconnectFailed'));
    } finally {
      setBusy(false);
    }
  }

  async function copy(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('copied'));
    } catch {
      toast.error(t('copyFailed'));
    }
  }

  return (
    <section>
      <SettingsPanelHead title={t('title')} description={t('description')} />
      {loading ? (
        <SettingsGroup><SettingsBlock><PageLoading rows={2} /></SettingsBlock></SettingsGroup>
      ) : (
        <div className="space-y-6">
          {stores.length > 0 && (
            <SettingsGroup>
              {stores.map((store) => (
                <div key={store.id} className={cn(SETTINGS_ROW_HAIRLINE, 'space-y-2 px-4 py-3')}>
                  <div className="flex min-h-11 items-center justify-between gap-3 sm:min-h-9">
                    <div className="flex min-w-0 items-center gap-2">
                      <ShoppingBag className="text-muted-foreground h-4 w-4 shrink-0" />
                      <span className="text-foreground truncate text-sm font-medium">{store.store_url}</span>
                    </div>
                    <SettingsMoreMenu actions={[
                      { label: t('disconnect'), icon: Trash2, destructive: true, disabled: busy, onSelect: () => void disconnect(store.id) },
                    ]} />
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="bg-muted min-w-0 flex-1 truncate rounded px-2 py-1 text-xs">{store.delivery_url}</code>
                    <Button variant="outline" size="icon" className="size-11 sm:size-8" onClick={() => void copy(store.delivery_url)} aria-label={t('copyUrl')}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                  <p className="text-muted-foreground text-xs">
                    {store.consent_meta_key
                      ? t('consentKeySet', { key: store.consent_meta_key })
                      : t('consentKeyNone')}
                  </p>
                </div>
              ))}
            </SettingsGroup>
          )}

          <SettingsGroup
            title={t('connectTitle')}
            footer={stores.length === 0 ? t('empty') : undefined}
            action={
              <Button size="sm" className="min-h-11 sm:min-h-8" disabled={busy || !storeUrl.trim()} onClick={() => void connect()}>
                {busy && <Loader2 className="h-4 w-4 animate-spin" />}
                {t('connect')}
              </Button>
            }
          >
            <SettingsRow label={t('storeUrl')} htmlFor="woo-store-url">
              <Input
                id="woo-store-url"
                type="url"
                inputMode="url"
                placeholder="https://shop.example.com"
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.target.value)}
              />
            </SettingsRow>
            <SettingsRow label={t('consentKey')} hint={t('consentKeyHelp')} htmlFor="woo-consent-key">
              <Input
                id="woo-consent-key"
                placeholder="_whatsapp_opt_in"
                value={consentKey}
                onChange={(e) => setConsentKey(e.target.value)}
              />
            </SettingsRow>
          </SettingsGroup>

          {stores.length > 0 && (
            <CommerceRulesEditor title={t('rulesTitle')} source="woocommerce" events={WOO_EVENTS} fields={WOO_FIELDS} />
          )}
        </div>
      )}

      <Sheet open={created !== null} onOpenChange={(open) => !open && setCreated(null)}>
        <SheetContent size="md" className="w-full gap-4 overflow-y-auto p-4">
          <SheetHeader className="p-0 pr-8">
            <SheetTitle>{t('setupTitle')}</SheetTitle>
            <SheetDescription>{t('setupDesc')}</SheetDescription>
          </SheetHeader>
          {created && (
            <div className="space-y-4 text-sm">
              <ol className="text-muted-foreground list-decimal space-y-1 ps-5 text-xs">
                <li>{t('steps.open')}</li>
                <li>{t('steps.add')}</li>
                <li>{t('steps.topic')}</li>
                <li>{t('steps.paste')}</li>
                <li>{t('steps.save')}</li>
                <li>{t('steps.repeat')}</li>
              </ol>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t('deliveryUrl')}</Label>
                <div className="flex items-center gap-2">
                  <code className="bg-muted min-w-0 flex-1 break-all rounded px-2 py-1 text-xs">{created.store.delivery_url}</code>
                  <Button variant="outline" size="sm" onClick={() => void copy(created.store.delivery_url)} aria-label={t('copyUrl')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-muted-foreground text-xs">{t('secret')}</Label>
                <div className="flex items-center gap-2">
                  <code className="bg-muted min-w-0 flex-1 break-all rounded px-2 py-1 text-xs">{created.webhookSecret}</code>
                  <Button variant="outline" size="sm" onClick={() => void copy(created.webhookSecret)} aria-label={t('copySecret')}>
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
                <p className="text-muted-foreground text-xs">{t('secretOnce')}</p>
              </div>
            </div>
          )}
          <SheetFooter className="flex-row flex-wrap justify-end p-0">
            <Button onClick={() => setCreated(null)}>{t('done')}</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </section>
  );
}
