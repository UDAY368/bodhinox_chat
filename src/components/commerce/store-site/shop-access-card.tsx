"use client";

/**
 * Commerce → Online store → Who can see the shop (store plan Phase 8): open, behind a password, or "coming
 * soon". Admins edit; agents read (the API and RLS enforce the same rule). The password is write-only: the
 * server keeps only a salted hash and says whether one is set.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { authFetch } from "@/lib/auth/client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SHOP_ACCESS_MODES, type ShopAccessMode } from "@/lib/commerce/selling-rules";

interface Access { mode: ShopAccessMode; passwordSet: boolean; comingSoonMessage: string | null; shopSaved: boolean }

export function ShopAccessCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Commerce.storeSite.access");
  const te = useTranslations("Commerce.settings.errors");
  const [access, setAccess] = useState<Access | null>(null);
  const [mode, setMode] = useState<ShopAccessMode>("open");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    authFetch("/api/commerce/shop-access", { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json()) as { access: Access };
        setAccess(data.access);
        setMode(data.access.mode);
        setMessage(data.access.comingSoonMessage ?? "");
      })
      .catch(() => undefined);
  }, []);

  if (!access) return null;
  const passwordOk = password === "" || (password.length >= 6 && password.length <= 72);
  const needsPassword = mode === "password" && !access.passwordSet && password === "";

  const save = async () => {
    setBusy(true);
    const res = await authFetch("/api/commerce/shop-access", {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode, password: password || undefined, comingSoonMessage: message.trim() || null }),
    }).catch(() => null);
    setBusy(false);
    const data = (await res?.json().catch(() => ({}))) as { access?: Access; code?: string };
    if (!res?.ok || !data.access) {
      toast.error(data.code && te.has(data.code as never) ? te(data.code as never) : te("invalid"));
      return;
    }
    setAccess(data.access);
    setPassword("");
    toast.success(t("saved"));
  };

  return (
    <Card id="access">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("hint")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!access.shopSaved && <p className="text-sm text-muted-foreground">{t("needsShop")}</p>}
        <fieldset className="space-y-2" disabled={!canEdit || !access.shopSaved}>
          <legend className="sr-only">{t("title")}</legend>
          {SHOP_ACCESS_MODES.map((m) => (
            <label key={m} className="flex items-start gap-2 text-sm">
              <input type="radio" name="shop-access-mode" className="mt-0.5 size-4" checked={mode === m} onChange={() => setMode(m)} />
              <span>
                <span className="block font-medium text-foreground">{t(`modes.${m}`)}</span>
                <span className="block text-xs text-muted-foreground">{t(`modeHints.${m}`)}</span>
              </span>
            </label>
          ))}
        </fieldset>
        {mode === "password" && (
          <div className="space-y-1.5 sm:max-w-sm">
            <Label htmlFor="shop-access-password">{access.passwordSet ? t("newPassword") : t("password")}</Label>
            <Input id="shop-access-password" type="password" autoComplete="new-password" maxLength={72} disabled={!canEdit}
              value={password} onChange={(e) => setPassword(e.target.value)} />
            <p className="text-xs text-muted-foreground">{access.passwordSet ? t("passwordKept") : t("passwordHint")}</p>
            {!passwordOk && <p className="text-xs text-destructive" role="alert">{t("passwordLength")}</p>}
          </div>
        )}
        {mode === "coming_soon" && (
          <div className="space-y-1.5">
            <Label htmlFor="shop-access-message">{t("message")}</Label>
            <Textarea id="shop-access-message" rows={3} maxLength={500} disabled={!canEdit} value={message} onChange={(e) => setMessage(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("messageHint")}</p>
          </div>
        )}
        <p className="text-xs text-muted-foreground">{t("previewNote")}</p>
        {canEdit && (
          <Button type="button" onClick={save} disabled={busy || !access.shopSaved || !passwordOk || needsPassword}>
            {busy && <Loader2 className="size-4 animate-spin" />}{t("save")}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
