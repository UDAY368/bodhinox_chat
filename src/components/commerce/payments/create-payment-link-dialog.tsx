"use client";

/**
 * Create a payment link without sending it (to share by copy, or for an
 * order). One request id per attempt: a retry after an unknown outcome
 * returns the same link instead of creating another.
 */

import { useEffect, useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { createPaymentLink, type PaymentLinkItem } from "./payment-api";

export function CreatePaymentLinkDialog({ open, onOpenChange, onCreated, orderId, initialAmount, initialCurrency }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: (link: PaymentLinkItem) => void;
  /** Ties the link to an order; the order turns 'paid' when it is paid. */
  orderId?: string;
  initialAmount?: string;
  initialCurrency?: string;
}) {
  const t = useTranslations("Payments.create");
  const { defaultCurrency } = useAuth();
  const [amount, setAmount] = useState("");
  const [currency, setCurrency] = useState("INR");
  const [description, setDescription] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<PaymentLinkItem | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    setCreated(null);
    setAmount(initialAmount ?? "");
    setCurrency(initialCurrency || defaultCurrency || "INR");
    setDescription("");
  }, [open, initialAmount, initialCurrency, defaultCurrency]);

  const submit = async () => {
    setBusy(true);
    try {
      const link = await createPaymentLink({
        amount: amount.trim(),
        currency,
        description: description.trim() || undefined,
        order_id: orderId,
        client_request_id: requestId,
      }, t("failed"));
      setCreated(link);
      onCreated?.(link);
      if (link.status === "unknown" || link.status === "creating") toast.message(t("unknownHelp"));
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      // A definite refusal created nothing; anything else keeps the id so the retry reconciles.
      if (status >= 400 && status < 500 && status !== 409 && status !== 429) setRequestId(crypto.randomUUID());
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created?.short_url) return;
    try {
      await navigator.clipboard.writeText(created.short_url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("copyFailed"));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        {created ? (
          <div className="space-y-2">
            <p className="text-sm">{created.short_url ? t("ready") : t("unknownHelp")}</p>
            {created.short_url && (
              <div className="flex gap-2">
                <Input readOnly value={created.short_url} className="bg-muted font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
                <Button variant="outline" size="sm" onClick={() => void copy()} aria-label={t("copy")}>
                  {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
                </Button>
              </div>
            )}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_96px] gap-2">
              <div>
                <Label htmlFor="new-link-amount" className="mb-1 block text-xs text-muted-foreground">{t("amount")}</Label>
                <Input id="new-link-amount" inputMode="decimal" value={amount} maxLength={20} placeholder="499.00" onChange={(e) => setAmount(e.target.value)} />
              </div>
              <div>
                <Label htmlFor="new-link-currency" className="mb-1 block text-xs text-muted-foreground">{t("currency")}</Label>
                <Input id="new-link-currency" value={currency} maxLength={3} className="font-mono uppercase"
                  onChange={(e) => setCurrency(e.target.value.toUpperCase().replace(/[^A-Z]/g, ""))} />
              </div>
            </div>
            <div>
              <Label htmlFor="new-link-description" className="mb-1 block text-xs text-muted-foreground">{t("description")}</Label>
              <Input id="new-link-description" value={description} maxLength={200} onChange={(e) => setDescription(e.target.value)} />
            </div>
          </div>
        )}
        <DialogFooter>
          {created ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>{t("done")}</Button>
          ) : (
            <Button onClick={() => void submit()} disabled={busy || !amount.trim() || !/^[A-Z]{3}$/.test(currency) || !requestId}>
              {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
              {t("submit")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
