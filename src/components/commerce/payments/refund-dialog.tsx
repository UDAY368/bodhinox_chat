"use client";

/**
 * Refund part or all of a gateway payment (admins with the refunds
 * permission). One request id per dialog opening: a retried click returns the
 * same refund. Razorpay is asked once, in the background; the refund shows as
 * pending until Razorpay reports it processed.
 */

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { formatMoney, minorToDecimalString, parseMoney } from "@/lib/commerce/money";
import { REFUND_REASONS, requestRefund, type CustomerPaymentItem, type RefundReason } from "./customer-payments-api";

export function RefundDialog({ payment, open, onOpenChange, onRequested, defaultRestock = false }: {
  payment: CustomerPaymentItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRequested?: (refundId: string) => void;
  /**
   * Pre-ticks "put the items back in stock" (an undispatched order), but only
   * while the amount is the full refundable balance: the server restocks
   * nothing for a partial refund of an order that still ships.
   */
  defaultRestock?: boolean;
}) {
  const t = useTranslations("Payments.refunds");
  const locale = useLocale();
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState<RefundReason>("customer_request");
  const [note, setNote] = useState("");
  const [restockChoice, setRestockChoice] = useState<boolean | null>(null);
  const [requestId, setRequestId] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !payment) return;
    setRequestId(crypto.randomUUID());
    setAmount(minorToDecimalString(payment.refundable_minor, payment.currency));
    setReason("customer_request");
    setNote("");
    setRestockChoice(null);
  }, [open, payment]);

  if (!payment) return null;

  const isFull = (() => {
    try { return parseMoney(amount, payment.currency) === payment.refundable_minor; } catch { return false; }
  })();
  // Until staff tick or untick it, the box follows the amount.
  const restock = restockChoice ?? (defaultRestock && isFull);

  const submit = async () => {
    setBusy(true);
    try {
      const refundId = await requestRefund(payment.id, { amount: amount.trim(), reason, note: note.trim() || undefined, restock, client_request_id: requestId }, t("failed"));
      toast.success(t("requested"));
      onRequested?.(refundId);
      onOpenChange(false);
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      // A definite refusal created nothing; anything else keeps the id so a retry cannot refund twice.
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
          <DialogDescription>{t("description", { amount: formatMoney(payment.refundable_minor, payment.currency, locale) })}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <Label htmlFor="refund-amount" className="mb-1 block text-xs text-muted-foreground">{t("amount", { currency: payment.currency })}</Label>
            <Input id="refund-amount" inputMode="decimal" value={amount} maxLength={20} onChange={(e) => setAmount(e.target.value)} />
          </div>
          <div>
            <Label className="mb-1 block text-xs text-muted-foreground">{t("reason")}</Label>
            <Select value={reason} onValueChange={(v) => v && setReason(v as RefundReason)}>
              <SelectTrigger className="w-full" aria-label={t("reason")}><SelectValue /></SelectTrigger>
              <SelectContent>
                {REFUND_REASONS.map((r) => <SelectItem key={r} value={r}>{t(`reasons.${r}`)}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label htmlFor="refund-note" className="mb-1 block text-xs text-muted-foreground">{t("note")}</Label>
            <Textarea id="refund-note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
          </div>
          {payment.order_id && (
            <label className="flex items-start gap-2 text-sm">
              <Checkbox checked={restock} onCheckedChange={(v) => setRestockChoice(v === true)} />
              <span>
                {t("restock")}
                <span className="block text-xs text-muted-foreground">{t("restockHelp")}</span>
              </span>
            </label>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("cancel")}</Button>
          <Button variant="destructive" onClick={() => void submit()} disabled={busy || !amount.trim() || !requestId}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t("submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
