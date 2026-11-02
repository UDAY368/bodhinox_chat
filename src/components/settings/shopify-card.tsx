"use client";

/**
 * Settings → Shopify: connect a store (OAuth install by its myshopify domain),
 * see its status, choose whether marketing goes only to subscribed customers,
 * and set one WhatsApp template message per store event (order placed, paid,
 * fulfilled, cancelled, abandoned checkout) with a delay and variable mapping.
 * Members see everything read-only; admins edit. The token never reaches here.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Loader2, ShoppingBag } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useAuth } from "@/hooks/use-auth";
import { authFetch } from "@/lib/auth/client";
import { NumberSelect } from "./numbers/number-select";
import { useWhatsAppNumbers } from "./numbers/use-whatsapp-numbers";

const EVENTS = ["order_created", "order_paid", "order_fulfilled", "order_cancelled", "checkout_abandoned"] as const;
type EventName = (typeof EVENTS)[number];
const OUTCOMES = new Set([
  "connected", "webhooks_failed", "signed_out", "forbidden", "invalid_hmac", "invalid_shop", "invalid_state", "expired",
  "exchange_failed", "missing_scopes", "connected_elsewhere", "save_failed",
]);
const ERRORS = new Set([
  "not_configured", "invalid_shop", "invalid_request", "invalid_rule", "not_connected", "shopify_unreachable",
  "template_not_found", "template_not_on_number", "number_not_found",
]);

interface StoreDto {
  shop_domain: string;
  scopes: string;
  installed_at: string;
  uninstalled_at: string | null;
  marketing_opt_in_only: boolean;
}
interface RuleDto {
  event: EventName;
  enabled: boolean;
  template_name: string;
  template_language: string | null;
  whatsapp_config_id: string | null;
  delay_minutes: number;
  variable_map: Record<string, string>;
}
interface TemplateDto {
  name: string;
  language: string | null;
  category: string;
  waba_id: string | null;
  variable_count: number;
}
interface State {
  configured: boolean;
  store: StoreDto | null;
  rules: RuleDto[];
  templates: TemplateDto[];
  fields: string[];
}

const templateKey = (t: { name: string; language: string | null }) => `${t.name}::${t.language ?? ""}`;
const emptyRule = (event: EventName): RuleDto => ({
  event, enabled: false, template_name: "", template_language: null, whatsapp_config_id: null,
  delay_minutes: event === "checkout_abandoned" ? 60 : 0, variable_map: {},
});

export function ShopifyCard() {
  const t = useTranslations("Settings.shopify");
  const { canEditSettings: canEdit } = useAuth();
  const searchParams = useSearchParams();
  const [state, setState] = useState<State | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [shop, setShop] = useState("");
  const [busy, setBusy] = useState(false);

  const errorText = useCallback((code: unknown) =>
    typeof code === "string" && ERRORS.has(code) ? t(`errors.${code}`) : t("errors.generic"), [t]);

  const load = useCallback(async () => {
    setLoadFailed(false);
    try {
      const res = await authFetch("/api/integrations/shopify", { cache: "no-store" });
      if (!res.ok) throw new Error();
      setState(await res.json());
    } catch {
      setLoadFailed(true);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // The OAuth callback lands here with ?shopify=<outcome>.
  const outcome = searchParams.get("shopify");
  useEffect(() => {
    if (!outcome || !OUTCOMES.has(outcome)) return;
    if (outcome === "connected") toast.success(t("outcomes.connected"));
    else if (outcome === "webhooks_failed") toast.warning(t("outcomes.webhooks_failed"));
    else toast.error(t(`outcomes.${outcome}`));
  }, [outcome, t]);

  const connect = async () => {
    setBusy(true);
    try {
      const res = await authFetch("/api/integrations/shopify/install", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ shop }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || typeof json.url !== "string") throw new Error(errorText(json.error));
      window.location.assign(json.url);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm(t("disconnectConfirm"))) return;
    setBusy(true);
    try {
      const res = await authFetch("/api/integrations/shopify", { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(json.error));
      toast.success(t("disconnected"));
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const setOptIn = async (value: boolean) => {
    setBusy(true);
    try {
      const res = await authFetch("/api/integrations/shopify", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ marketing_opt_in_only: value }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(json.error));
      setState((s) => (s ? { ...s, store: json.store } : s));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const store = state?.store ?? null;
  const installed = !!store && !store.uninstalled_at;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <ShoppingBag className="size-4" /> {t("title")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!state && !loadFailed && <Loader2 className="size-4 animate-spin text-primary" />}
        {loadFailed && (
          <div className="flex items-center gap-2 text-sm text-destructive">
            {t("loadFailed")}
            <Button type="button" variant="outline" size="sm" onClick={() => void load()}>{t("retry")}</Button>
          </div>
        )}
        {state && !state.configured && <p className="text-sm text-muted-foreground">{t("notConfigured")}</p>}
        {state?.configured && (
          <>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {installed ? (
                <>
                  <Badge variant="secondary">{t("statusConnected")}</Badge>
                  <span className="text-foreground font-medium">{store.shop_domain}</span>
                  <span className="text-muted-foreground">
                    {t("connectedOn", { date: new Date(store.installed_at).toLocaleDateString() })}
                  </span>
                  {canEdit && (
                    <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={disconnect} disabled={busy}>
                      {t("disconnect")}
                    </Button>
                  )}
                </>
              ) : (
                <>
                  <Badge variant="outline">{store ? t("statusUninstalled") : t("statusNotConnected")}</Badge>
                  {store && <span className="text-muted-foreground">{store.shop_domain}</span>}
                </>
              )}
            </div>
            {!installed && canEdit && (
              <div className="flex flex-col gap-2 sm:flex-row">
                <label htmlFor="shopify-domain" className="sr-only">{t("domainLabel")}</label>
                <Input id="shopify-domain" value={shop} onChange={(e) => setShop(e.target.value)} placeholder={t("domainPlaceholder")}
                  maxLength={255} autoComplete="off" className="bg-muted" />
                <Button type="button" onClick={connect} disabled={busy || !shop.trim()}>
                  {busy && <Loader2 className="size-3.5 animate-spin" />} {t("connect")}
                </Button>
              </div>
            )}
            {installed && (
              <label className="flex items-start gap-3 text-sm">
                <Switch checked={store.marketing_opt_in_only} onCheckedChange={(v: boolean) => void setOptIn(v)} disabled={!canEdit || busy} />
                <span>
                  <span className="text-foreground block font-medium">{t("optInOnly")}</span>
                  <span className="text-muted-foreground block text-xs">{t("optInOnlyHelp")}</span>
                </span>
              </label>
            )}
            {store && (
              <div className="space-y-3">
                <h3 className="text-foreground text-sm font-semibold">{t("rulesTitle")}</h3>
                <p className="text-muted-foreground text-xs">{t("rulesHelp")}</p>
                {EVENTS.map((event) => (
                  <RuleEditor
                    key={event}
                    initial={state.rules.find((r) => r.event === event) ?? emptyRule(event)}
                    templates={state.templates}
                    fields={state.fields}
                    canEdit={canEdit && installed}
                    errorText={errorText}
                    onSaved={(rule) => setState((s) => s && { ...s, rules: [...s.rules.filter((r) => r.event !== rule.event), rule] })}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function RuleEditor({ initial, templates, fields, canEdit, errorText, onSaved }: {
  initial: RuleDto;
  templates: TemplateDto[];
  fields: string[];
  canEdit: boolean;
  errorText: (code: unknown) => string;
  onSaved: (rule: RuleDto) => void;
}) {
  const t = useTranslations("Settings.shopify");
  const { numbers } = useWhatsAppNumbers();
  const [rule, setRule] = useState<RuleDto>(initial);
  const [saving, setSaving] = useState(false);
  const id = `shopify-rule-${rule.event}`;

  // Templates on the chosen number's WhatsApp Business account (all when no number is chosen).
  const wabaId = numbers.find((n) => n.id === rule.whatsapp_config_id)?.waba_id ?? null;
  const options = useMemo(() => templates.filter((tpl) => !wabaId || !tpl.waba_id || tpl.waba_id === wabaId), [templates, wabaId]);
  const selected = templates.find((tpl) => tpl.name === rule.template_name && (tpl.language ?? null) === (rule.template_language ?? null))
    ?? templates.find((tpl) => tpl.name === rule.template_name);
  const variableCount = selected?.variable_count ?? 0;

  const save = async () => {
    setSaving(true);
    try {
      const map = Object.fromEntries(Object.entries(rule.variable_map).filter(([k, v]) => Number(k) <= variableCount && v));
      const res = await authFetch("/api/integrations/shopify/rules", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...rule, variable_map: map }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(errorText(json.error));
      setRule(json.rule);
      onSaved(json.rule);
      toast.success(t("ruleSaved"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("errors.generic"));
    } finally {
      setSaving(false);
    }
  };

  const disabled = !canEdit || saving;
  const selectClass = "border-border bg-card text-foreground h-9 w-full rounded-md border px-2 text-sm";
  return (
    <fieldset className="border-border space-y-3 rounded-md border p-3">
      <legend className="sr-only">{t(`events.${rule.event}`)}</legend>
      <div className="flex items-center gap-3">
        <Switch checked={rule.enabled} onCheckedChange={(v: boolean) => setRule({ ...rule, enabled: v })} disabled={disabled || !rule.template_name}
          aria-label={t("enableEvent", { event: t(`events.${rule.event}`) })} />
        <span className="text-foreground text-sm font-medium">{t(`events.${rule.event}`)}</span>
        {rule.event === "checkout_abandoned" && <Badge variant="outline">{t("marketingBadge")}</Badge>}
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1">
          <label htmlFor={`${id}-number`} className="text-muted-foreground text-xs">{t("number")}</label>
          <NumberSelect id={`${id}-number`} numbers={numbers} value={rule.whatsapp_config_id} disabled={disabled}
            onChange={(v) => setRule({ ...rule, whatsapp_config_id: v })} emptyLabel={t("defaultNumber")} className={selectClass} />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-template`} className="text-muted-foreground text-xs">{t("template")}</label>
          <select id={`${id}-template`} className={selectClass} disabled={disabled}
            value={selected ? templateKey(selected) : ""}
            onChange={(e) => {
              const tpl = templates.find((x) => templateKey(x) === e.target.value);
              setRule({ ...rule, template_name: tpl?.name ?? "", template_language: tpl?.language ?? null, enabled: tpl ? rule.enabled : false });
            }}>
            <option value="">{t("chooseTemplate")}</option>
            {options.map((tpl) => (
              <option key={templateKey(tpl)} value={templateKey(tpl)}>
                {tpl.language ? `${tpl.name} (${tpl.language})` : tpl.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-delay`} className="text-muted-foreground text-xs">{t("delay")}</label>
          <Input id={`${id}-delay`} type="number" min={0} max={10080} step={1} value={rule.delay_minutes} disabled={disabled} className="bg-muted"
            onChange={(e) => setRule({ ...rule, delay_minutes: Math.min(10080, Math.max(0, Math.trunc(Number(e.target.value) || 0))) })} />
        </div>
      </div>
      {variableCount > 0 && (
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: Math.min(variableCount, 20) }, (_, i) => String(i + 1)).map((n) => (
            <div key={n} className="space-y-1">
              <label htmlFor={`${id}-var-${n}`} className="text-muted-foreground text-xs">{t("variable", { n })}</label>
              <select id={`${id}-var-${n}`} className={selectClass} disabled={disabled} value={rule.variable_map[n] ?? ""}
                onChange={(e) => setRule({ ...rule, variable_map: { ...rule.variable_map, [n]: e.target.value } })}>
                <option value="">{t("fieldNone")}</option>
                {fields.map((f) => <option key={f} value={f}>{t(`fields.${f}`)}</option>)}
              </select>
            </div>
          ))}
        </div>
      )}
      {canEdit && (
        <div className="flex justify-end">
          <Button type="button" size="sm" onClick={save} disabled={saving || !rule.template_name}>
            {saving && <Loader2 className="size-3.5 animate-spin" />} {t("saveRule")}
          </Button>
        </div>
      )}
    </fieldset>
  );
}
