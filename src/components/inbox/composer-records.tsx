"use client";

// The composer's + menu: New order, New quote and New deal for the chat's
// contact, already chosen. Agents and above only (the same role the orders,
// quotes and deals APIs require); the composer hides the items otherwise.
// None of them sends a message by itself, so they stay usable when the
// 24-hour window is closed (a quote's or order's link send is checked by the server).
import { useTranslations } from "next-intl";
import { FileText, Handshake, ShoppingCart } from "lucide-react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { NewOrderDialog } from "@/components/commerce/orders/new-order-dialog";
import { NewDealSheet } from "@/components/pipelines/new-deal-sheet";

export type ComposerRecord = "order" | "quote" | "deal";
export interface ComposerContact {
  id: string;
  name: string | null;
  phone: string | null;
}

export function ComposerRecordItems({ onOpen }: { onOpen: (record: ComposerRecord) => void }) {
  const t = useTranslations("Inbox.composer");
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => onOpen("order")}>
        <ShoppingCart className="mr-2 h-4 w-4" />
        {t("newOrder")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onOpen("quote")}>
        <FileText className="mr-2 h-4 w-4" />
        {t("newQuote")}
      </DropdownMenuItem>
      <DropdownMenuItem onClick={() => onOpen("deal")}>
        <Handshake className="mr-2 h-4 w-4" />
        {t("newDeal")}
      </DropdownMenuItem>
    </>
  );
}

export function ComposerRecordDialogs({ open, contact, onClose }: {
  open: ComposerRecord | null;
  contact: ComposerContact;
  onClose: () => void;
}) {
  const defaultContact = { id: contact.id, name: contact.name, phone: contact.phone };
  return (
    <>
      <NewOrderDialog
        open={open === "order" || open === "quote"}
        mode={open === "quote" ? "quote" : "order"}
        defaultContact={defaultContact}
        onOpenChange={(value) => !value && onClose()}
        onCreated={() => onClose()}
      />
      <NewDealSheet
        open={open === "deal"}
        defaultContact={defaultContact}
        onOpenChange={(value) => !value && onClose()}
        onSaved={() => onClose()}
      />
    </>
  );
}
