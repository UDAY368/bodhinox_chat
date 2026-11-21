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
import { useConfirm } from "@/components/ui/confirm-dialog";
import { authFetch } from "@/lib/auth/client";
import { NumberSelect } from "./numbers/number-select";
import { useWhatsAppNumbers } from "./numbers/use-whatsapp-numbers";
import { GroupedListRow } from "@/components/ui/grouped-list";
import { cn } from "@/lib/utils";
import { SETTINGS_ROW_HAIRLINE, SettingsGroup, SettingsRow } from "./settings-row";

type KeyStatus = { number_id: string | null; configured: boolean; uploaded_at: string | null };

const endpoint = (numberId: string | null) =>
  numberId ? `/api/whatsapp/forms/encryption-key?number=${encodeURIComponent(numberId)}` : "/api/whatsapp/forms/encryption-key";

/** `numberId` preselects a number (the one the settings form is editing; remount with a key to change it); null means the default. */
export function FormsEncryptionCard({ canEdit, numberId: initialNumberId = null }: { canEdit: boolean; numberId?: string | null }) {
  const t = useTranslations("Settings.formsEncryption");
  const confirm = useConfirm();
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
    if (status?.configured && !(await confirm({ title: t("rotateConfirm"), confirmLabel: t("rotate"), destructive: true }))) return;
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

  const loading = !status && !loadFailed;
  return (
    <SettingsGroup
      title={t("title")}
      footer={status?.configured && canEdit && !loadFailed ? <>{t("description")} {t("rotateHint")}</> : t("description")}
      action={canEdit && !loadFailed && !loading ? (
        <Button type="button" size="sm" className="min-h-11 sm:min-h-8" variant={status?.configured ? "outline" : "default"} onClick={generate} disabled={working}>
          {working ? <Loader2 className="size-3.5 animate-spin" /> : <KeyRound className="size-3.5" />}
          {status?.configured ? t("rotate") : t("generate")}
        </Button>
      ) : undefined}
    >
      {numbers.length > 1 && (
        <SettingsRow label={t("numberLabel")} htmlFor="forms-encryption-number">
          <NumberSelect
            id="forms-encryption-number"
            numbers={numbers}
            value={numberId}
            onChange={setNumberId}
            emptyLabel={t("defaultNumber")}
            disabled={working}
          />
        </SettingsRow>
      )}
      {loading ? (
        <div className={cn(SETTINGS_ROW_HAIRLINE, "flex min-h-11 items-center px-4 py-3")} aria-busy="true">
          <div className="h-3.5 w-1/2 animate-pulse rounded bg-muted" />
        </div>
      ) : (
        <GroupedListRow
          leading={<KeyRound className={loadFailed ? "size-4 text-destructive" : "size-4 text-muted-foreground"} aria-hidden />}
          title={
            <span className={loadFailed ? "text-sm text-destructive" : "text-sm"}>
              {loadFailed
                ? t("loadFailed")
                : status?.configured && status.uploaded_at
                  ? t("configuredAt", { date: new Date(status.uploaded_at).toLocaleString() })
                  : t("notConfigured")}
            </span>
          }
        />
      )}
    </SettingsGroup>
  );
}
