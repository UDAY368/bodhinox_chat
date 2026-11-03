"use client";

/**
 * Record a payment taken outside the gateway (cash, bank transfer…) for an
 * order, for exactly what is still due (admins with the record-payments
 * permission). Any open payment link for the order is cancelled first. Shown
 * on the order as staff-recorded. Mounted by the order detail page.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatMoney, minorToDecimalString } from "@/lib/commerce/money";
import { OFFLINE_METHODS, recordOfflinePayment, type OfflineMethod } from "./customer-payments-api";

export function OfflinePaymentDialog({ orderId, currency, dueMinor, open, onOpenChange, onRecorded }: {
  orderId: string;
  currency: string;
  /** What the order still owes (total − already paid). */
  dueMinor: number;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded?: (paymentId: string) => void;
}) {
  const t = useTranslations("Payments.offline");
  const locale = useLocale();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<OfflineMethod>("cash");
  const [reference, setReference] = useState("");
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setRequestId(crypto.randomUUID());
    setAmount(minorToDecimalString(Math.max(dueMinor, 0), currency));
    setMethod("cash");
    setReference("");
  }, [open, dueMinor, currency]);

  const submit = async () => {
    setBusy(true);
    try {
      const paymentId = await recordOfflinePayment(orderId, { amount: amount.trim(), method, reference: reference.trim() || undefined, client_request_id: requestId }, t("failed"));
      toast.success(t("recorded"));
      onRecorded?.(paymentId);
      onOpenChange(false);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      if (status >= 400 && status < 500 && status !== 429) setRequestId(crypto.randomUUID());
      toast.error(err instanceof Error ? err.message : t("failed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description", { amount: formatMoney(Math.max(dueMinor, 0), currency, locale) })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="offline-amount" className="mb-1 block text-xs text-muted-foreground">{t("amount", { currency })}</Label>
            <Input id="offline-amount" inputMode="decimal" value={amount} maxLength={20} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">{t("method")}</Label>
            <Select value={method} onValueChange={(v) => v && setMethod(v as OfflineMethod)}>
              <SelectTrigger className="w-full" aria-label={t("method")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {OFFLINE_METHODS.map((m) => <SelectItem key={m} value={m}>{t(`methods.${m}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="offline-reference" className="mb-1 block text-xs text-muted-foreground">{t("reference")}</Label>
            <Input id="offline-reference" value={reference} maxLength={100} onChange={(e) => setReference(e.target.value)} />
          </div>
          <p className="text-xs text-muted-foreground">{t("help")}</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button onClick={() => void submit()} disabled={busy || !amount.trim() || !requestId}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
