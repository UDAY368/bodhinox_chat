"use client";

import { useEffect, useState } from "react";
import { useFormatter, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FileText, Loader2 } from "lucide-react";

import { useCan } from "@/hooks/use-can";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listQuotes, revokeQuote, type QuoteListItem } from "./orders-list-api";
import { ListError, RowPlaceholders } from "./list-states";
import { StateBadge } from "./state-badge";
import type { Tone } from "@/lib/commerce/order-state";

const TONE: Record<QuoteListItem["state"], Tone> = { open: "accent", ordered: "ok", expired: "neutral", revoked: "bad" };

/** The 50 newest quotes sent from this workspace, with their state; an open one can be revoked. */
export function QuotesList({ reloadKey, onNewQuote }: { reloadKey: number; onNewQuote?: () => void }) {
  const t = useTranslations("Commerce.orders.listing");
  const format = useFormatter();
  const canAct = useCan("send-messages");
  const [attempt, setAttempt] = useState(0);
  const [revoking, setRevoking] = useState<QuoteListItem | null>(null);
  const [busy, setBusy] = useState(false);
  // The answer is kept with the request it belongs to: anything older reads as still loading.
  const key = `${attempt}|${reloadKey}`;
  const [result, setResult] = useState<{ key: string; quotes: QuoteListItem[] | null } | null>(null);
  const quotes = result?.key === key ? result.quotes : null;
  const failed = result?.key === key && result.quotes === null;
  const setQuotes = (update: (prev: QuoteListItem[] | null) => QuoteListItem[] | null) =>
    setResult((prev) => (prev ? { ...prev, quotes: update(prev.quotes) } : prev));

  useEffect(() => {
    let cancelled = false;
    listQuotes()
      .then((next) => !cancelled && setResult({ key, quotes: next }))
      .catch(() => !cancelled && setResult({ key, quotes: null }));
    return () => { cancelled = true; };
  }, [key]);

  const confirmRevoke = async () => {
    if (!revoking) return;
    setBusy(true);
    const res = await revokeQuote(revoking.id).catch(() => ({ ok: false, status: 0 }));
    setBusy(false);
    if (!res.ok) {
      toast.error(res.status === 403 ? t("forbidden") : t("quotes.revokeFailed"));
      return;
    }
    toast.success(t("quotes.revoked"));
    setQuotes((prev) => prev?.map((q) => (q.id === revoking.id ? { ...q, state: "revoked" } : q)) ?? prev);
    setRevoking(null);
  };

  if (failed) return <ListError message={t("quotes.loadError")} retry={t("retry")} onRetry={() => setAttempt((n) => n + 1)} />;
  if (!quotes) return <RowPlaceholders label={t("loading")} />;
  if (quotes.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-border px-6 py-14 text-center">
        <FileText className="h-6 w-6 text-muted-foreground" />
        <p className="mt-3 text-sm text-muted-foreground">{t("quotes.empty")}</p>
        {canAct && onNewQuote && <Button className="mt-4 min-h-11 sm:min-h-9" variant="outline" onClick={onNewQuote}>{t("quotes.new")}</Button>}
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <Table className="[&_td]:px-3.5 [&_td]:py-2.5">
          <TableHeader className="bg-muted [&_th]:h-9 [&_th]:px-3.5 [&_th]:text-xs [&_th]:font-semibold [&_th]:text-muted-foreground">
            <TableRow>
              <TableHead>{t("quotes.colCustomer")}</TableHead>
              <TableHead className="text-right">{t("quotes.colItems")}</TableHead>
              <TableHead>{t("quotes.colState")}</TableHead>
              <TableHead>{t("quotes.colSent")}</TableHead>
              <TableHead>{t("quotes.colExpires")}</TableHead>
              <TableHead><span className="sr-only">{t("quotes.colActions")}</span></TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {quotes.map((q) => (
              <TableRow key={q.id}>
                <TableCell className="max-w-[14rem]">
                  <div className="truncate font-medium">{q.contact?.name || t("unknownCustomer")}</div>
                  {q.note && <div className="truncate text-xs text-muted-foreground">{q.note}</div>}
                </TableCell>
                <TableCell className="text-right tabular-nums">{q.item_count}</TableCell>
                <TableCell><StateBadge tone={TONE[q.state]}>{t(`quotes.state.${q.state}`)}</StateBadge></TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(new Date(q.created_at), { dateStyle: "medium" })}</TableCell>
                <TableCell className="whitespace-nowrap text-muted-foreground">{format.dateTime(new Date(q.expires_at), { dateStyle: "medium", timeStyle: "short" })}</TableCell>
                <TableCell className="w-px text-right">
                  {canAct && q.state === "open" && (
                    <Button variant="ghost" size="sm" className="min-h-11 text-destructive hover:bg-destructive/10 sm:min-h-8" onClick={() => setRevoking(q)}>
                      {t("quotes.revoke")}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <Dialog open={revoking !== null} onOpenChange={(open) => !open && !busy && setRevoking(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("quotes.revokeTitle")}</DialogTitle>
            <DialogDescription>{t("quotes.revokeBody", { name: revoking?.contact?.name || t("unknownCustomer") })}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setRevoking(null)} disabled={busy}>{t("cancel")}</Button>
            <Button variant="destructive" onClick={() => void confirmRevoke()} disabled={busy}>
              {busy && <Loader2 className="h-4 w-4 animate-spin" />}
              {t("quotes.revokeGo")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
