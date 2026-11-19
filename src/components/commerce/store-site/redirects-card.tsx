"use client";

/**
 * Commerce -> Online store -> Redirects (store plan Phase 8, batch 7): send an old shop address to a new one. Both are paths inside the
 * shop (never another site); a rule only applies when the old address would otherwise be "page not found", so a live page is never
 * hidden. Admins edit; agents read (the API and RLS enforce the same rule).
 */
import { useCallback, useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Trash2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { REDIRECT_LIMIT } from "@/lib/commerce/shop-insights-rules";

interface Rule { id: string; from: string; to: string; code: 301 | 302; created_at: string }

export function RedirectsCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Commerce.storeSite.redirects");
  const te = useTranslations("Commerce.settings.errors");
  const format = useFormatter();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [handle, setHandle] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [code, setCode] = useState<301 | 302>(301);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await authFetch("/api/commerce/redirects", { cache: "no-store" }).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { redirects: Rule[]; handle: string };
    setRules(data.redirects);
    setHandle(data.handle);
  }, []);
  useEffect(() => {
    let live = true;
    authFetch("/api/commerce/redirects", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok || !live) return;
        const data = (await res.json()) as { redirects: Rule[]; handle: string };
        setRules(data.redirects);
        setHandle(data.handle);
      })
      .catch(() => undefined);
    return () => { live = false; };
  }, []);

  if (!rules) return null;
  const fail = (data: { code?: string }) => toast.error(data.code && te.has(data.code as never) ? te(data.code as never) : te("invalid"));

  const add = async () => {
    setBusy(true);
    const res = await authFetch("/api/commerce/redirects", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from, to, code }),
    }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => ({}))) as { redirect?: Rule; code?: string };
    if (!res?.ok || !data.redirect) { fail(data ?? {}); return; }
    setFrom("");
    setTo("");
    await load();
    toast.success(t("added"));
  };

  const remove = async (id: string) => {
    const res = await authFetch(`/api/commerce/redirects/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) { fail({}); return; }
    await load();
  };

  const prefix = handle ? `/s/${handle}` : "/s/…";
  return (
    <Card id="redirects">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint", { max: REDIRECT_LIMIT })}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canEdit && (
          <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
            <div className="space-y-1.5">
              <Label htmlFor="redirect-from">{t("from")}</Label>
              <Input id="redirect-from" value={from} maxLength={220} placeholder="/old-oil" onChange={(e) => setFrom(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="redirect-to">{t("to")}</Label>
              <Input id="redirect-to" value={to} maxLength={220} placeholder="/p/…" onChange={(e) => setTo(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="redirect-code">{t("type")}</Label>
              <select id="redirect-code" value={code} onChange={(e) => setCode(Number(e.target.value) === 302 ? 302 : 301)}
                className="h-9 w-full rounded-md border bg-background px-2 text-sm">
                <option value={301}>{t("permanent")}</option>
                <option value={302}>{t("temporary")}</option>
              </select>
            </div>
            <Button type="button" onClick={add} disabled={busy || !from.trim() || !to.trim()}>
              {busy && <Loader2 className="size-4 animate-spin" />}{t("add")}
            </Button>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("pathHint", { prefix })}</p>
        {rules.length === 0 ? <p className="text-sm text-muted-foreground">{t("none")}</p> : (
          <ul className="divide-y rounded-md border text-sm">
            {rules.map((r) => (
              <li key={r.id} className="flex items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1 break-all">
                  <code>{r.from}</code> <span aria-label={t("goesTo")}>→</span> <code>{r.to}</code>
                  <span className="ml-2 text-xs text-muted-foreground">{r.code === 301 ? t("permanent") : t("temporary")} · {format.dateTime(new Date(r.created_at), { dateStyle: "medium" })}</span>
                </span>
                {canEdit && (
                  <Button type="button" variant="ghost" size="icon" aria-label={t("remove", { from: r.from })} onClick={() => remove(r.id)}>
                    <Trash2 className="size-4" aria-hidden />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
