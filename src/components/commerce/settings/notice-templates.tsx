"use client";

/**
 * Commerce -> Store settings -> Order notice templates (Phase 9). The approved
 * template each order notice uses once the customer's 24-hour window has
 * closed: UTILITY for dispatched, delivered and feedback, MARKETING for the
 * reorder reminder (sent only to customers who ticked the checkout opt-in).
 * Admins edit; agents read (the API and RLS enforce the same rule).
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { AlertTriangle, Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import type { NoticeTemplatesView } from "@/lib/commerce/notice-templates";

async function readView(res: Response): Promise<{ view: NoticeTemplatesView | null; code: string | null; error: string | null }> {
  const json = (await res.json().catch(() => ({}))) as { templates?: NoticeTemplatesView; code?: string; error?: string };
  if (res.ok && json.templates) return { view: json.templates, code: null, error: null };
  return { view: null, code: typeof json.code === "string" ? json.code : null, error: typeof json.error === "string" ? json.error : null };
}

export function NoticeTemplates({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Commerce.noticeTemplates");
  const [view, setView] = useState<NoticeTemplatesView | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    authFetch("/api/commerce/notice-templates", { cache: "no-store" })
      .then(readView)
      .then((r) => (r.view ? setView(r.view) : setLoadError(true)))
      .catch(() => setLoadError(true));
  }, []);

  async function choose(kind: string, value: string) {
    const [name, language] = value ? value.split("|") : [null, null];
    setSaving(kind);
    setError(null);
    try {
      const res = await authFetch("/api/commerce/notice-templates", {
        method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, template_name: name, language }),
      });
      const r = await readView(res);
      if (r.view) {
        setView(r.view);
        toast.success(t("saved"));
      } else setError(r.error ?? t("errors.invalid"));
    } catch {
      setError(t("errors.invalid"));
    } finally {
      setSaving(null);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("help")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loadError && <p className="text-sm text-destructive" role="alert">{t("loadError")}</p>}
        {!view && !loadError && <Loader2 className="size-5 animate-spin text-muted-foreground" aria-label={t("loading")} />}
        {view?.settings.map((s) => {
          const options = view.options.filter((o) => o.category === s.category);
          const value = s.template_name ? `${s.template_name}|${s.language ?? ""}` : "";
          const listed = !value || options.some((o) => `${o.name}|${o.language}` === value);
          return (
            <div key={s.kind} className="space-y-1">
              <Label htmlFor={`nt-${s.kind}`}>{t(`kinds.${s.kind}`)}</Label>
              <select id={`nt-${s.kind}`} className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                disabled={!canEdit || saving !== null} value={value} onChange={(e) => void choose(s.kind, e.target.value)}>
                <option value="">{t("none")}</option>
                {!listed && <option value={value}>{`${s.template_name} (${s.language})`}</option>}
                {options.map((o) => (
                  <option key={`${o.name}|${o.language}`} value={`${o.name}|${o.language}`}>{`${o.name} (${o.language})`}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground">
                {t(s.category === "MARKETING" ? "marketingHelp" : "utilityHelp")}
              </p>
              {s.template_name && !s.usable && (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertTriangle className="size-3.5" aria-hidden /> {t("notUsable")}
                </p>
              )}
            </div>
          );
        })}
        {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      </CardContent>
    </Card>
  );
}
