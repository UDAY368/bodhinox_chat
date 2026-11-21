"use client";

/**
 * Commerce → Online store → Edit theme (store plan Phase 2): the public
 * shop's theme editor. Sections and their blocks (add, hide, reorder by drag
 * or arrows, remove), template and brand, top menu and footer, store pages
 * and policy notes, with a live preview in phone and desktop widths that
 * renders the shop's own components from the draft. "Save draft" never
 * changes the live shop; "Publish" does, and keeps a version to go back to.
 * Admins edit; agents look (the API and RLS enforce the same rule). Every
 * value is validated again on the server (shop-sections.ts).
 */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import {
  ArrowDown, ArrowLeft, ArrowUp, Eye, EyeOff, GripVertical, ImageIcon, Loader2, Monitor, Plus, Smartphone, Trash2,
} from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { MediaPicker } from "@/components/inbox/media-library/media-picker";
import { TemplateGallery } from "./template-gallery";
import { ShopFrameView } from "@/components/shop-public/shop-frame";
import type { ShopT } from "@/components/shop-public/shop-link";
import { ShopPageView } from "@/components/shop-public/shop-page";
import { ShopSectionsView } from "@/components/shop-public/shop-sections";
import type { ThemeEditorView } from "@/lib/commerce/shop-theme";
import {
  contentOf, newSection, pagesOn, POLICY_SLUGS, SECTION_SPECS, SHOP_CONTENT_LIMITS, SHOP_PAGE_SLUGS, SHOP_SECTION_TYPES,
  type FieldValues, type ShopDocument, type ShopField, type ShopMenuLink, type ShopPageSlug, type ShopSection, type ShopSectionType,
} from "@/lib/commerce/shop-sections";
import {
  resolveTheme, SHOP_COLOR_KEYS, SHOP_FONT_IDS, SHOP_FONTS, SHOP_TEMPLATES, SHOP_TEXT_LIMITS,
  type ShopColors, type ShopThemeSettings,
} from "@/lib/commerce/shop-templates";
import { OptionSelect } from "@/components/ui/option-select";
import { SegmentedControl } from "@/components/ui/segmented-control";

type Tab = "sections" | "theme" | "menu" | "pages" | "history";
type Device = "phone" | "desktop";
type PickTarget = (ref: string) => void;

const newId = () => Math.random().toString(36).slice(2, 10).padEnd(6, "0");

/** A stored UTC moment as a datetime-local value in this browser's time zone, and back. */
const toLocalInput = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
};
const fromLocalInput = (value: string) => {
  const d = new Date(value);
  return value && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

function Field({ id, label, hint, children }: { id: string; label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ThemeEditor() {
  const t = useTranslations("Commerce.storeEditor");
  const ts = useTranslations("Commerce.storeSite");
  const te = useTranslations("Commerce.settings.errors");
  const tp = useTranslations("ShopPublic");
  const locale = useLocale();
  const canEdit = useCan("edit-settings");
  const [view, setView] = useState<ThemeEditorView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [doc, setDoc] = useState<ShopDocument | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState<null | "save" | "publish" | "discard" | "restore">(null);
  const [tab, setTab] = useState<Tab>("sections");
  const [device, setDevice] = useState<Device>("phone");
  const [page, setPage] = useState<"home" | ShopPageSlug>("home");
  const [selected, setSelected] = useState<string | null>(null);
  const [mediaUrls, setMediaUrls] = useState<Record<string, string>>({});
  const [pickTarget, setPickTarget] = useState<PickTarget | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [adding, setAdding] = useState<ShopSectionType>("image_text");

  const apply = useCallback((data: ThemeEditorView) => {
    setView(data);
    setDoc(data.draft);
    setMediaUrls((m) => ({ ...m, ...data.mediaUrls }));
    setDirty(false);
  }, []);

  useEffect(() => {
    authFetch("/api/commerce/store-site/theme", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        apply((await res.json()) as ThemeEditorView);
      })
      .catch(() => setLoadError(true));
  }, [apply]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const update = useCallback((patch: Partial<ShopDocument>) => {
    setDoc((d) => (d ? { ...d, ...patch } : d));
    setDirty(true);
  }, []);

  const image = useCallback((ref: string | null) => {
    if (!ref) return null;
    if (ref.startsWith("media:")) return mediaUrls[ref.slice(6)] ?? null;
    return /^https:\/\//.test(ref) ? ref : null;
  }, [mediaUrls]);

  const tShop = tp as unknown as ShopT;
  const theme = useMemo(() => (doc ? resolveTheme(doc.template, doc.theme) : null), [doc]);

  if (loadError) return <p className="text-sm text-destructive" role="alert">{t("loadError")}</p>;
  if (!view || !doc || !theme) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={ts("loading")} />;
  if (!view.ready) return (
    <div className="mx-auto max-w-xl space-y-3 rounded-lg border p-6">
      <p className="text-sm">{t("notReady")}</p>
      <Link href="/commerce/store" className="text-sm font-medium underline">{t("back")}</Link>
    </div>
  );

  const call = async (method: "PUT" | "POST", body: unknown, kind: NonNullable<typeof busy>, success: string) => {
    setBusy(kind);
    const res = await authFetch("/api/commerce/store-site/theme", {
      method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).catch(() => null);
    setBusy(null);
    const data = (await res?.json().catch(() => ({}))) as ThemeEditorView & { code?: string; field?: string };
    if (!res?.ok) {
      const code = typeof data.code === "string" ? data.code : "invalid";
      toast.error(data.field ? `${te(code as never)} (${data.field})` : te(code as never));
      return null;
    }
    apply(data);
    toast.success(success);
    return data;
  };
  const save = () => call("PUT", { expectedDraftVersion: view.draftVersion, document: doc }, "save", t("draftSaved"));
  const publish = async () => {
    let version = view.draftVersion;
    if (dirty) {
      const saved = await save();
      if (!saved) return;
      version = saved.draftVersion;
    }
    await call("POST", { action: "publish", expectedDraftVersion: version }, "publish", t("published"));
  };
  const discard = () => call("POST", { action: "discard", expectedDraftVersion: view.draftVersion }, "discard", t("discarded"));
  const restore = (number: number) => call("POST", { action: "restore", number, expectedDraftVersion: view.draftVersion }, "restore", t("restored", { number }));

  const sections = doc.sections;
  const setSections = (next: ShopSection[]) => update({ sections: next });
  const setSection = (id: string, patch: Partial<ShopSection>) => setSections(sections.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= sections.length || from === to) return;
    const next = [...sections];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setSections(next);
  };
  const addSection = () => {
    if (sections.length >= SHOP_CONTENT_LIMITS.sections) return toast.error(t("tooManySections"));
    const section = newSection(adding, newId());
    setSections([...sections, section]);
    setSelected(section.id);
    setPage("home");
  };

  const pick = (target: PickTarget) => setPickTarget(() => target);
  const setTheme = (patch: Partial<ShopThemeSettings>) => update({ theme: { ...doc.theme, ...patch } });

  const linkOptions: Array<{ value: string; label: string }> = [
    { value: "/", label: tp("home") },
    { value: "/all", label: tp("allProducts") },
    { value: "/cart", label: tp("cart") },
    ...SHOP_PAGE_SLUGS.map((slug) => ({ value: `/pages/${slug}`, label: tp(`pages.${slug}`) })),
    ...view.preview.tree.map((c) => ({ value: `/c/${c.id}`, label: `${t("categoryPrefix")}: ${c.name}` })),
    ...view.preview.collections.map((c) => ({ value: `/collections/${c.slug}`, label: `${t("collectionPrefix")}: ${c.title}` })),
    ...view.preview.products.map((p) => ({ value: `/p/${p.id}`, label: `${t("productPrefix")}: ${p.name}` })),
  ];

  const linkInput = ({ id, value, onChange }: { id: string; value: string | null; onChange: (v: string | null) => void }) => {
    const known = value === null || linkOptions.some((o) => o.value === value);
    return (
      <div className="flex flex-col gap-1.5">
        <OptionSelect fit
          id={id}
          value={value === null ? "" : known ? value : "__url"}
          onValueChange={(v) => onChange(v === "" ? null : v === "__url" ? "https://" : v)}
          disabled={!canEdit}
          options={[
            { value: "", label: t("noLink") },
            ...linkOptions.map((o) => ({ value: o.value, label: o.label })),
            { value: "__url", label: t("webAddress") },
          ]}
        />
        {!known && <Input aria-label={t("webAddress")} disabled={!canEdit} value={value ?? ""} placeholder="https://…" onChange={(e) => onChange(e.target.value || null)} />}
      </div>
    );
  };

  const imageInput = ({ id, value, onChange }: { id: string; value: string | null; onChange: (v: string | null) => void }) => {
    const src = image(value);
    return (
      <div className="flex items-center gap-2">
        {/* eslint-disable-next-line @next/next/no-img-element -- preview of the shop's own image */}
        {src ? <img src={src} alt="" className="size-10 shrink-0 rounded border object-cover" /> : <div className="grid size-10 shrink-0 place-items-center rounded border"><ImageIcon className="size-4 text-muted-foreground" /></div>}
        <Input id={id} placeholder="https://…" disabled={!canEdit} value={value?.startsWith("media:") ? ts("fromLibrary") : value ?? ""}
          readOnly={value?.startsWith("media:")} onChange={(e) => onChange(e.target.value || null)} />
        <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={() => pick(onChange)} aria-label={ts("pickImage")}><ImageIcon className="size-4" /></Button>
        {value && <Button type="button" variant="ghost" size="sm" disabled={!canEdit} onClick={() => onChange(null)}>{ts("clear")}</Button>}
      </div>
    );
  };

  const fieldInput = ({ field, values, onChange, idPrefix }: { field: ShopField; values: FieldValues; onChange: (v: FieldValues) => void; idPrefix: string }) => {
    const id = `${idPrefix}-${field.key}`;
    const value = values[field.key] ?? null;
    const set = (v: string | number | null) => onChange({ ...values, [field.key]: v });
    const label = t(`fields.${field.key}` as never);
    switch (field.kind) {
      case "line": return <Field id={id} label={label}><Input id={id} disabled={!canEdit} maxLength={field.max} value={(value as string) ?? ""} onChange={(e) => set(e.target.value || null)} /></Field>;
      case "text": return <Field id={id} label={label}><Textarea id={id} disabled={!canEdit} maxLength={field.max} rows={4} value={(value as string) ?? ""} onChange={(e) => set(e.target.value || null)} /></Field>;
      case "image": return <Field id={id} label={label}>{imageInput({ id: id, value: value as string | null, onChange: set })}</Field>;
      case "link": return <Field id={id} label={label}>{linkInput({ id: id, value: value as string | null, onChange: set })}</Field>;
      case "video": return <Field id={id} label={label} hint={t("videoHint")}><Input id={id} disabled={!canEdit} placeholder="https://youtu.be/…" value={(value as string) ?? ""} onChange={(e) => set(e.target.value || null)} /></Field>;
      case "category": return (
        <Field id={id} label={label}>
          <OptionSelect fit
            id={id}
            value={(value as string) ?? ""}
            onValueChange={(v) => set(v || null)}
            disabled={!canEdit}
            options={[
              { value: "", label: t("allCategories") },
              ...view.preview.tree.map((c) => ({ value: c.id, label: c.name })),
            ]}
          />
        </Field>
      );
      case "collection": return (
        <Field id={id} label={label} hint={t("collectionHint")}>
          <OptionSelect fit
            id={id}
            value={(value as string) ?? ""}
            onValueChange={(v) => set(v || null)}
            disabled={!canEdit}
            options={[
              { value: "", label: t("noCollection") },
              ...view.preview.collections.map((c) => ({ value: c.id, label: c.published ? c.title : `${c.title} (${t("unpublished")})` })),
            ]}
          />
        </Field>
      );
      case "choice": return (
        <Field id={id} label={label}>
          <OptionSelect fit
            id={id}
            value={(value as string) ?? field.options[0]}
            onValueChange={(v) => set(v)}
            disabled={!canEdit}
            options={[
              ...field.options.map((o) => ({ value: o, label: t(`choices.${field.key}.${o}` as never) })),
            ]}
          />
        </Field>
      );
      case "datetime": return (
        <Field id={id} label={label} hint={t("endsAtHint")}>
          <Input id={id} type="datetime-local" disabled={!canEdit} value={toLocalInput(value as string | null)}
            onChange={(e) => set(fromLocalInput(e.target.value))} />
        </Field>
      );
      case "number": return <Field id={id} label={label}><Input id={id} type="number" disabled={!canEdit} min={field.min} max={field.max} value={(value as number) ?? field.default}
        onChange={(e) => set(Math.min(field.max, Math.max(field.min, Math.round(Number(e.target.value) || field.default))))} /></Field>;
    }
  };

  const current = sections.find((s) => s.id === selected) ?? null;

  const sectionForm = (section: ShopSection) => {
    const spec = SECTION_SPECS[section.type];
    return (
      <div className="space-y-4 rounded-lg border p-4">
        <p className="text-sm font-semibold">{t(`sections.${section.type}`)}</p>
        {section.type === "banner" && <p className="text-xs text-muted-foreground">{t("bannerHint")}</p>}
        {spec.fields.map((f) => <div key={f.key}>{fieldInput({ field: f, values: section.settings, idPrefix: section.id, onChange: (settings) => setSection(section.id, { settings }) })}</div>)}
        {spec.items && (
          <div className="space-y-3">
            {section.items.map((item, i) => (
              <div key={i} className="space-y-3 rounded-md bg-muted/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{(t as unknown as (k: string, v: { n: number }) => string)(`items.${section.type}`, { n: i + 1 })}</span>
                  <div className="flex gap-1">
                    <Button type="button" size="icon" variant="ghost" disabled={!canEdit || i === 0} aria-label={t("moveUp")}
                      onClick={() => { const items = [...section.items]; [items[i - 1], items[i]] = [items[i], items[i - 1]]; setSection(section.id, { items }); }}><ArrowUp className="size-4" /></Button>
                    <Button type="button" size="icon" variant="ghost" disabled={!canEdit || section.items.length <= spec.items!.min} aria-label={t("removeItem")}
                      onClick={() => setSection(section.id, { items: section.items.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button>
                  </div>
                </div>
                {spec.items!.fields.map((f) => <div key={f.key}>{fieldInput({ field: f, values: item, idPrefix: `${section.id}-${i}`, onChange: (next) => setSection(section.id, { items: section.items.map((it, j) => (j === i ? next : it)) }) })}</div>)}
              </div>
            ))}
            {section.items.length < spec.items.max && (
              <Button type="button" variant="outline" size="sm" disabled={!canEdit}
                onClick={() => setSection(section.id, { items: [...section.items, newSection(section.type, "tmpx").items[0]] })}>
                <Plus className="size-4" />{t("addItem")}
              </Button>
            )}
          </div>
        )}
      </div>
    );
  };

  const menuLinks = ({ links, max, onChange, idPrefix }: { links: ShopMenuLink[]; max: number; onChange: (l: ShopMenuLink[]) => void; idPrefix: string }) => (
    <div className="space-y-2">
      {links.map((link, i) => (
        <div key={i} className="grid grid-cols-[1fr_1fr_auto] items-start gap-2">
          <Input aria-label={t("linkLabel")} disabled={!canEdit} maxLength={40} value={link.label} placeholder={t("linkLabel")}
            onChange={(e) => onChange(links.map((l, j) => (j === i ? { ...l, label: e.target.value } : l)))} />
          {linkInput({ id: `${idPrefix}-${i}`, value: link.link, onChange: (v) => onChange(links.map((l, j) => (j === i ? { ...l, link: v ?? "/" } : l))) })}
          <Button type="button" size="icon" variant="ghost" disabled={!canEdit} aria-label={t("removeItem")} onClick={() => onChange(links.filter((_, j) => j !== i))}><Trash2 className="size-4" /></Button>
        </div>
      ))}
      {links.length < max && (
        <Button type="button" variant="outline" size="sm" disabled={!canEdit} onClick={() => onChange([...links, { label: "", link: "/all" }])}>
          <Plus className="size-4" />{t("addLink")}
        </Button>
      )}
    </div>
  );

  const content = contentOf(doc);
  const frameShop = {
    handle: view.preview.handle, name: view.preview.name, theme, logoUrl: image(theme.logo), whatsappPhone: view.preview.whatsappPhone,
    menu: doc.menu.filter((m) => m.label), footer: { ...doc.footer, links: doc.footer.links.filter((l) => l.label) }, pages: pagesOn(content),
  };
  const ctx = {
    base: `/s/${view.preview.handle}`, handle: view.preview.handle, theme, currency: view.preview.currency, locale,
    products: view.preview.products, categories: view.preview.categories, tree: view.preview.tree,
    collections: Object.fromEntries(view.preview.collections.map((c) => [c.id, { slug: c.slug, title: c.title, productIds: c.productIds }])),
    whatsappPhone: view.preview.whatsappPhone, image, t: tShop, preview: true,
  };
  const status = dirty ? t("statusUnsaved") : view.hasDraft ? t("statusDraft") : t("statusLive");
  const tabs: Tab[] = ["sections", "theme", "menu", "pages", "history"];

  return (
    <div className="flex h-[calc(100vh-4rem)] min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Link href="/commerce/store" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"><ArrowLeft className="size-4" />{t("back")}</Link>
        <h1 className="text-lg font-bold">{t("title")}</h1>
        <span className="rounded-full bg-muted px-2 py-0.5 text-xs" role="status">{status}</span>
        {canEdit && (
          <div className="ml-auto flex flex-wrap gap-2">
            {view.hasDraft && !dirty && <Button type="button" variant="ghost" size="sm" disabled={!!busy} onClick={discard}>{t("discard")}</Button>}
            <Button type="button" variant="outline" size="sm" disabled={!!busy || !dirty} onClick={save}>{busy === "save" && <Loader2 className="size-4 animate-spin" />}{t("saveDraft")}</Button>
            <Button type="button" size="sm" disabled={!!busy || (!dirty && !view.hasDraft)} onClick={publish}>{busy === "publish" && <Loader2 className="size-4 animate-spin" />}{t("publish")}</Button>
          </div>
        )}
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[400px_1fr]">
        <div className="flex min-h-0 flex-col rounded-lg border">
          <div className="flex gap-1 overflow-x-auto border-b p-1" role="tablist">
            {tabs.map((id) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}
                className={`shrink-0 rounded-md px-3 py-1.5 text-sm ${tab === id ? "bg-muted font-semibold" : "text-muted-foreground hover:text-foreground"}`}>
                {t(`tabs.${id}`)}
              </button>
            ))}
          </div>
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
            {tab === "sections" && (
              <>
                <ul className="space-y-1">
                  {sections.map((s, i) => (
                    <li key={s.id} draggable={canEdit}
                      onDragStart={() => setDragIndex(i)} onDragOver={(e) => e.preventDefault()}
                      onDrop={() => { if (dragIndex !== null) move(dragIndex, i); setDragIndex(null); }}
                      className={`flex items-center gap-1 rounded-md border px-2 py-1 text-sm ${selected === s.id ? "border-primary bg-primary/5" : ""} ${s.hidden ? "opacity-60" : ""}`}>
                      <GripVertical className="size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden />
                      <button type="button" className="min-w-0 flex-1 truncate py-1 text-left" onClick={() => { setSelected(s.id); setPage("home"); }}>
                        {t(`sections.${s.type}`)}
                      </button>
                      <Button type="button" size="icon" variant="ghost" disabled={!canEdit} aria-label={s.hidden ? t("show") : t("hide")}
                        onClick={() => setSection(s.id, { hidden: !s.hidden })}>{s.hidden ? <EyeOff className="size-4" /> : <Eye className="size-4" />}</Button>
                      <Button type="button" size="icon" variant="ghost" disabled={!canEdit || i === 0} aria-label={t("moveUp")} onClick={() => move(i, i - 1)}><ArrowUp className="size-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" disabled={!canEdit || i === sections.length - 1} aria-label={t("moveDown")} onClick={() => move(i, i + 1)}><ArrowDown className="size-4" /></Button>
                      <Button type="button" size="icon" variant="ghost" disabled={!canEdit} aria-label={t("remove")}
                        onClick={() => { setSections(sections.filter((x) => x.id !== s.id)); if (selected === s.id) setSelected(null); }}><Trash2 className="size-4" /></Button>
                    </li>
                  ))}
                </ul>
                {canEdit && (
                  <div className="flex gap-2">
                    <OptionSelect fit
                      aria-label={t("sectionType")}
                      value={adding}
                      onValueChange={(v) => setAdding(v as ShopSectionType)}
                      options={[
                        ...SHOP_SECTION_TYPES.map((type) => ({ value: type, label: t(`sections.${type}`) })),
                      ]}
                    />
                    <Button type="button" variant="outline" onClick={addSection}><Plus className="size-4" />{t("addSection")}</Button>
                  </div>
                )}
                {current ? sectionForm(current) : <p className="text-sm text-muted-foreground">{t("pickSection")}</p>}
              </>
            )}

            {tab === "theme" && (
              <>
                <div className="space-y-2">
                  <p className="text-sm font-semibold">{ts("templateTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("switchKeeps")}</p>
                  <TemplateGallery current={doc.template} canEdit={canEdit} onUse={(id) => update({ template: id })}
                    shop={{ handle: frameShop.handle, name: frameShop.name, logoUrl: frameShop.logoUrl, whatsappPhone: frameShop.whatsappPhone,
                      menu: frameShop.menu, footer: frameShop.footer, pages: frameShop.pages }}
                    settings={doc.theme} products={view.preview.products} ctx={ctx} t={tShop} />
                  <Button type="button" variant="ghost" size="sm" disabled={!canEdit} onClick={() => setTheme({ colors: {}, font: {} })}>{t("resetLook")}</Button>
                </div>
                <Field id="theme-logo" label={ts("logo")}>{imageInput({ id: "theme-logo", value: doc.theme.logo, onChange: (logo) => setTheme({ logo }) })}</Field>
                <Field id="theme-banner" label={ts("banner")}>{imageInput({ id: "theme-banner", value: doc.theme.banner, onChange: (banner) => setTheme({ banner }) })}</Field>
                <div className="grid grid-cols-2 gap-3">
                  {SHOP_COLOR_KEYS.map((key: keyof ShopColors) => (
                    <Field key={key} id={`theme-color-${key}`} label={ts(`colors.${key}`)}>
                      <input id={`theme-color-${key}`} type="color" disabled={!canEdit} className="h-9 w-full rounded border"
                        value={doc.theme.colors[key] ?? SHOP_TEMPLATES[doc.template].colors[key]}
                        onChange={(e) => setTheme({ colors: { ...doc.theme.colors, [key]: e.target.value } })} />
                    </Field>
                  ))}
                </div>
                {(["heading", "body"] as const).map((key) => (
                  <Field key={key} id={`theme-font-${key}`} label={ts(`font.${key}`)}>
                    <OptionSelect fit
                      id={`theme-font-${key}`}
                      className="w-full"
                      disabled={!canEdit}
                      value={doc.theme.font[key] ?? ""}
                      onValueChange={(v) => setTheme({ font: { ...doc.theme.font, [key]: (v || undefined) as never } })}
                      options={[
                        { value: "", label: ts("templateFont", { font: ts(`fonts.${SHOP_TEMPLATES[doc.template].font[key]}`) }) },
                        // A font id saved before the self-hosted fonts stays selectable until it is changed.
                        ...[...SHOP_FONT_IDS, ...(doc.theme.font[key] && !SHOP_FONT_IDS.includes(doc.theme.font[key]) ? [doc.theme.font[key]] : [])]
                          .map((f) => ({ value: f, label: <span style={{ fontFamily: SHOP_FONTS[f] }}>{ts(`fonts.${f}`)}</span> })),
                      ]}
                    />
                  </Field>
                ))}
                {(["headline", "subheadline", "announcement"] as const).map((key) => (
                  <Field key={key} id={`theme-${key}`} label={ts(key)}>
                    <Input id={`theme-${key}`} disabled={!canEdit} maxLength={SHOP_TEXT_LIMITS[key]} value={doc.theme[key] ?? ""}
                      placeholder={key === "announcement" ? ts("announcementPlaceholder") : ts(`templates.${doc.template}.${key}` as never)}
                      onChange={(e) => setTheme({ [key]: e.target.value || null })} />
                  </Field>
                ))}
                {(["instagram", "facebook", "youtube"] as const).map((key) => (
                  <Field key={key} id={`theme-social-${key}`} label={ts(`social.${key}`)}>
                    <Input id={`theme-social-${key}`} disabled={!canEdit} placeholder="https://…" value={doc.theme.social[key] ?? ""}
                      onChange={(e) => setTheme({ social: { ...doc.theme.social, [key]: e.target.value || null } })} />
                  </Field>
                ))}
              </>
            )}

            {tab === "menu" && (
              <>
                <div className="space-y-2">
                  <p className="text-sm font-semibold">{t("menuTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("menuHint")}</p>
                  {menuLinks({ links: doc.menu, max: SHOP_CONTENT_LIMITS.menu, idPrefix: "menu", onChange: (menu) => update({ menu }) })}
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-semibold">{t("footerTitle")}</p>
                  <Field id="footer-text" label={t("footerText")}>
                    <Textarea id="footer-text" rows={2} maxLength={300} disabled={!canEdit} value={doc.footer.text ?? ""} placeholder={tp("footerNote")}
                      onChange={(e) => update({ footer: { ...doc.footer, text: e.target.value || null } })} />
                  </Field>
                  {menuLinks({ links: doc.footer.links, max: SHOP_CONTENT_LIMITS.footerLinks, idPrefix: "footer", onChange: (links) => update({ footer: { ...doc.footer, links } }) })}
                  <p className="text-xs text-muted-foreground">{t("footerPagesHint")}</p>
                </div>
                <div className="space-y-3">
                  <p className="text-sm font-semibold">{t("contactTitle")}</p>
                  {(["phone", "email", "hours"] as const).map((key) => (
                    <Field key={key} id={`contact-${key}`} label={t(`contact.${key}`)}>
                      <Input id={`contact-${key}`} disabled={!canEdit} maxLength={key === "email" ? 120 : key === "phone" ? 24 : 120}
                        value={doc.footer.contact[key] ?? ""} onChange={(e) => update({ footer: { ...doc.footer, contact: { ...doc.footer.contact, [key]: e.target.value || null } } })} />
                    </Field>
                  ))}
                  <Field id="contact-address" label={t("contact.address")}>
                    <Textarea id="contact-address" rows={3} maxLength={300} disabled={!canEdit} value={doc.footer.contact.address ?? ""}
                      onChange={(e) => update({ footer: { ...doc.footer, contact: { ...doc.footer.contact, address: e.target.value || null } } })} />
                  </Field>
                </div>
              </>
            )}

            {tab === "pages" && (
              <>
                <p className="text-xs text-muted-foreground">{t("pagesHint")}</p>
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-semibold">{tp("pages.about")}</p>
                  <Field id="about-title" label={t("fields.title")}><Input id="about-title" maxLength={80} disabled={!canEdit} value={doc.pages.about.title ?? ""}
                    onChange={(e) => update({ pages: { ...doc.pages, about: { ...doc.pages.about, title: e.target.value || null } } })} /></Field>
                  <Field id="about-image" label={t("fields.image")}>{imageInput({ id: "about-image", value: doc.pages.about.image, onChange: (img) => update({ pages: { ...doc.pages, about: { ...doc.pages.about, image: img } } }) })}</Field>
                  <Field id="about-body" label={t("fields.text")}><Textarea id="about-body" rows={6} maxLength={5000} disabled={!canEdit} value={doc.pages.about.body ?? ""}
                    onChange={(e) => update({ pages: { ...doc.pages, about: { ...doc.pages.about, body: e.target.value || null } } })} /></Field>
                </div>
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-semibold">{tp("pages.contact")}</p>
                  <Field id="contact-title" label={t("fields.title")}><Input id="contact-title" maxLength={80} disabled={!canEdit} value={doc.pages.contact.title ?? ""}
                    onChange={(e) => update({ pages: { ...doc.pages, contact: { ...doc.pages.contact, title: e.target.value || null } } })} /></Field>
                  <Field id="contact-body" label={t("fields.text")} hint={t("contactPageHint")}><Textarea id="contact-body" rows={4} maxLength={2000} disabled={!canEdit} value={doc.pages.contact.body ?? ""}
                    onChange={(e) => update({ pages: { ...doc.pages, contact: { ...doc.pages.contact, body: e.target.value || null } } })} /></Field>
                </div>
                <div className="space-y-3 rounded-lg border p-3">
                  <p className="text-sm font-semibold">{tp("pages.faq")}</p>
                  {doc.pages.faq.items.map((item, i) => (
                    <div key={i} className="space-y-2 rounded-md bg-muted/40 p-2">
                      <Input aria-label={t("fields.question")} placeholder={t("fields.question")} maxLength={160} disabled={!canEdit} value={item.question}
                        onChange={(e) => update({ pages: { ...doc.pages, faq: { ...doc.pages.faq, items: doc.pages.faq.items.map((x, j) => (j === i ? { ...x, question: e.target.value } : x)) } } })} />
                      <Textarea aria-label={t("fields.answer")} placeholder={t("fields.answer")} rows={2} maxLength={1000} disabled={!canEdit} value={item.answer}
                        onChange={(e) => update({ pages: { ...doc.pages, faq: { ...doc.pages.faq, items: doc.pages.faq.items.map((x, j) => (j === i ? { ...x, answer: e.target.value } : x)) } } })} />
                      <Button type="button" variant="ghost" size="sm" disabled={!canEdit}
                        onClick={() => update({ pages: { ...doc.pages, faq: { ...doc.pages.faq, items: doc.pages.faq.items.filter((_, j) => j !== i) } } })}><Trash2 className="size-4" />{t("removeItem")}</Button>
                    </div>
                  ))}
                  {doc.pages.faq.items.length < 30 && (
                    <Button type="button" variant="outline" size="sm" disabled={!canEdit}
                      onClick={() => update({ pages: { ...doc.pages, faq: { ...doc.pages.faq, items: [...doc.pages.faq.items, { question: "", answer: "" }] } } })}>
                      <Plus className="size-4" />{t("addQuestion")}
                    </Button>
                  )}
                </div>
                {POLICY_SLUGS.map((slug) => (
                  <div key={slug} className="space-y-2 rounded-lg border p-3">
                    <p className="text-sm font-semibold">{tp(`pages.${slug}`)}</p>
                    <p className="text-xs text-muted-foreground">{t("policyHint")}</p>
                    <Textarea aria-label={t("policyNote")} placeholder={t("policyNote")} rows={3} maxLength={4000} disabled={!canEdit} value={doc.policies[slug] ?? ""}
                      onChange={(e) => update({ policies: { ...doc.policies, [slug]: e.target.value || null } })} />
                    <Button type="button" variant="link" size="sm" className="px-0" onClick={() => setPage(slug)}>{t("previewPage")}</Button>
                  </div>
                ))}
              </>
            )}

            {tab === "history" && (
              <>
                <p className="text-xs text-muted-foreground">{t("historyHint")}</p>
                {view.versions.length === 0 ? <p className="text-sm text-muted-foreground">{t("noVersions")}</p> : (
                  <ul className="space-y-2">
                    {view.versions.map((v) => (
                      <li key={v.number} className="flex items-center justify-between gap-2 rounded-md border p-2 text-sm">
                        <span>
                          <span className="font-semibold">{t("versionN", { number: v.number })}</span>
                          <span className="block text-xs text-muted-foreground">
                            {new Date(v.createdAt).toLocaleString(locale)}{v.publishedBy ? ` · ${v.publishedBy}` : ""}
                          </span>
                        </span>
                        {canEdit && <Button type="button" size="sm" variant="outline" disabled={!!busy || dirty} onClick={() => restore(v.number)}>{t("restore")}</Button>}
                      </li>
                    ))}
                  </ul>
                )}
                {dirty && <p className="text-xs text-muted-foreground">{t("saveBeforeRestore")}</p>}
              </>
            )}
          </div>
        </div>

        <div className="flex min-h-[480px] min-w-0 flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              size="sm"
              aria-label={t("device")}
              value={device}
              onValueChange={setDevice}
              options={[
                { value: "phone", label: <><Smartphone className="size-4" />{t("phone")}</> },
                { value: "desktop", label: <><Monitor className="size-4" />{t("desktop")}</> },
              ]}
            />
            <OptionSelect fit
              aria-label={t("previewOf")}
              value={page}
              onValueChange={(v) => setPage(v as typeof page)}
              options={[
                { value: "home", label: tp("home") },
                ...SHOP_PAGE_SLUGS.map((slug) => ({ value: slug, label: tp(`pages.${slug}`) })),
              ]}
            />
            <span className="text-xs text-muted-foreground">{t("previewNote")}</span>
          </div>
          <div className="relative min-h-0 flex-1 overflow-hidden rounded-lg border bg-muted/40">
            <div className={`relative mx-auto h-full overflow-hidden bg-white ${device === "phone" ? "w-[390px] max-w-full border-x" : "w-full"}`}>
              <div className="h-full overflow-y-auto"
                onClickCapture={(e) => {
                  // Links do not navigate in the preview; clicking a section selects it for editing.
                  const target = e.target as HTMLElement;
                  if (target.closest("a")) e.preventDefault();
                  const section = target.closest<HTMLElement>("[data-section]")?.dataset.section;
                  if (section) { setSelected(section); setTab("sections"); }
                }}>
                <ShopFrameView shop={frameShop} t={tShop} preview>
                  {page === "home"
                    ? <ShopSectionsView sections={sections} ctx={ctx} selected={selected} />
                    : <ShopPageView slug={page} content={{ ...content, pages: { ...content.pages, about: { ...content.pages.about, image: image(content.pages.about.image) } } }}
                      facts={view.preview.facts} shopName={view.preview.name} t={tShop} locale={locale}
                      contactDetails={!!(doc.footer.contact.phone || doc.footer.contact.email || doc.footer.contact.address || doc.footer.contact.hours)} />}
                </ShopFrameView>
              </div>
            </div>
          </div>
        </div>
      </div>

      <MediaPicker open={pickTarget !== null} onOpenChange={(open) => { if (!open) setPickTarget(null); }} initialKind="image" onPick={(media) => {
        if (media.kind !== "image" || !pickTarget) return toast.error(ts("imageOnly"));
        setMediaUrls((m) => ({ ...m, [media.id]: media.url }));
        pickTarget(`media:${media.id}`);
      }} />
    </div>
  );
}

