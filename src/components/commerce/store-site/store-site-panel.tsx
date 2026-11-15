"use client";

/**
 * Commerce → Online store (store plan Phase 1): the public shop's setup
 * checklist, its address and publish switch, a share link and QR code, the
 * six ready-made templates, brand settings, and how buyers order (WhatsApp
 * code and/or "Order on WhatsApp"). Admins edit; agents read (the API and
 * RLS enforce the same rule). Every value is validated again on the server.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Check, Circle, Copy, Download, ExternalLink, ImageIcon, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { useCan } from "@/hooks/use-can";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { MediaPicker } from "@/components/inbox/media-library/media-picker";
import type { ShopSiteView } from "@/lib/commerce/shop-site";
import {
  SHOP_COLOR_KEYS, SHOP_FONT_IDS, SHOP_FONTS, SHOP_TEMPLATE_IDS, SHOP_TEMPLATES, SHOP_TEXT_LIMITS,
  type ShopColors, type ShopTemplateId, type ShopThemeSettings,
} from "@/lib/commerce/shop-templates";
import { encodeQr, qrSvgPath } from "@/lib/qr/encode";

type ImageField = "logo" | "banner";

function QrCode({ url, label }: { url: string; label: string }) {
  const { path, size } = useMemo(() => {
    try {
      const modules = encodeQr(url);
      return { path: qrSvgPath(modules), size: modules.length + 8 };
    } catch {
      return { path: "", size: 0 };
    }
  }, [url]);
  if (!path) return null;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${path}" fill="#000"/></svg>`;
  const download = () => {
    const blob = new Blob([svg], { type: "image/svg+xml" });
    const href = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), { href, download: "shop-qr.svg" });
    a.click();
    URL.revokeObjectURL(href);
  };
  return (
    <div className="flex flex-col items-start gap-2">
      <svg viewBox={`0 0 ${size} ${size}`} className="size-40 rounded-md border bg-white" shapeRendering="crispEdges" role="img" aria-label={label}>
        <rect width="100%" height="100%" fill="#fff" />
        <path d={path} fill="#000" />
      </svg>
      <Button type="button" variant="outline" size="sm" onClick={download}><Download className="size-4" />{label}</Button>
    </div>
  );
}

export function StoreSitePanel() {
  const t = useTranslations("Commerce.storeSite");
  const te = useTranslations("Commerce.settings.errors");
  const canEdit = useCan("edit-settings");
  const [view, setView] = useState<ShopSiteView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [draft, setDraft] = useState<ShopSiteView["site"] | null>(null);
  const [saving, setSaving] = useState(false);
  const [picker, setPicker] = useState<ImageField | null>(null);

  useEffect(() => {
    authFetch("/api/commerce/store-site", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as ShopSiteView;
        setView(data);
        setDraft(data.site);
      })
      .catch(() => setLoadError(true));
  }, []);

  if (loadError) return <p className="text-sm text-destructive" role="alert">{t("loadError")}</p>;
  if (!view || !draft) return <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />;

  const theme = draft.theme;
  const template = SHOP_TEMPLATES[draft.template];
  const setTheme = (patch: Partial<ShopThemeSettings>) => setDraft({ ...draft, theme: { ...theme, ...patch } });
  const doneCount = view.checklist.filter((i) => i.done).length;
  const shopUrl = view.site.url;
  const selectedNumber = view.numbers.find((n) => n.id === draft.whatsappConfigId) ?? null;
  const templates = view.otpTemplates.filter((tpl) => !selectedNumber?.wabaId || !tpl.wabaId || tpl.wabaId === selectedNumber.wabaId);

  const save = async () => {
    setSaving(true);
    const res = await authFetch("/api/commerce/store-site", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        expectedVersion: draft.version, handle: draft.handle, published: draft.published, template: draft.template, theme: draft.theme,
        whatsappConfigId: draft.whatsappConfigId, whatsappPhone: draft.whatsappPhone, otpTemplateId: draft.otpTemplateId,
      }),
    }).catch(() => null);
    setSaving(false);
    const data = (await res?.json().catch(() => ({}))) as ShopSiteView & { code?: string; field?: string };
    if (!res?.ok) {
      const code = typeof data.code === "string" ? data.code : "invalid";
      toast.error(data.field ? `${te(code as never)} (${data.field})` : te(code as never));
      return;
    }
    setView(data);
    setDraft(data.site);
    toast.success(t("saved"));
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shopUrl);
      toast.success(t("copied"));
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  const imageField = (field: ImageField) => {
    const value = theme[field];
    return (
      <div className="space-y-1.5">
        <Label htmlFor={`shop-${field}`}>{t(field)}</Label>
        <div className="flex gap-2">
          <Input id={`shop-${field}`} placeholder="https://…" disabled={!canEdit}
            value={value?.startsWith("media:") ? t("fromLibrary") : value ?? ""}
            onChange={(e) => setTheme({ [field]: e.target.value || null })} />
          <Button type="button" variant="outline" disabled={!canEdit} onClick={() => setPicker(field)} aria-label={t("pickImage")}>
            <ImageIcon className="size-4" />
          </Button>
          {value && <Button type="button" variant="ghost" disabled={!canEdit} onClick={() => setTheme({ [field]: null })}>{t("clear")}</Button>}
        </div>
      </div>
    );
  };

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-[22px] font-bold tracking-tight text-foreground">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {view.site.saved && view.site.published && (
          <a href={shopUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "outline" })}>
            <ExternalLink className="size-4" />{t("openShop")}
          </a>
        )}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("checklistTitle")}</CardTitle>
          <CardDescription>{t("checklistProgress", { done: doneCount, total: view.checklist.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2 sm:grid-cols-2">
            {view.checklist.map((item) => (
              <li key={item.key}>
                <Link href={item.href} className="flex items-center gap-2 rounded-md p-2 text-sm hover:bg-muted">
                  {item.done ? <Check className="size-4 text-emerald-600" aria-hidden /> : <Circle className="size-4 text-muted-foreground" aria-hidden />}
                  <span className={item.done ? "text-muted-foreground line-through" : ""}>{t(`checklist.${item.key}`)}</span>
                  <span className="sr-only">{item.done ? t("done") : t("todo")}</span>
                </Link>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <Card id="publish">
        <CardHeader>
          <CardTitle>{t("addressTitle")}</CardTitle>
          <CardDescription>{t("addressHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 md:grid-cols-[1fr_auto]">
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="shop-handle">{t("handle")}</Label>
              <div className="flex items-center gap-1 text-sm">
                <span className="shrink-0 text-muted-foreground">/s/</span>
                <Input id="shop-handle" value={draft.handle} disabled={!canEdit} maxLength={40}
                  onChange={(e) => setDraft({ ...draft, handle: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "") })} />
              </div>
              <p className="text-xs text-muted-foreground">{t("handleHint")}</p>
            </div>
            <div className="flex items-center gap-3">
              <Switch id="shop-published" checked={draft.published} disabled={!canEdit} onCheckedChange={(on) => setDraft({ ...draft, published: on })} />
              <Label htmlFor="shop-published">{draft.published ? t("published") : t("hidden")}</Label>
            </div>
            {view.site.saved && (
              <div className="flex flex-wrap items-center gap-2">
                <code className="rounded bg-muted px-2 py-1 text-xs">{shopUrl}</code>
                <Button type="button" size="sm" variant="outline" onClick={copy}><Copy className="size-4" />{t("copyLink")}</Button>
              </div>
            )}
            <p className="text-xs text-muted-foreground">{t("shareHint")}</p>
          </div>
          {view.site.saved && <QrCode url={shopUrl} label={t("downloadQr")} />}
        </CardContent>
      </Card>

      <Card id="template">
        <CardHeader>
          <CardTitle>{t("templateTitle")}</CardTitle>
          <CardDescription>{t("templateHint")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" role="radiogroup" aria-label={t("templateTitle")}>
            {SHOP_TEMPLATE_IDS.map((id: ShopTemplateId) => {
              const tpl = SHOP_TEMPLATES[id];
              const on = draft.template === id;
              return (
                <button key={id} type="button" role="radio" aria-checked={on} disabled={!canEdit}
                  onClick={() => setDraft({ ...draft, template: id })}
                  className={`overflow-hidden rounded-lg border text-left transition ${on ? "border-primary ring-2 ring-primary" : "hover:border-foreground/40"}`}>
                  <div className="flex h-20 flex-col justify-between p-3" style={{ background: tpl.colors.background, color: tpl.colors.text }}>
                    <span className="text-sm font-semibold" style={{ fontFamily: SHOP_FONTS[tpl.font.heading] }}>{t(`templates.${id}.name`)}</span>
                    <span className="flex gap-1">
                      {[tpl.colors.primary, tpl.colors.accent, tpl.colors.surface].map((c) => (
                        <span key={c} className="size-4 rounded-full border border-black/10" style={{ background: c }} />
                      ))}
                    </span>
                  </div>
                  <p className="p-3 text-xs text-muted-foreground">{t(`templates.${id}.description`)}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("brandTitle")}</CardTitle>
          <CardDescription>{t("brandHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          {imageField("logo")}
          {imageField("banner")}
          {SHOP_COLOR_KEYS.map((key: keyof ShopColors) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`shop-color-${key}`}>{t(`colors.${key}`)}</Label>
              <div className="flex items-center gap-2">
                <input id={`shop-color-${key}`} type="color" disabled={!canEdit} className="h-9 w-12 rounded border"
                  value={theme.colors[key] ?? template.colors[key]}
                  onChange={(e) => setTheme({ colors: { ...theme.colors, [key]: e.target.value } })} />
                {theme.colors[key] && (
                  <Button type="button" variant="ghost" size="sm" disabled={!canEdit}
                    onClick={() => { const next = { ...theme.colors }; delete next[key]; setTheme({ colors: next }); }}>{t("useTemplateColor")}</Button>
                )}
              </div>
            </div>
          ))}
          {(["heading", "body"] as const).map((key) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`shop-font-${key}`}>{t(`font.${key}`)}</Label>
              <select id={`shop-font-${key}`} disabled={!canEdit} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                value={theme.font[key] ?? ""} onChange={(e) => setTheme({ font: { ...theme.font, [key]: (e.target.value || undefined) as never } })}>
                <option value="">{t("templateFont", { font: t(`fonts.${template.font[key]}`) })}</option>
                {SHOP_FONT_IDS.map((f) => <option key={f} value={f}>{t(`fonts.${f}`)}</option>)}
              </select>
            </div>
          ))}
          {(["headline", "subheadline", "announcement"] as const).map((key) => (
            <div key={key} className="space-y-1.5 sm:col-span-2">
              <Label htmlFor={`shop-${key}`}>{t(key)}</Label>
              <Input id={`shop-${key}`} disabled={!canEdit} maxLength={SHOP_TEXT_LIMITS[key]} value={theme[key] ?? ""}
                placeholder={key === "announcement" ? t("announcementPlaceholder") : t(`templates.${draft.template}.${key}` as never)}
                onChange={(e) => setTheme({ [key]: e.target.value || null })} />
            </div>
          ))}
          {(["instagram", "facebook", "youtube"] as const).map((key) => (
            <div key={key} className="space-y-1.5">
              <Label htmlFor={`shop-social-${key}`}>{t(`social.${key}`)}</Label>
              <Input id={`shop-social-${key}`} disabled={!canEdit} placeholder="https://…" value={theme.social[key] ?? ""}
                onChange={(e) => setTheme({ social: { ...theme.social, [key]: e.target.value || null } })} />
            </div>
          ))}
        </CardContent>
      </Card>

      <Card id="ordering">
        <CardHeader>
          <CardTitle>{t("orderingTitle")}</CardTitle>
          <CardDescription>{t("orderingHint")}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5 sm:col-span-2">
            <Label htmlFor="shop-number">{t("number")}</Label>
            <select id="shop-number" disabled={!canEdit} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={draft.whatsappConfigId ?? ""} onChange={(e) => setDraft({ ...draft, whatsappConfigId: e.target.value || null, otpTemplateId: null })}>
              <option value="">{t("noNumber")}</option>
              {view.numbers.map((n) => <option key={n.id} value={n.id}>{n.name ?? n.id.slice(0, 8)}{n.connected ? "" : ` (${t("disconnected")})`}</option>)}
            </select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shop-wa-phone">{t("whatsappPhone")}</Label>
            <Input id="shop-wa-phone" inputMode="tel" disabled={!canEdit || !draft.whatsappConfigId} placeholder="919876543210"
              value={draft.whatsappPhone ?? ""} onChange={(e) => setDraft({ ...draft, whatsappPhone: e.target.value || null })} />
            <p className="text-xs text-muted-foreground">{t("whatsappPhoneHint")}</p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="shop-otp-template">{t("otpTemplate")}</Label>
            <select id="shop-otp-template" disabled={!canEdit || !draft.whatsappConfigId} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
              value={draft.otpTemplateId ?? ""} onChange={(e) => setDraft({ ...draft, otpTemplateId: e.target.value || null })}>
              <option value="">{t("noOtp")}</option>
              {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}{tpl.language ? ` (${tpl.language})` : ""}</option>)}
            </select>
            <p className="text-xs text-muted-foreground">{templates.length ? t("otpHint") : t("otpNoneHint")}</p>
          </div>
        </CardContent>
      </Card>

      {canEdit && (
        <div className="sticky bottom-4 flex justify-end">
          <Button type="button" onClick={save} disabled={saving}>{saving && <Loader2 className="size-4 animate-spin" />}{t("save")}</Button>
        </div>
      )}
      <MediaPicker open={picker !== null} onOpenChange={(open) => { if (!open) setPicker(null); }} initialKind="image" onPick={(media) => {
        if (media.kind !== "image" || !picker) return toast.error(t("imageOnly"));
        setTheme({ [picker]: `media:${media.id}` });
      }} />
    </div>
  );
}
