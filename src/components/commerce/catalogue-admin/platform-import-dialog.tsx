"use client";

/**
 * Import products from a connected Shopify or WooCommerce store. Shopify uses the connection already
 * made in Settings; WooCommerce asks for a read-only API key for this one import (kept encrypted
 * until the import ends, never shown again). Imported products are drafts, matched by SKU. The
 * import runs in the background; progress and a cancel show here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  cancelPlatformImport, fetchPlatformStatus, startPlatformImport, type PlatformImportView, type PlatformStatus,
} from "./catalogue-api";
import { useCatalogueError } from "./catalogue-admin";

const SETTINGS = "/settings?tab=integrations";

export function PlatformImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone: () => void }) {
  const t = useTranslations("Commerce.catalogue.platform");
  const errorText = useCatalogueError();
  const [status, setStatus] = useState<PlatformStatus | null>(null);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storeId, setStoreId] = useState("");
  const [key, setKey] = useState("");
  const [secret, setSecret] = useState("");

  const load = useCallback(() => {
    fetchPlatformStatus().then((r) => { if (r.ok) { setStatus(r.data); setFailed(false); } else setFailed(true); });
  }, []);
  const active = !!status?.imports.some((j) => j.status === "queued" || j.status === "running");
  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    if (!open || !active) return;
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, [open, active, load]);
  const wasActive = useRef(false);
  useEffect(() => {
    if (wasActive.current && !active) onDone();
    wasActive.current = active;
  }, [active, onDone]);

  const stores = status?.woocommerce.stores ?? [];
  const store = stores.find((s) => s.id === storeId) ?? stores[0];

  async function start(body: Parameters<typeof startPlatformImport>[0]) {
    setBusy(true); setError(null);
    const r = await startPlatformImport(body);
    setBusy(false);
    if (!r.ok) { setError(errorText(r)); return; }
    setKey(""); setSecret("");
    toast.success(t("queued"));
    load();
  }

  async function cancel(id: string) {
    const r = await cancelPlatformImport(id);
    if (!r.ok) setError(errorText(r)); else load();
  }

  const close = (next: boolean) => { if (!next) { setKey(""); setSecret(""); setError(null); } onOpenChange(next); };
  const notConnected = (
    <p className="text-sm text-muted-foreground">
      {t("notConnected")} <Link href={SETTINGS} className="font-medium text-primary hover:underline">{t("openSettings")}</Link>
    </p>
  );

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {failed && !status && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{t("loadFailed")}</p>}
          {!status && !failed && <div className="flex justify-center p-2"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("working")} /></div>}
          {error && <p role="alert" className="rounded-lg bg-destructive/10 p-2 text-sm text-destructive">{error}</p>}

          {status && (
            <>
              <section className="space-y-2 rounded-lg border border-border p-3" aria-labelledby="pi-shopify">
                <h3 id="pi-shopify" className="text-sm font-semibold">Shopify</h3>
                {!status.shopify.connected ? notConnected
                  : !status.shopify.scope_ok ? (
                    <p role="alert" className="text-sm text-muted-foreground">
                      {t("shopifyScope", { shop: status.shopify.shop_domain ?? "" })}{" "}
                      <Link href={SETTINGS} className="font-medium text-primary hover:underline">{t("openSettings")}</Link>
                    </p>
                  ) : (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-sm text-muted-foreground">{t("shopifyReady", { shop: status.shopify.shop_domain ?? "" })}</p>
                      <Button disabled={busy || active} onClick={() => void start({ platform: "shopify" })}>{t("start")}</Button>
                    </div>
                  )}
              </section>

              <section className="space-y-2 rounded-lg border border-border p-3" aria-labelledby="pi-woo">
                <h3 id="pi-woo" className="text-sm font-semibold">WooCommerce</h3>
                {!store ? notConnected : (
                  <div className="space-y-2">
                    {stores.length > 1 ? (
                      <div className="space-y-1.5">
                        <Label htmlFor="pi-store">{t("store")}</Label>
                        <select id="pi-store" value={store.id} onChange={(e) => setStoreId(e.target.value)}
                          className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm">
                          {stores.map((s) => <option key={s.id} value={s.id}>{s.store_url}</option>)}
                        </select>
                      </div>
                    ) : <p className="text-sm text-muted-foreground">{store.store_url}</p>}
                    {!store.https ? <p role="alert" className="text-sm text-destructive">{t("wooHttps")}</p> : (
                      <>
                        <p className="text-xs text-muted-foreground">{t("wooKeyHelp")}</p>
                        <div className="grid gap-2 @container sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor="pi-key">{t("consumerKey")}</Label>
                            <Input id="pi-key" value={key} onChange={(e) => setKey(e.target.value)} autoComplete="off" spellCheck={false} placeholder="ck_…" />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor="pi-secret">{t("consumerSecret")}</Label>
                            <Input id="pi-secret" type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" spellCheck={false} placeholder="cs_…" />
                          </div>
                        </div>
                        <div className="flex justify-end">
                          <Button disabled={busy || active || !key.trim() || !secret.trim()}
                            onClick={() => void start({ platform: "woocommerce", store_id: store.id, consumer_key: key.trim(), consumer_secret: secret.trim() })}>
                            {busy && <Loader2 className="h-4 w-4 animate-spin" />} {t("start")}
                          </Button>
                        </div>
                      </>
                    )}
                  </div>
                )}
              </section>

              {status.imports.slice(0, 3).map((j) => <ImportCard key={j.id} job={j} onCancel={() => void cancel(j.id)} />)}
            </>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>{t("close")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportCard({ job, onCancel }: { job: PlatformImportView; onCancel: () => void }) {
  const t = useTranslations("Commerce.catalogue.platform");
  const tc = useTranslations("Commerce.catalogue.csv");
  const running = job.status === "queued" || job.status === "running";
  const fieldName = (f: string) => (t.has(`fields.${f}`) ? t(`fields.${f}`) : tc.has(`fields.${f}`) ? tc(`fields.${f}`) : f);
  const codeName = (c: string) => (t.has(`codes.${c}`) ? t(`codes.${c}`) : tc.has(`codes.${c}`) ? tc(`codes.${c}`) : tc("codes.invalid"));
  return (
    <div className="space-y-2 rounded-lg border border-border p-3 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">{job.platform === "shopify" ? "Shopify" : "WooCommerce"} · {t(`job.${job.status}`)}</span>
        {running && (
          <Button size="sm" variant="outline" disabled={job.cancel_requested} onClick={onCancel}>
            {job.cancel_requested ? t("stopping") : t("cancel")}
          </Button>
        )}
      </div>
      <p className="truncate text-xs text-muted-foreground">{job.source_url}</p>
      <ul className="grid grid-cols-2 gap-2 @container sm:grid-cols-5">
        {(["pages_done", "created_count", "updated_count", "skipped_count", "error_count"] as const).map((k) => (
          <li key={k} className="rounded-lg border border-border p-2 text-xs">
            <b className="block text-base tabular-nums">{job[k]}</b>{t(`stats.${k}`)}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground tabular-nums">{t("seen", { count: job.products_seen })}</p>
      {running && <progress className="h-2 w-full" aria-label={t("job.running")} />}
      {job.error_code && (
        <p role={job.status === "failed" ? "alert" : "status"} className={job.status === "failed" ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
          {t.has(`jobErrors.${job.error_code}`) ? t(`jobErrors.${job.error_code}`) : t("jobErrors.import_failed")}
        </p>
      )}
      {!running && job.errors.length > 0 && (
        <div className="max-h-56 overflow-auto rounded-lg border border-border">
          <Table>
            <TableHeader>
              <TableRow><TableHead>{t("colProduct")}</TableHead><TableHead>{tc("colColumn")}</TableHead><TableHead>{tc("colProblem")}</TableHead></TableRow>
            </TableHeader>
            <TableBody>
              {job.errors.map((e, i) => (
                <TableRow key={`${e.row}-${e.field}-${i}`}>
                  <TableCell className="tabular-nums">{e.row}</TableCell>
                  <TableCell>{fieldName(e.field)}</TableCell>
                  <TableCell>{codeName(e.code)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
