"use client";

/**
 * Commerce → Catalogue → Collections (store plan Phase 4): groups of products
 * on the public shop at /s/<handle>/collections/<slug>. A manual collection
 * lists products an admin picked; a smart one holds up to ten rules (tag,
 * brand, type, category, price, on sale) and shows a live count. Agents read;
 * admins edit (the API and RLS enforce it).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useConfirm } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  COLLECTION_SORTS, MAX_RULES, RULE_FIELDS, RULE_FIELD_NAMES, slugify, type RuleField,
} from "@/lib/commerce/catalogue/collection-rules";
import {
  deleteCollection, fetchCategories, fetchCollection, fetchCollections, fetchShopProducts, previewCollection, saveCollection,
  type CollectionBody, type CollectionRule, type ShopCategory, type ShopCollection, type ShopCollectionDetail,
} from "./catalogue-api";
import { useCatalogueError } from "./catalogue-admin";
import { moneyInput, moneyText } from "./catalogue-format";
import { OptionSelect } from "@/components/commerce/option-select";
import { Checkbox } from "@/components/ui/checkbox";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { PageLoading } from "@/components/ui/page-loading";

/** A rule as typed: every value is text until it is turned into the API shape. */
interface DraftRule { field: RuleField; op: string; value: string }

const emptyRule = (): DraftRule => ({ field: "tag", op: "eq", value: "" });

function toDraft(rule: CollectionRule, currency: string | null): DraftRule {
  if (rule.field === "price") return { field: "price", op: rule.op, value: moneyText(rule.value, currency) };
  return { field: rule.field, op: rule.op, value: String(rule.value) };
}

/** The API rule for a draft, or null while it is incomplete. */
function toRule(d: DraftRule, currency: string | null): CollectionRule | null {
  const value = d.value.trim();
  switch (d.field) {
    case "price": {
      const minor = moneyInput(value, currency);
      return typeof minor === "number" && (d.op === "gt" || d.op === "lt") ? { field: "price", op: d.op, value: minor } : null;
    }
    case "on_sale": return value === "true" || value === "false" ? { field: "on_sale", op: "is", value: value === "true" } : null;
    case "category": return value && (d.op === "eq" || d.op === "neq") ? { field: "category", op: d.op, value } : null;
    default: return value && (d.op === "eq" || d.op === "neq") ? { field: d.field, op: d.op, value } : null;
  }
}

export function CollectionsPanel({ canManage }: { canManage: boolean }) {
  const t = useTranslations("Commerce.catalogue.collections");
  const errorText = useCatalogueError();
  const [items, setItems] = useState<ShopCollection[] | null>(null);
  const [editing, setEditing] = useState<ShopCollectionDetail | "new" | null>(null);
  const [categories, setCategories] = useState<ShopCategory[]>([]);
  const [currency, setCurrency] = useState<string | null>(null);

  const load = useCallback(async () => {
    const r = await fetchCollections();
    setItems(r.ok ? r.data : []);
    if (!r.ok) toast.error(errorText(r));
  }, [errorText]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- load on mount, as the other dashboard panels do
    void load();
    void fetchCategories().then((r) => { if (r.ok) setCategories(r.data); });
    void fetchShopProducts({ limit: 1 }).then((r) => { if (r.ok) setCurrency(r.data.currency); });
  }, [load]);

  const open = async (id: string) => {
    const r = await fetchCollection(id);
    if (r.ok) setEditing(r.data); else toast.error(errorText(r));
  };

  if (items === null) return <PageLoading rows={3} />;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">{t("description")}</p>
        {canManage && <Button className="ml-auto" onClick={() => setEditing("new")}><Plus className="h-4 w-4" />{t("new")}</Button>}
      </div>
      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-muted-foreground">{t("empty")}</p>
      ) : (
        <ul className="divide-y divide-border rounded-xl border border-border bg-card">
          {items.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2 px-3 py-2">
              <span className="text-sm font-medium text-foreground">{c.title}</span>
              <Badge variant="outline">{t(`kinds.${c.kind}`)}</Badge>
              <Badge variant={c.published ? "default" : "secondary"}>{c.published ? t("published") : t("draft")}</Badge>
              <span className="text-xs text-muted-foreground">{t("products", { count: c.product_count })}</span>
              <span className="font-mono text-xs text-muted-foreground">/collections/{c.slug}</span>
              <Button size="sm" variant="ghost" className="ml-auto" onClick={() => void open(c.id)}>
                <Pencil className="h-4 w-4" />{canManage ? t("edit") : t("view")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <CollectionDialog key={editing === "new" ? "new" : editing.id} collection={editing === "new" ? null : editing} canManage={canManage}
          categories={categories} currency={currency} onClose={() => setEditing(null)} onChanged={() => { setEditing(null); void load(); }} />
      )}
    </section>
  );
}

function CollectionDialog({ collection, canManage, categories, currency, onClose, onChanged }: {
  collection: ShopCollectionDetail | null; canManage: boolean; categories: ShopCategory[]; currency: string | null;
  onClose: () => void; onChanged: () => void;
}) {
  const t = useTranslations("Commerce.catalogue.collections");
  const errorText = useCatalogueError();
  const [title, setTitle] = useState(collection?.title ?? "");
  const [slug, setSlug] = useState(collection?.slug ?? "");
  const [description, setDescription] = useState(collection?.description ?? "");
  const [kind, setKind] = useState<"manual" | "smart">(collection?.kind ?? "manual");
  const [match, setMatch] = useState<"all" | "any">(collection?.match ?? "all");
  const [sort, setSort] = useState<string>(collection?.sort ?? "featured");
  const [published, setPublished] = useState(collection?.published ?? false);
  const [rules, setRules] = useState<DraftRule[]>(() => (collection?.rules ?? []).map((r) => toDraft(r, currency)));
  const [picked, setPicked] = useState<Array<{ id: string; name: string }>>(() => (collection?.products ?? []).map((p) => ({ id: p.id, name: p.name })));
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();
  const ro = !canManage;

  const apiRules = useMemo(() => rules.map((r) => toRule(r, currency)), [rules, currency]);
  const rulesOk = apiRules.every((r) => r !== null);
  const smartOk = kind === "manual" || (rules.length > 0 && rulesOk);
  const valid = title.trim().length > 0 && (slug === "" || /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) && smartOk;

  const body = (): CollectionBody => ({
    title: title.trim(), slug: slug || slugify(title), description: description.trim() || null, kind, match, sort, published,
    ...(kind === "smart" ? { rules: apiRules.filter((r): r is CollectionRule => r !== null) } : { product_ids: picked.map((p) => p.id) }),
  });

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    const r = await saveCollection(collection?.id ?? null, body());
    setBusy(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    toast.success(t("saved"));
    onChanged();
  };
  const remove = async () => {
    if (!collection) return;
    setBusy(true);
    const r = await deleteCollection(collection.id);
    setBusy(false);
    if (!r.ok) { toast.error(errorText(r)); return; }
    toast.success(t("deleted"));
    onChanged();
  };

  return (
    <Sheet open onOpenChange={(o) => { if (!o) onClose(); }}>
      <SheetContent size="lg" className="w-full gap-0">
        <SheetHeader>
          <SheetTitle>{collection ? collection.title : t("new")}</SheetTitle>
          <SheetDescription>{t("dialogHint")}</SheetDescription>
        </SheetHeader>
        <form className="flex min-h-0 flex-1 flex-col" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
          <div className="flex-1 space-y-4 overflow-y-auto px-4 pb-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="col-title">{t("name")}</Label>
              <Input id="col-title" value={title} maxLength={120} readOnly={ro} onChange={(e) => setTitle(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="col-slug">{t("slug")}</Label>
              <Input id="col-slug" className="font-mono" value={slug} maxLength={60} readOnly={ro} placeholder={slugify(title) || "summer-sale"}
                onChange={(e) => setSlug(e.target.value.toLowerCase())} />
              {slug !== "" && !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && <p className="text-xs text-destructive">{t("slugInvalid")}</p>}
            </div>
          </div>
          <div className="space-y-1">
            <Label htmlFor="col-desc">{t("descriptionLabel")}</Label>
            <Textarea id="col-desc" rows={3} maxLength={2000} value={description} readOnly={ro} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label>{t("kind")}</Label>
              <SegmentedControl
                aria-label={t("kind")}
                value={kind}
                onValueChange={(v) => setKind(v as "manual" | "smart")}
                options={[
                  { value: "manual", label: t("kinds.manual"), disabled: ro },
                  { value: "smart", label: t("kinds.smart"), disabled: ro },
                ]}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="col-sort">{t("sort")}</Label>
              <OptionSelect
                id="col-sort"
                value={sort}
                onValueChange={(v) => setSort(v)}
                disabled={ro}
                className="w-full"
                options={[
                  ...COLLECTION_SORTS.map((s) => ({ value: s, label: t(`sorts.${s}`) })),
                ]}
              />
            </div>
            <label className="flex items-center gap-2 self-end pb-2 text-sm">
              <Checkbox checked={published} disabled={ro} onCheckedChange={setPublished} />
              {t("publishedLabel")}
            </label>
          </div>

          {kind === "smart" ? (
            <SmartRules rules={rules} setRules={setRules} match={match} setMatch={setMatch} categories={categories} currency={currency} ro={ro} />
          ) : (
            <ManualProducts picked={picked} setPicked={setPicked} ro={ro} />
          )}
          <LivePreview kind={kind} match={match} apiRules={apiRules} rulesOk={rulesOk} productIds={picked.map((p) => p.id)} />
          </div>

          <SheetFooter className="gap-2 border-t border-border sm:flex-row sm:justify-between">
            {canManage && collection ? (
              <Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={async () => {
                if (await confirm({ title: t("deleteConfirm"), confirmLabel: t("deleteYes"), destructive: true })) void remove();
              }}><Trash2 className="h-4 w-4" />{t("delete")}</Button>
            ) : <span />}
            <span className="flex gap-2">
              <Button type="button" variant="outline" onClick={onClose}>{t("close")}</Button>
              {canManage && <Button type="submit" disabled={busy || !valid}>{t("save")}</Button>}
            </span>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function SmartRules({ rules, setRules, match, setMatch, categories, currency, ro }: {
  rules: DraftRule[]; setRules: (r: DraftRule[]) => void; match: "all" | "any"; setMatch: (m: "all" | "any") => void;
  categories: ShopCategory[]; currency: string | null; ro: boolean;
}) {
  const t = useTranslations("Commerce.catalogue.collections");
  const set = (i: number, patch: Partial<DraftRule>) => setRules(rules.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{t("rules")}</legend>
      <div className="flex items-center gap-2 text-sm">
        {t("matchPrefix")}
        <SegmentedControl
          aria-label={t("match")}
          value={match}
          onValueChange={(v) => setMatch(v as "all" | "any")}
          options={[
            { value: "all", label: t("matchAll"), disabled: ro },
            { value: "any", label: t("matchAny"), disabled: ro },
          ]}
        />
        {t("matchSuffix")}
      </div>
      {rules.length === 0 && <p className="text-xs text-muted-foreground">{t("noRules")}</p>}
      {rules.map((r, i) => (
        <div key={i} className="flex flex-wrap items-center gap-2">
          <OptionSelect
            aria-label={t("field")}
            value={r.field}
            onValueChange={(v) => { const field = v as RuleField; set(i, { field, op: RULE_FIELDS[field].ops[0], value: field === "on_sale" ? "true" : "" }); }}
            disabled={ro}
            options={[
              ...RULE_FIELD_NAMES.map((f) => ({ value: f, label: t(`fields.${f}`) })),
            ]}
          />
          <OptionSelect
            aria-label={t("operator")}
            value={r.op}
            onValueChange={(v) => set(i, { op: v })}
            disabled={ro}
            options={[
              ...(RULE_FIELDS[r.field].ops as readonly string[]).map((op) => ({ value: op, label: t(`ops.${op}`) })),
            ]}
          />
          {r.field === "category" ? (
            <OptionSelect
              aria-label={t("value")}
              value={r.value}
              onValueChange={(v) => set(i, { value: v })}
              disabled={ro}
              options={[
                { value: "", label: t("pickCategory") },
                ...categories.filter((c) => !c.archived).map((c) => ({ value: c.id, label: c.parent_id ? `— ${c.name}` : c.name })),
              ]}
            />
          ) : r.field === "on_sale" ? (
            <SegmentedControl
              aria-label={t("value")}
              value={r.value}
              onValueChange={(v) => set(i, { value: v })}
              options={[
                { value: "true", label: t("onSaleYes"), disabled: ro },
                { value: "false", label: t("onSaleNo"), disabled: ro },
              ]}
            />
          ) : (
            <Input aria-label={t("value")} className="h-9 w-44" value={r.value} maxLength={80} readOnly={ro} inputMode={r.field === "price" ? "decimal" : undefined}
              placeholder={r.field === "price" ? currency ?? "" : ""} onChange={(e) => set(i, { value: e.target.value })} />
          )}
          {!ro && <Button type="button" size="icon-sm" variant="ghost" aria-label={t("removeRule")} onClick={() => setRules(rules.filter((_, j) => j !== i))}><X className="h-4 w-4" /></Button>}
        </div>
      ))}
      {!ro && rules.length < MAX_RULES && (
        <Button type="button" variant="outline" size="sm" onClick={() => setRules([...rules, emptyRule()])}><Plus className="h-4 w-4" />{t("addRule")}</Button>
      )}
    </fieldset>
  );
}

function ManualProducts({ picked, setPicked, ro }: { picked: Array<{ id: string; name: string }>; setPicked: (p: Array<{ id: string; name: string }>) => void; ro: boolean }) {
  const t = useTranslations("Commerce.catalogue.collections");
  const [q, setQ] = useState("");
  const [results, setResults] = useState<Array<{ id: string; name: string }>>([]);
  useEffect(() => {
    if (ro) return;
    const timer = setTimeout(() => {
      void fetchShopProducts({ q, status: "published", limit: 8 }).then((r) => { if (r.ok) setResults(r.data.products.map((p) => ({ id: p.id, name: p.name }))); });
    }, 300);
    return () => clearTimeout(timer);
  }, [q, ro]);
  const move = (i: number, by: number) => {
    const next = [...picked];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setPicked(next);
  };
  return (
    <fieldset className="space-y-2 rounded-lg border border-border p-3">
      <legend className="px-1 text-sm font-medium text-foreground">{t("pickedProducts")}</legend>
      {picked.length === 0 && <p className="text-xs text-muted-foreground">{t("nonePicked")}</p>}
      <ul className="space-y-1">
        {picked.map((p, i) => (
          <li key={p.id} className="flex items-center gap-1 text-sm">
            <span className="min-w-0 flex-1 truncate">{p.name}</span>
            {!ro && (
              <>
                <Button type="button" size="icon-sm" variant="ghost" disabled={i === 0} aria-label={t("moveUp")} onClick={() => move(i, -1)}><ArrowUp className="h-4 w-4" /></Button>
                <Button type="button" size="icon-sm" variant="ghost" disabled={i === picked.length - 1} aria-label={t("moveDown")} onClick={() => move(i, 1)}><ArrowDown className="h-4 w-4" /></Button>
                <Button type="button" size="icon-sm" variant="ghost" aria-label={t("removeProduct")} onClick={() => setPicked(picked.filter((x) => x.id !== p.id))}><X className="h-4 w-4" /></Button>
              </>
            )}
          </li>
        ))}
      </ul>
      {!ro && (
        <div className="space-y-2">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("searchProducts")} aria-label={t("searchProducts")} />
          <ul className="space-y-1">
            {results.filter((r) => !picked.some((p) => p.id === r.id)).map((r) => (
              <li key={r.id} className="flex items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{r.name}</span>
                <Button type="button" size="sm" variant="outline" disabled={picked.length >= 200} onClick={() => setPicked([...picked, r])}>{t("addProduct")}</Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </fieldset>
  );
}

function LivePreview({ kind, match, apiRules, rulesOk, productIds }: {
  kind: "manual" | "smart"; match: "all" | "any"; apiRules: Array<CollectionRule | null>; rulesOk: boolean; productIds: string[];
}) {
  const t = useTranslations("Commerce.catalogue.collections");
  const [state, setState] = useState<{ count: number; sample: string[] } | "error" | null>(null);
  const key = JSON.stringify([kind, match, apiRules, productIds]);
  useEffect(() => {
    if (kind === "smart" && (!rulesOk || apiRules.length === 0)) return;
    let live = true;
    const timer = setTimeout(() => {
      const body: CollectionBody = kind === "smart"
        ? { kind, match, rules: apiRules.filter((r): r is CollectionRule => r !== null) } : { kind, product_ids: productIds };
      void previewCollection(body).then((r) => { if (live) setState(r.ok ? { count: r.data.count, sample: r.data.sample.map((s) => s.name) } : "error"); });
    }, 400);
    return () => { live = false; clearTimeout(timer); };
    // The key stands for the inputs it was built from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  if (kind === "smart" && (!rulesOk || apiRules.length === 0)) return <p className="text-xs text-muted-foreground" role="status">{t("previewIncomplete")}</p>;
  if (state === null) return <p className="text-xs text-muted-foreground" role="status">{t("previewLoading")}</p>;
  if (state === "error") return <p className="text-xs text-destructive" role="status">{t("previewFailed")}</p>;
  return (
    <p className="text-sm" role="status">
      <span className="font-medium">{t("previewCount", { count: state.count })}</span>
      {state.sample.length > 0 && <span className="text-muted-foreground"> · {state.sample.join(", ")}{state.count > state.sample.length ? "…" : ""}</span>}
    </p>
  );
}
