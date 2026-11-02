"use client";

/**
 * "Send payment link" from the inbox: an amount, an optional description
 * and message, then the server creates a Razorpay link and sends it from
 * the conversation's number. One request id per attempt, so a double click
 * or a retry after an unknown outcome never creates or sends twice. When
 * the link exists but the message did not go out, "Send again" re-sends
 * that same link instead of creating a new one.
 */

import { useEffect, useState } from "react";
import { Loader2, Send } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAuth } from "@/hooks/use-auth";
import { authFetch } from "@/lib/auth/client";

const MESSAGE_MAX = 900;
const DESCRIPTION_MAX = 200;
const EXPIRY_CHOICES = ["none", "60", "1440", "10080"] as const;

interface CreatedLink {
  id: string;
  short_url: string | null;
  status: string;
}

type SendOutcome = { status: "sent" | "refused" | "rejected" | "uncertain"; error?: string } | null;

/**
 * Whether a failed create should get a new request id. A 4xx other than a
 * reference conflict means nothing was created. A 502 whose code says
 * Razorpay definitely refused it (provider_rejected / provider_auth: the row
 * is already marked failed) also rotates, so the agent can fix the amount and
 * try again. Any other 5xx or a network failure keeps the id, so the retry
 * reconciles instead of creating.
 */
export function createRejectedDefinitely(status: number, code?: string): boolean {
  if (code === "provider_rejected" || code === "provider_auth") return true;
  return status >= 400 && status < 500 && status !== 409 && status !== 429;
}

export function SendPaymentLinkDialog({ open, onOpenChange, conversationId }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversationId: string;
}) {
  const t = useTranslations("Inbox.sendPaymentLink");
  const { defaultCurrency } = useAuth();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [description, setDescription] = useState("");
  const [message, setMessage] = useState("");
  const [expiry, setExpiry] = useState<(typeof EXPIRY_CHOICES)[number]>("1440");
  const [busy, setBusy] = useState(false);
  const [requestId, setRequestId] = useState("");
  const [link, setLink] = useState<CreatedLink | null>(null);
  const [lastSend, setLastSend] = useState<SendOutcome>(null);

  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    setLink(null);
    setLastSend(null);
    setCurrency(defaultCurrency || "INR");
    setMessage((m) => m || t("defaultMessage"));
  }, [open, defaultCurrency, t]);

  const finish = (send: SendOutcome) => {
    setLastSend(send);
    if (send?.status === "sent") {
      toast.success(t("sent"));
      setAmount("");
      setDescription("");
      onOpenChange(false);
      return;
    }
    toast.error(send?.error || t("sendFailed"));
    // A refusal or Meta's rejection sent nothing: the next try is a new send.
    // An uncertain outcome keeps the id so it is never sent twice.
    if (send?.status !== "uncertain") setRequestId(crypto.randomUUID());
  };

  const create = async () => {
    setBusy(true);
    try {
      const res = await authFetch("/api/payments/links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          amount: amount.trim(),
          currency,
          description: description.trim() || undefined,
          message,
          conversation_id: conversationId,
          expire_minutes: expiry === "none" ? undefined : Number(expiry),
          send: true,
          client_request_id: requestId,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; code?: string; link?: CreatedLink; send?: SendOutcome };
      if (!res.ok) {
        if (createRejectedDefinitely(res.status, json.code)) setRequestId(crypto.randomUUID());
        toast.error(json.error || t("createFailed"));
        return;
      }
      if (json.link?.status === "failed") {
        // A replay found the earlier, refused create: nothing exists to send.
        // Start a fresh attempt and keep the form editable.
        setRequestId(crypto.randomUUID());
        toast.error(t("createFailed"));
        return;
      }
      if (json.link) setLink(json.link);
      if (!json.send) {
        // Created but not sendable yet (its outcome is being confirmed).
        toast.error(t("notReady"));
        return;
      }
      finish(json.send);
    } catch {
      toast.error(t("createFailed"));
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    if (!link) return;
    setBusy(true);
    try {
      const res = await authFetch(`/api/payments/links/${link.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "send", message, client_request_id: requestId }),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string; send?: SendOutcome };
      if (json.send) finish(json.send);
      else toast.error(json.error || t("sendFailed"));
    } catch {
      toast.error(t("sendFailed"));
    } finally {
      setBusy(false);
    }
  };

  const ready = !busy && Boolean(requestId) && (link ? true : amount.trim().length > 0 && /^[A-Z]{3}$/.test(currency));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        {link ? (
          <div className="space-y-2 text-sm">
            <p>{t("linkCreated")}</p>
            {link.short_url && <p className="break-all font-mono text-xs text-muted-foreground">{link.short_url}</p>}
            {lastSend?.status === "uncertain" && <p className="text-xs text-amber-600 dark:text-amber-400">{t("uncertainHelp")}</p>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <div>
                <Label htmlFor="pay-amount" className="mb-1 block text-xs text-muted-foreground">{t("amount")}</Label>
                <Input id="pay-amount" inputMode="decimal" value={amount} maxLength={20} placeholder="499.00" onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="pay-currency" className="mb-1 block text-xs text-muted-foreground">{t("currency")}</Label>
                <Input id="pay-currency" value={currency} maxLength={3} className="font-mono uppercase"
                  onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
              </div>
            </div>
            <div>
              <Label htmlFor="pay-description" className="mb-1 block text-xs text-muted-foreground">{t("description")}</Label>
              <Input id="pay-description" value={description} maxLength={DESCRIPTION_MAX} onChange={(e) => setDescription(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="pay-expiry" className="mb-1 block text-xs text-muted-foreground">{t("expiry")}</Label>
              <Select value={expiry} onValueChange={(v) => setExpiry((v ?? "1440") as (typeof EXPIRY_CHOICES)[number])}>
                <SelectTrigger id="pay-expiry" className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {EXPIRY_CHOICES.map((c) => <SelectItem key={c} value={c}>{t(`expiry_${c}`)}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
        <div>
          <Label htmlFor="pay-message" className="mb-1 block text-xs text-muted-foreground">{t("message", { max: MESSAGE_MAX })}</Label>
          <Textarea id="pay-message" value={message} maxLength={MESSAGE_MAX} rows={3} onChange={(e) => setMessage(e.target.value)} />
          <p className="mt-1 text-xs text-muted-foreground">{t("windowHelp")}</p>
        </div>
        <DialogFooter>
          <Button onClick={() => void (link ? resend() : create())} disabled={!ready}>
            {busy ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Send className="mr-1 h-4 w-4" />}
            {link ? t("sendAgain") : t("send")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
