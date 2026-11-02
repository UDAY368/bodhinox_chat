"use client";

/**
 * Linked catalogues: one card per catalogue with its number, product count,
 * last sync and switches, plus "Connect catalogue". Every member sees them;
 * connecting, switching, syncing and unlinking are for admins (the API and
 * RLS enforce the same rule).
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Store, Unlink } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { GatedButton } from "@/components/ui/gated-button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { authFetch } from "@/lib/auth/client";
import {
  connectCatalog,
  deleteCatalog,
  fetchCatalogs,
  fetchMetaCatalogs,
  syncCatalog,
  updateCatalog,
  type CatalogPublic,
  type MetaCatalogChoice,
} from "./catalog-api";

interface NumberOption {
  id: string;
  display_name: string | null;
  phone_number_id: string;
  removed?: boolean;
}

const SYNC_ERRORS = ["number_unavailable", "token", "not_found", "unavailable", "too_many_products"];

export function CatalogManager({ canManage, onChanged }: { canManage: boolean; onChanged: (catalogs: CatalogPublic[]) => void }) {
  const t = useTranslations("Commerce.catalog.manager");
  const tGate = useTranslations("GatedButton");
  const format = useFormatter();
  const [catalogs, setCatalogs] = useState<CatalogPublic[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [connectOpen, setConnectOpen] = useState(false);
  const [unlinking, setUnlinking] = useState<CatalogPublic | null>(null);

  const reload = useCallback(async () => {
    try {
      setCatalogs(await fetchCatalogs());
    } catch {
      setCatalogs((prev) => prev ?? []);
      toast.error(t("loadError"));
    }
  }, [t]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // The products filter lists the same catalogues.
  useEffect(() => {
    if (catalogs) onChanged(catalogs);
  }, [catalogs, onChanged]);

  const replace = (row: CatalogPublic) => {
    setCatalogs((prev) => ((prev ?? []).some((c) => c.id === row.id) ? (prev ?? []).map((c) => (c.id === row.id ? row : c)) : [...(prev ?? []), row]));
  };

  async function toggle(catalog: CatalogPublic, field: "is_cart_enabled" | "is_catalog_visible", value: boolean) {
    setBusy(catalog.id);
    try {
      const res = await updateCatalog(catalog.id, { [field]: value });
      if (!res.ok) throw new Error(res.error);
      replace(res.data);
      toast.success(t("settingsSaved"));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t("settingsError"));
    } finally {
      setBusy(null);
    }
  }

  async function sync(catalog: CatalogPublic) {
    setBusy(catalog.id);
    try {
      const res = await syncCatalog(catalog.id);
      if (!res.ok) throw new Error(res.error);
      toast.success(t("syncQueued"));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t("syncError"));
    } finally {
      setBusy(null);
    }
  }

  async function confirmUnlink() {
    if (!unlinking) return;
    const target = unlinking;
    setBusy(target.id);
    try {
      const res = await deleteCatalog(target.id);
      if (!res.ok) throw new Error(res.error);
      setCatalogs((prev) => (prev ?? []).filter((c) => c.id !== target.id));
      setUnlinking(null);
      toast.success(t("unlinked"));
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : t("unlinkError"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="space-y-3" aria-labelledby="catalogs-heading">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="catalogs-heading" className="text-base font-medium text-foreground">{t("title")}</h2>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => void reload()}>
            <RefreshCw className="h-3.5 w-3.5" />
            {t("refresh")}
          </Button>
          <GatedButton size="sm" canAct={canManage} gateReason={tGate("reasons.manageCatalogs")} onClick={() => setConnectOpen(true)}>
            <Plus className="h-3.5 w-3.5" />
            {t("connect")}
          </GatedButton>
        </div>
      </div>

      {catalogs === null ? (
        <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-label={t("loading")} /></div>
      ) : catalogs.length === 0 ? (
        <div className="flex flex-col items-center rounded-lg border border-dashed border-border bg-card/50 px-6 py-10 text-center">
          <Store className="h-6 w-6 text-muted-foreground" />
          <p className="mt-3 text-sm font-medium text-foreground">{t("emptyTitle")}</p>
          <p className="mt-1 max-w-md text-xs text-muted-foreground">{t("emptyDesc")}</p>
        </div>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2">
          {catalogs.map((catalog) => (
            <li key={catalog.id} className="space-y-3 rounded-lg border border-border bg-card p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-medium text-foreground">{catalog.name || catalog.catalog_id}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {catalog.number_label ? t("onNumber", { number: catalog.number_label }) : t("noNumber")}
                  </p>
                </div>
                <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{t("productCount", { count: catalog.product_count })}</span>
              </div>
              <p className="text-xs text-muted-foreground">
                {catalog.last_synced_at
                  ? t("lastSynced", { when: format.dateTime(new Date(catalog.last_synced_at), { dateStyle: "medium", timeStyle: "short" }) })
                  : t("neverSynced")}
              </p>
              {catalog.sync_error && (
                <p role="status" className="text-xs text-destructive">
                  {SYNC_ERRORS.includes(catalog.sync_error) ? t(`syncErrors.${catalog.sync_error}`) : t("syncErrors.unavailable")}
                </p>
              )}
              <div className="flex flex-wrap gap-4">
                <div className="flex items-center gap-2">
                  <Switch id={`cart-${catalog.id}`} checked={catalog.is_cart_enabled} disabled={!canManage || busy === catalog.id}
                    onCheckedChange={(checked) => void toggle(catalog, "is_cart_enabled", checked)} />
                  <Label htmlFor={`cart-${catalog.id}`} className="text-xs">{t("cart")}</Label>
                </div>
                <div className="flex items-center gap-2">
                  <Switch id={`visible-${catalog.id}`} checked={catalog.is_catalog_visible} disabled={!canManage || busy === catalog.id}
                    onCheckedChange={(checked) => void toggle(catalog, "is_catalog_visible", checked)} />
                  <Label htmlFor={`visible-${catalog.id}`} className="text-xs">{t("visible")}</Label>
                </div>
              </div>
              <div className="flex gap-2">
                <GatedButton size="sm" variant="outline" canAct={canManage} gateReason={tGate("reasons.manageCatalogs")}
                  disabled={busy === catalog.id} onClick={() => void sync(catalog)}>
                  {busy === catalog.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {t("syncNow")}
                </GatedButton>
                <GatedButton size="sm" variant="ghost" canAct={canManage} gateReason={tGate("reasons.manageCatalogs")}
                  className="text-destructive hover:bg-destructive/10" disabled={busy === catalog.id} onClick={() => setUnlinking(catalog)}>
                  <Unlink className="h-3.5 w-3.5" />
                  {t("unlink")}
                </GatedButton>
              </div>
            </li>
          ))}
        </ul>
      )}

      <ConnectCatalogDialog open={connectOpen} onOpenChange={setConnectOpen} onConnected={(row) => { replace(row); setConnectOpen(false); }} />

      <Dialog open={unlinking !== null} onOpenChange={(open) => !open && setUnlinking(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("unlinkTitle")}</DialogTitle>
            <DialogDescription>{t("unlinkDesc", { name: unlinking?.name || unlinking?.catalog_id || "" })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setUnlinking(null)} disabled={busy !== null}>{t("cancel")}</Button>
            <Button variant="destructive" onClick={() => void confirmUnlink()} disabled={busy !== null}>
              {busy !== null && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("unlinkConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ConnectCatalogDialog({ open, onOpenChange, onConnected }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (row: CatalogPublic) => void;
}) {
  const t = useTranslations("Commerce.catalog.connect");
  const [numbers, setNumbers] = useState<NumberOption[] | null>(null);
  const [numberId, setNumberId] = useState("");
  const [choices, setChoices] = useState<MetaCatalogChoice[] | null>(null);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [catalogId, setCatalogId] = useState("");
  const [cart, setCart] = useState(true);
  const [visible, setVisible] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setNumberId("");
    setCatalogId("");
    setChoices(null);
    setError(null);
    let cancelled = false;
    authFetch("/api/whatsapp/numbers?connected=1", { cache: "no-store" })
      .then(async (res) => (res.ok ? ((await res.json()) as { numbers?: NumberOption[] }).numbers ?? [] : []))
      .catch(() => [] as NumberOption[])
      .then((rows) => !cancelled && setNumbers(rows.filter((n) => !n.removed)));
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!numberId) return;
    let cancelled = false;
    setChoices(null);
    setChoicesError(null);
    setCatalogId("");
    fetchMetaCatalogs(numberId).then((res) => {
      if (cancelled) return;
      if (res.ok) setChoices(res.data);
      else {
        setChoices([]);
        setChoicesError(res.error ?? t("loadError"));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [numberId, t]);

  async function submit() {
    if (!numberId || !catalogId || saving) return;
    setSaving(true);
    setError(null);
    try {
      const res = await connectCatalog({ whatsapp_config_id: numberId, catalog_id: catalogId, is_cart_enabled: cart, is_catalog_visible: visible });
      if (!res.ok) {
        setError(res.error ?? t("error"));
        return;
      }
      toast.success(t("connected"));
      onConnected(res.data);
    } catch {
      setError(t("error"));
    } finally {
      setSaving(false);
    }
  }

  const select = "h-9 w-full rounded-md border border-border bg-muted px-2 text-sm text-foreground";
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="catalog-connect-number">{t("number")}</Label>
            <select id="catalog-connect-number" className={select} value={numberId} onChange={(e) => setNumberId(e.target.value)} disabled={numbers === null}>
              <option value="">{numbers === null ? t("loading") : numbers.length ? t("pickNumber") : t("noNumbers")}</option>
              {(numbers ?? []).map((n) => <option key={n.id} value={n.id}>{n.display_name || n.phone_number_id}</option>)}
            </select>
          </div>
          {numberId && (
            <div className="space-y-1.5">
              <Label htmlFor="catalog-connect-catalog">{t("catalog")}</Label>
              <select id="catalog-connect-catalog" className={select} value={catalogId} onChange={(e) => setCatalogId(e.target.value)} disabled={choices === null}>
                <option value="">{choices === null ? t("loading") : choices.length ? t("pickCatalog") : t("noCatalogs")}</option>
                {(choices ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{c.linked ? t("linkedOption", { name: c.name || c.id }) : c.name || c.id}</option>
                ))}
              </select>
              {choicesError && <p role="alert" className="text-xs text-destructive">{choicesError}</p>}
            </div>
          )}
          <div className="flex items-center gap-2">
            <Switch id="catalog-connect-cart" checked={cart} onCheckedChange={setCart} />
            <Label htmlFor="catalog-connect-cart">{t("cart")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Switch id="catalog-connect-visible" checked={visible} onCheckedChange={setVisible} />
            <Label htmlFor="catalog-connect-visible">{t("visible")}</Label>
          </div>
          <p className="text-xs text-muted-foreground">{t("help")}</p>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>{t("cancel")}</Button>
          <Button onClick={() => void submit()} disabled={!numberId || !catalogId || saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
