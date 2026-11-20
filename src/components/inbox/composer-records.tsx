"use client";

// The composer's + menu: New order, New quote, New deal and New booking for the chat's
// contact, already chosen. Agents and above only (the same role the orders,
// quotes and deals APIs require); the composer hides the items otherwise.
// None of them sends a message by itself, so they stay usable when the
// 24-hour window is closed (a quote's or order's link send is checked by the server).
import { useTranslations } from "next-intl";
import { CalendarPlus, FileText, Handshake, ShoppingCart } from "lucide-react";
import { useEffect } from "react";

import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { NewOrderDialog } from "@/components/commerce/orders/new-order-dialog";
import { NewDealSheet } from "@/components/pipelines/new-deal-sheet";
import { useNewBookingDialog } from "@/components/appointments/contact-appointments-card";

export type ComposerRecord = "order" | "quote" | "deal" | "booking";
export interface ComposerContact {
  id: string;
  name?: string | null;
  phone?: string | null;
}

export function ComposerRecordItems({ onOpen }: { onOpen: (record: ComposerRecord) => void }) {
  const t = useTranslations("Inbox.composer");
  const tb = useTranslations("Appointments.contactCard");
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
      <DropdownMenuItem onClick={() => onOpen("booking")}>
        <CalendarPlus className="mr-2 h-4 w-4" />
        {tb("newBooking")}
      </DropdownMenuItem>
    </>
  );
}

export function ComposerRecordDialogs({ open, contact, onClose }: {
  open: ComposerRecord | null;
  contact: ComposerContact;
  onClose: () => void;
}) {
  const defaultContact = { id: contact.id, name: contact.name ?? null, phone: contact.phone ?? null };
  // The booking dialog (batch 3) owns its own open state; the menu choice just opens it.
  const booking = useNewBookingDialog({ id: contact.id, name: contact.name ?? null });
  const openBooking = booking.open;
  useEffect(() => {
    if (open !== "booking") return;
    openBooking();
    onClose();
  }, [open, openBooking, onClose]);
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
      {booking.dialog}
    </>
  );
}
