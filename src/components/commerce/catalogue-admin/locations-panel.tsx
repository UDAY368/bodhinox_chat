"use client";

/**
 * Stock locations and transfers (store plan Phase 8). Every location with the units it holds, a form
 * to add one, and a transfer form: pick a variant, see what each location holds, move a quantity.
 * Admins with the commerce.inventory permission manage; the server enforces it. A transfer carries a
 * key made once per filled-in form, so a double click or a retry never moves the stock twice.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, Search } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  createLocation, fetchInventory, fetchLocations, fetchTransfers, fetchVariantLocations, transferStock, updateLocation,
  type InventoryRow, type LocationQuantity, type StockLocation, type StockTransfer,
} from "./catalogue-api";
import { useCatalogueError } from "./catalogue-admin";
import { OptionSelect } from "@/components/commerce/option-select";
import { PageLoading } from "@/components/ui/page-loading";

export const variantLabel = (row: Pick<InventoryRow, "product_name" | "option_values" | "sku">) =>
  [row.product_name, Object.values(row.option_values).join(" / "), row.sku].filter(Boolean).join(" · ");

/** Search tracked variants by name or SKU and pick one. */
export function VariantPicker({ onPick, label }: { onPick: (row: InventoryRow) => void; label: string }) {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<InventoryRow[]>([]);
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      fetchInventory({ q, limit: 20 }).then((r) => { if (!cancelled) setRows(r.ok ? r.data.items : []); });
    }, 250);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [q]);
  return (
    <div className="space-y-1">
      <div className="relative">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={label} aria-label={label} className="pl-8" />
      </div>
      <ul className="max-h-40 divide-y overflow-y-auto rounded-lg border border-border text-sm">
        {rows.map((row) => (
          <li key={row.variant_id}>
            <button type="button" className="flex w-full justify-between gap-3 px-3 py-1.5 text-left hover:bg-muted" onClick={() => onPick(row)}>
              <span className="truncate">{variantLabel(row)}</span>
              <span className="tabular-nums text-muted-foreground">{row.on_hand}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function LocationsPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.locations");
  const locale = useLocale();
  const errorText = useCatalogueError();
  const [locations, setLocations] = useState<StockLocation[] | null>(null);
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    const [l, tr] = await Promise.all([fetchLocations(), fetchTransfers()]);
    setLocations(l.ok ? l.data : []);
    if (tr.ok) setTransfers(tr.data);
  }, []);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount
    void reload();
  }, [reload]);

  const add = async () => {
    if (!name.trim()) return;
    setBusy(true);
    const r = await createLocation(name.trim());
    setBusy(false);
    if (!r.ok) return void toast.error(errorText(r));
    setName("");
    await reload();
  };
  const toggle = async (location: StockLocation) => {
    const r = await updateLocation(location.id, { active: !location.active });
    if (!r.ok) toast.error(errorText(r));
    await reload();
  };
  const nameOf = (id: string) => locations?.find((l) => l.id === id)?.name ?? "";

  if (locations === null) return <PageLoading rows={3} />;
  return (
    <section className="space-y-6">
      <div className="space-y-2">
        <p className="max-w-2xl text-sm text-muted-foreground">{t("help")}</p>
        <ul className="divide-y rounded-xl border border-border bg-card text-sm">
          {locations.map((l) => (
            <li key={l.id} className="flex flex-wrap items-center justify-between gap-2 px-3.5 py-2.5">
              <span className="flex items-center gap-2">
                <span className="font-medium">{l.name}</span>
                {l.is_default && <Badge variant="secondary">{t("default")}</Badge>}
                {!l.active && <Badge variant="outline">{t("inactive")}</Badge>}
              </span>
              <span className="flex items-center gap-3">
                <span className="tabular-nums text-muted-foreground">{t("units", { count: l.units })}</span>
                {canManage && !l.is_default && (
                  <Button size="sm" variant="ghost" onClick={() => void toggle(l)}>{l.active ? t("turnOff") : t("turnOn")}</Button>
                )}
              </span>
            </li>
          ))}
        </ul>
        {canManage && (
          <form className="flex max-w-md gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
            <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("newName")} aria-label={t("newName")} />
            <Button type="submit" variant="outline" disabled={busy || !name.trim()}>{t("add")}</Button>
          </form>
        )}
      </div>

      {canManage && locations.filter((l) => l.active).length > 1 && <TransferForm locations={locations.filter((l) => l.active)} onDone={reload} />}

      <div className="space-y-2">
        <h2 className="text-base font-semibold tracking-tight text-foreground">{t("recent")}</h2>
        {transfers.length === 0 ? <p className="text-sm text-muted-foreground">{t("noTransfers")}</p> : (
          <ul className="divide-y rounded-xl border border-border bg-card text-sm">
            {transfers.map((tr) => (
              <li key={tr.id} className="flex flex-wrap justify-between gap-2 px-3.5 py-2">
                <span className="truncate">{tr.product_name} <span className="font-mono text-xs text-muted-foreground">{tr.sku}</span></span>
                <span className="text-muted-foreground">
                  {t("moved", { quantity: tr.quantity, from: nameOf(tr.from_location_id), to: nameOf(tr.to_location_id) })} ·{" "}
                  {new Date(tr.created_at).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function TransferForm({ locations, onDone }: { locations: StockLocation[]; onDone: () => Promise<void> }) {
  const t = useTranslations("Commerce.locations");
  const errorText = useCatalogueError();
  const [variant, setVariant] = useState<InventoryRow | null>(null);
  const [held, setHeld] = useState<LocationQuantity[]>([]);
  const [from, setFrom] = useState(locations[0].id);
  const [to, setTo] = useState(locations[1].id);
  const [quantity, setQuantity] = useState("");
  const [busy, setBusy] = useState(false);
  // One key per filled-in form: a retry of the same transfer is a no-op on the server.
  const key = useRef<string>(crypto.randomUUID());
  const fresh = () => { key.current = crypto.randomUUID(); };

  const loadHeld = useCallback(async (variantId: string) => {
    const r = await fetchVariantLocations(variantId);
    setHeld(r.ok ? r.data : []);
  }, []);
  const qty = Number(quantity);
  const valid = variant !== null && from !== to && /^\d{1,7}$/.test(quantity.trim()) && qty > 0;

  const submit = async () => {
    if (!variant || !valid) return;
    setBusy(true);
    const r = await transferStock({ client_key: key.current, from_location_id: from, to_location_id: to, variant_id: variant.variant_id, quantity: qty });
    setBusy(false);
    if (!r.ok) return void toast.error(errorText(r));
    toast.success(t("transferred"));
    fresh();
    setQuantity("");
    await Promise.all([loadHeld(variant.variant_id), onDone()]);
  };

  return (
    <div className="space-y-3 rounded-xl border border-border bg-card p-4">
      <h2 className="text-base font-semibold tracking-tight text-foreground">{t("transferTitle")}</h2>
      {variant ? (
        <div className="space-y-1 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium">{variantLabel(variant)}</span>
            <Button size="sm" variant="ghost" onClick={() => { setVariant(null); setHeld([]); fresh(); }}>{t("change")}</Button>
          </div>
          <p className="text-muted-foreground">{held.filter((h) => h.quantity > 0 || h.is_default).map((h) => `${h.name}: ${h.quantity}`).join(" · ")}</p>
        </div>
      ) : (
        <VariantPicker label={t("pickVariant")} onPick={(row) => { setVariant(row); fresh(); void loadHeld(row.variant_id); }} />
      )}
      <form className="grid gap-3 sm:grid-cols-4" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="space-y-1">
          <Label htmlFor="tr-from">{t("from")}</Label>
          <OptionSelect
            id="tr-from"
            value={from}
            onValueChange={(v) => { setFrom(v); fresh(); }}
            className="w-full"
            options={[
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tr-to">{t("to")}</Label>
          <OptionSelect
            id="tr-to"
            value={to}
            onValueChange={(v) => { setTo(v); fresh(); }}
            className="w-full"
            options={[
              ...locations.map((l) => ({ value: l.id, label: l.name })),
            ]}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="tr-qty">{t("quantity")}</Label>
          <Input id="tr-qty" inputMode="numeric" value={quantity} onChange={(e) => { setQuantity(e.target.value); fresh(); }} />
        </div>
        <Button type="submit" className="self-end" disabled={busy || !valid}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{t("transfer")}</Button>
      </form>
    </div>
  );
}
