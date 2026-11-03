"use client";

/** Catalogue categories, at most two levels deep. Admins add, rename, move and archive. */

import { useCallback, useEffect, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchCategories, saveCategory, type ShopCategory } from "./catalogue-api";
import { selectClass, useCatalogueError } from "./catalogue-admin";

export function CategoriesPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.catalogue.categories");
  const errorText = useCatalogueError();
  const [items, setItems] = useState<ShopCategory[] | null>(null);
  const [name, setName] = useState("");
  const [parent, setParent] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const r = await fetchCategories();
    setItems(r.ok ? r.data : []);
    if (!r.ok) toast.error(errorText(r));
  }, [errorText]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other dashboard panels do
    void load();
  }, [load]);

  const run = async (call: ReturnType<typeof saveCategory>, success?: string) => {
    setBusy(true);
    const r = await call;
    setBusy(false);
    if (!r.ok) { toast.error(errorText(r)); return false; }
    if (success) toast.success(success);
    await load();
    return true;
  };

  const add = async () => {
    if (!name.trim()) return;
    if (await run(saveCategory(null, { name: name.trim(), parent_id: parent || null }), t("saved"))) { setName(""); setParent(""); }
  };

  if (items === null) return <div className="flex justify-center p-6"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;
  const tops = items.filter((c) => !c.parent_id && !c.archived);
  const ordered = items.filter((c) => !c.parent_id).flatMap((top) => [top, ...items.filter((c) => c.parent_id === top.id)]);

  return (
    <section className="space-y-4">
      {canManage && (
        <form className="flex flex-wrap items-center gap-2" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder={t("name")} aria-label={t("name")} className="max-w-xs bg-muted" />
          <select aria-label={t("parent")} className={selectClass} value={parent} onChange={(e) => setParent(e.target.value)}>
            <option value="">{t("none")}</option>
            {tops.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <Button type="submit" disabled={busy || !name.trim()}><Plus className="h-4 w-4" />{t("add")}</Button>
        </form>
      )}
      {ordered.length === 0 ? (
        <p className="rounded-lg border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border bg-card">
          {ordered.map((c) => (
            <CategoryRow key={c.id} category={c} tops={tops} canManage={canManage} busy={busy}
              onSave={(body) => run(saveCategory(c.id, body), t("saved"))} />
          ))}
        </ul>
      )}
    </section>
  );
}

function CategoryRow({ category, tops, canManage, busy, onSave }: {
  category: ShopCategory; tops: ShopCategory[]; canManage: boolean; busy: boolean;
  onSave: (body: { name?: string; parent_id?: string | null; archived?: boolean }) => Promise<boolean>;
}) {
  const t = useTranslations("Commerce.catalogue.categories");
  const [name, setName] = useState(category.name);
  return (
    <li className={`flex flex-wrap items-center gap-2 px-3 py-2 ${category.parent_id ? "pl-8" : ""}`}>
      {canManage ? (
        <Input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} aria-label={t("name")}
          onBlur={() => { if (name.trim() && name.trim() !== category.name) void onSave({ name: name.trim() }); }}
          className="h-8 max-w-xs bg-muted" />
      ) : (
        <span className="text-sm text-foreground">{category.name}</span>
      )}
      <span className="text-xs text-muted-foreground">{t("products", { count: category.product_count })}</span>
      {category.archived && <Badge variant="outline">{t("archived")}</Badge>}
      {canManage && (
        <span className="ml-auto flex items-center gap-2">
          <select aria-label={t("parent")} className={`${selectClass} h-8`} value={category.parent_id ?? ""} disabled={busy}
            onChange={(e) => void onSave({ parent_id: e.target.value || null })}>
            <option value="">{t("none")}</option>
            {tops.filter((top) => top.id !== category.id).map((top) => <option key={top.id} value={top.id}>{top.name}</option>)}
          </select>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => void onSave({ archived: !category.archived })}>
            {category.archived ? t("restore") : t("archive")}
          </Button>
        </span>
      )}
    </li>
  );
}
