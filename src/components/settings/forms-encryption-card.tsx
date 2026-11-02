"use client";

/**
 * Settings → WhatsApp: the encryption key for WhatsApp Forms that check
 * answers on our server. Meta encrypts those requests with the public key of
 * the number the form was sent from, so each number has its own key; with two
 * or more numbers the card shows a picker (the empty choice is the default).
 * Generating one uploads the public half to Meta and keeps the private half
 * (encrypted) on the server. The browser only sees the status.
 */

import { useEffect, useState } from "react";
import { KeyRound, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authFetch } from "@/lib/auth/client";
import { NumberSelect } from "./numbers/number-select";
import { useWhatsAppNumbers } from "./numbers/use-whatsapp-numbers";

type KeyStatus = { number_id: string | null; configured: boolean; uploaded_at: string | null };

const endpoint = (numberId: string | null) =>
  numberId ? `/api/whatsapp/forms/encryption-key?number=${encodeURIComponent(numberId)}` : "/api/whatsapp/forms/encryption-key";

/** `numberId` preselects a number (the one the settings form is editing; remount with a key to change it); null means the default. */
export function FormsEncryptionCard({ canEdit, numberId: initialNumberId = null }: { canEdit: boolean; numberId?: string | null }) {
  const t = useTranslations("Settings.formsEncryption");
  const { numbers } = useWhatsAppNumbers();
  const [numberId, setNumberId] = useState<string | null>(initialNumberId);
  const [status, setStatus] = useState<KeyStatus | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let live = true;
    setStatus(null);
    setLoadFailed(false);
    authFetch(endpoint(numberId), { cache: "no-store" })
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((json: KeyStatus) => { if (live) setStatus(json); })
      .catch(() => { if (live) setLoadFailed(true); });
    return () => { live = false; };
  }, [numberId]);

  const generate = async () => {
    if (status?.configured && !window.confirm(t("rotateConfirm"))) return;
    setWorking(true);
    try {
      // Rotate the number whose status is shown, even if the default changed meanwhile.
      const res = await authFetch(endpoint(status?.number_id ?? numberId), { method: "POST" });
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
        {numbers.length > 1 && (
          <>
            <label htmlFor="forms-encryption-number" className="sr-only">{t("numberLabel")}</label>
            <NumberSelect
              id="forms-encryption-number"
              numbers={numbers}
              value={numberId}
              onChange={setNumberId}
              emptyLabel={t("defaultNumber")}
              disabled={working}
            />
          </>
        )}
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
