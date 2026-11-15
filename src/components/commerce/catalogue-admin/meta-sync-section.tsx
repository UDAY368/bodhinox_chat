"use client";

/**
 * Full Meta catalogue sync (store plan Phase 4): the opt-in, what it covers,
 * each published product's status, and the items that need a person: failed
 * ones with the reason, and uncertain ones with a Reconcile button (an
 * uncertain create is never sent again until it is checked in Meta).
 * Everyone on the team sees the status; only admins change anything.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { StateBadge } from "@/components/commerce/orders/state-badge";
import type { Tone } from "@/components/commerce/orders/order-state";
import { fetchMetaSync, reconcileMetaSyncItem, runMetaSync, saveMetaSync, type MetaSyncView } from "./catalogue-api";
import { useCatalogueError } from "./catalogue-admin";

type Status = keyof MetaSyncView["counts"];
const TONES: Record<Status, Tone> = { synced: "ok", pending: "accent", not_synced: "neutral", failed: "bad", uncertain: "warn" };
const STATUSES: Status[] = ["synced", "pending", "not_synced", "failed", "uncertain"];

export function MetaSyncSection({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.catalogue.metaSync");
  const errorText = useCatalogueError();
  const [view, setView] = useState<MetaSyncView | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchMetaSync();
    if (r.ok) setView(r.data);
    else toast.error(errorText(r));
  }, [errorText]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other dashboard panels do
    void load();
  }, [load]);

  const save = async (key: string, body: Parameters<typeof saveMetaSync>[0]) => {
    setBusy(key);
    const r = await saveMetaSync(body);
    setBusy(null);
    if (r.ok) setView(r.data);
    else toast.error(errorText(r));
  };
  const syncNow = async () => {
    setBusy("run");
    const r = await runMetaSync();
    setBusy(null);
    if (r.ok) toast.success(t("queued"));
    else toast.error(errorText(r));
  };
  const reconcile = async (variantId: string) => {
    setBusy(variantId);
    const r = await reconcileMetaSyncItem(variantId);
    setBusy(null);
    if (!r.ok) { toast.error(errorText(r)); return; }
    toast.success(t(r.data.status === "synced" ? "reconciledFound" : "reconciledMissing"));
    await load();
  };

  if (view === null) return <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  const reason = (code: string | null) => (code && t.has(`reasons.${code}`) ? t(`reasons.${code}`) : t("reasons.generic"));

  return (
    <div className="space-y-4 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-base font-semibold tracking-tight text-foreground">{t("title")}</h2>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
        </div>
        {view.connected && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Switch checked={view.enabled} disabled={!canManage || busy !== null} aria-label={t("enable")}
              onCheckedChange={(on) => void save("enabled", { enabled: !!on })} />
            {t(view.enabled ? "on" : "off")}
          </label>
        )}
      </div>

      {!view.connected ? (
        <p className="rounded-lg bg-muted px-3 py-2 text-sm text-muted-foreground">{t("notConnected")}</p>
      ) : !view.enabled ? (
        <p className="text-sm text-muted-foreground">{t("offHint")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {STATUSES.map((s) => <StateBadge key={s} tone={TONES[s]}>{t(`statuses.${s}`)} · {view.counts[s]}</StateBadge>)}
            {canManage && (
              <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== null} onClick={() => void syncNow()}>
                {busy === "run" ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}{t("syncNow")}
              </Button>
            )}
          </div>

          <fieldset className="flex flex-wrap gap-x-5 gap-y-1 text-sm" disabled={!canManage || busy !== null}>
            <legend className="sr-only">{t("scopeLabel")}</legend>
            {(["all", "selected"] as const).map((scope) => (
              <label key={scope} className="flex items-center gap-2">
                <input type="radio" name="meta-sync-scope" checked={view.scope === scope} onChange={() => void save("scope", { scope })} />
                {t(`scope.${scope}`)}
              </label>
            ))}
          </fieldset>

          {view.problems.length > 0 && (
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-foreground">{t("problems", { count: view.problems.length })}</h3>
              <p className="text-xs text-muted-foreground">{t("uncertainHint")}</p>
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {view.problems.map((p) => (
                  <li key={p.variant_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                    <StateBadge tone={TONES[p.status]}>{t(`statuses.${p.status}`)}</StateBadge>
                    <span className="font-mono text-xs text-muted-foreground">{p.sku}</span>
                    <span className="text-foreground">{p.product_name}</span>
                    <span className="text-xs text-muted-foreground">
                      {reason(p.error_code)}{p.error_detail ? ` (${t("metaCode", { code: p.error_detail })})` : ""}
                    </span>
                    {p.status === "uncertain" && canManage && (
                      <Button size="sm" variant="outline" className="ml-auto" disabled={busy !== null} onClick={() => void reconcile(p.variant_id)}>
                        {busy === p.variant_id && <Loader2 className="h-4 w-4 animate-spin" />}{t("reconcile")}
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="space-y-2">
            <h3 className="text-sm font-semibold text-foreground">{t("products", { count: view.products.length })}</h3>
            {view.products.length === 0 ? <p className="text-sm text-muted-foreground">{t("noProducts")}</p> : (
              <ul className="divide-y divide-border rounded-lg border border-border text-sm">
                {view.products.map((p) => {
                  const covered = view.scope === "all" || p.selected;
                  return (
                    <li key={p.product_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                      {view.scope === "selected" && (
                        <input type="checkbox" aria-label={t("selectProduct", { name: p.name })} checked={p.selected} disabled={!canManage || busy !== null}
                          onChange={() => void save(p.product_id, p.selected ? { deselect: p.product_id } : { select: p.product_id })} />
                      )}
                      <span className="text-foreground">{p.name}</span>
                      <span className="text-xs text-muted-foreground">{t("variants", { count: p.variants })}</span>
                      <span className="ml-auto">
                        {covered ? <StateBadge tone={TONES[p.status]}>{t(`statuses.${p.status}`)}</StateBadge>
                          : <StateBadge tone="neutral">{t("notSelected")}</StateBadge>}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
