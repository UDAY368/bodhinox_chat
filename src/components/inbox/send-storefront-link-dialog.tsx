"use client";

/**
 * "Send storefront link" from the inbox (design E12): issues a secure link
 * bound to this conversation's contact (the store, or the status of their
 * latest order) and sends it from the conversation's number. Permission
 * commerce.checkout. The link itself never reaches this browser: only the
 * customer receives it. One client request id per open dialog, so a double
 * click or a retry never sends twice.
 */
import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { storeApi } from "@/components/commerce/settings/settings-api";

export interface SendStorefrontLinkDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}

const MESSAGE_MAX = 900;

export function SendStorefrontLinkDialog({ open, onOpenChange, conversationId }: SendStorefrontLinkDialogProps) {
  const t = useTranslations("Commerce.storefrontLink");
  const te = useTranslations("Commerce.settings.errors");
  const [purpose, setPurpose] = useState<"shop" | "status">("shop");
  const [ttl, setTtl] = useState("24");
  const [message, setMessage] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    setError(null);
    setMessage((m) => m || t("defaultMessage"));
  }, [open, t]);

  const hours = Number(ttl);
  const ttlValid = Number.isInteger(hours) && hours >= 1 && hours <= 168;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await storeApi.sendLink({
        conversation_id: conversationId, purpose, ttl_hours: hours, message: message.trim() || null, client_request_id: requestId,
      });
      if (r.ok) {
        toast.success(t("sent"));
        onOpenChange(false);
        return;
      }
      setError(r.code ? te(r.code as never) : r.error ?? t("failed"));
      // An unknown outcome may have reached the customer: never offer a second send of the same request.
      if (r.code !== "send_uncertain") setRequestId(crypto.randomUUID());
    } catch {
      setError(t("failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <RadioGroup value={purpose} onValueChange={(v) => setPurpose(v as "shop" | "status")} aria-label={t("purpose")}>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="sfl-shop" value="shop" />
              <Label htmlFor="sfl-shop">{t("purposeShop")}</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem id="sfl-status" value="status" />
              <Label htmlFor="sfl-status">{t("purposeStatus")}</Label>
            </div>
          </RadioGroup>
          <div className="space-y-1">
            <Label htmlFor="sfl-ttl">{t("ttl")}</Label>
            <Input id="sfl-ttl" type="number" min={1} max={168} value={ttl} onChange={(e) => setTtl(e.target.value)} aria-invalid={!ttlValid} />
            <p className="text-xs text-muted-foreground">{t("ttlHelp")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="sfl-message">{t("message")}</Label>
            <Textarea id="sfl-message" value={message} maxLength={MESSAGE_MAX} onChange={(e) => setMessage(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t("messageHelp")}</p>
          </div>
          {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{t("cancel")}</Button>
          <Button onClick={submit} disabled={busy || !ttlValid || !requestId}>
            {busy && <Loader2 className="size-4 animate-spin" aria-hidden />} {t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
