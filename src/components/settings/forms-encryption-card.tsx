"use client";

/**
 * Settings → WhatsApp: the encryption key for WhatsApp Forms that check
 * answers on our server. Meta encrypts those requests with the number's
 * public key; generating one uploads the public half to Meta and keeps the
 * private half (encrypted) on the server. The browser only sees the status.
 */

import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth/client";

type KeyStatus = { configured: boolean; uploaded_at: string | null };

export function FormsEncryptionCard({ canEdit }: { canEdit: boolean }) {
  const t = useTranslations("Settings.formsEncryption");
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    authFetch("/api/whatsapp/forms/encryption-key", { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: KeyStatus) => { if (live) setStatus(json); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, []);

  const generate = async () => {
    if (status?.configured && !window.confirm(t("rotateConfirm"))) return;
    setWorking(true);
    try {
      const res = await authFetch("/api/whatsapp/forms/encryption-key", { method: "POST" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof json.error === "string" ? json.error : t("generateFailed"));
      setStatus(json as KeyStatus);
      toast.success(t("generated"));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t("generateFailed"));
    } finally {
      setWorking(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">{t("title")}</CardTitle>
        <CardDescription className="text-muted-foreground">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {!status && !loadFailed ? (
          <Loader2 className="size-4 animate-spin text-primary" />
        ) : (
          <>
            <p className={loadFailed ? "text-xs text-destructive" : "text-xs text-muted-foreground"}>
              {loadFailed
                ? t("loadFailed")
                : status?.configured && status.uploaded_at
                  ? t("configuredAt", { date: new Date(status.uploaded_at).toLocaleString() })
                  : t("notConfigured")}
            </p>
            {canEdit && !loadFailed && (
              <div className="space-y-1">
                <Button type="button" size="sm" variant={status?.configured ? "outline" : "default"} onClick={generate} disabled={working}>
                  {working ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
                  {status?.configured ? t("rotate") : t("generate")}
                </Button>
                {status?.configured && <p className="text-xs text-muted-foreground">{t("rotateHint")}</p>}
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
