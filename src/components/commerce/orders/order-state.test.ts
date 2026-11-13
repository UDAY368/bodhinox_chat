import { describe, expect, it } from "vitest";
import {
  canCancelUnpaid, canTakeLinkPayment, csvCell, fulfilmentState, nextStep, orderRef, paymentState, toCsv, updateTextKey,
} from "./order-state";

describe("paymentState", () => {
  it("shows refunds first, then paid, cash on delivery and pending", () => {
    expect(paymentState({ status: "cancelled", paid_at: "x", refund_state: "full" })).toBe("refunded");
    expect(paymentState({ status: "paid", paid_at: "x", refund_state: "partial" })).toBe("partlyRefunded");
    expect(paymentState({ status: "dispatched", paid_at: "x", refund_state: "none" })).toBe("paid");
    expect(paymentState({ status: "confirmed", paid_at: null, payment_method: "cod" })).toBe("cod");
    expect(paymentState({ status: "cancelled", paid_at: null, payment_method: "cod" })).toBe("pending");
    expect(paymentState({ status: "awaiting_payment" })).toBe("pending");
  });
});

describe("fulfilmentState", () => {
  it("maps every order status to a fulfilment label", () => {
    expect(fulfilmentState("paid")).toBe("new");
    expect(fulfilmentState("awaiting_payment")).toBe("new");
    expect(fulfilmentState("confirmed")).toBe("confirmed");
    expect(fulfilmentState("dispatched")).toBe("shipped");
    expect(fulfilmentState("fulfilled")).toBe("delivered");
    expect(fulfilmentState("cancelled")).toBe("cancelled");
    expect(fulfilmentState("expired")).toBe("expired");
    expect(fulfilmentState("payment_review")).toBe("review");
  });
});

describe("nextStep", () => {
  const priced = "2026-11-13T10:00:00Z";
  it("offers only the moves the server allows", () => {
    expect(nextStep({ status: "paid", priced_at: priced })).toBe("ship");
    expect(nextStep({ status: "dispatched", priced_at: priced })).toBe("deliver");
    // A priced manual order waits for payment before it can ship.
    expect(nextStep({ status: "confirmed", priced_at: priced, payment_method: "online" })).toBeNull();
    // Unpaid cash on delivery ships first.
    expect(nextStep({ status: "confirmed", priced_at: priced, payment_method: "cod", paid_at: null })).toBe("ship");
    // A legacy unpriced cart is confirmed, then delivered.
    expect(nextStep({ status: "new", priced_at: null })).toBe("confirm");
    expect(nextStep({ status: "confirmed", priced_at: null })).toBe("deliver");
    expect(nextStep({ status: "fulfilled", priced_at: priced })).toBeNull();
    expect(nextStep({ status: "cancelled", priced_at: priced })).toBeNull();
  });
  it("never ships an order refunded in full", () => {
    expect(nextStep({ status: "paid", priced_at: priced, refund_state: "full" })).toBeNull();
  });
});

describe("payment actions", () => {
  it("offers a link or a cancel only while nothing is paid", () => {
    expect(canTakeLinkPayment({ status: "confirmed", paid_at: null, payment_method: "online" })).toBe(true);
    expect(canTakeLinkPayment({ status: "confirmed", paid_at: null, payment_method: "cod" })).toBe(false);
    expect(canTakeLinkPayment({ status: "paid", paid_at: "x" })).toBe(false);
    expect(canCancelUnpaid({ status: "awaiting_payment", paid_at: null })).toBe(true);
    expect(canCancelUnpaid({ status: "confirmed", paid_at: null, amount_paid_minor: 100 })).toBe(false);
    expect(canCancelUnpaid({ status: "dispatched", paid_at: null })).toBe(false);
  });
});

describe("updateTextKey and orderRef", () => {
  it("picks the update text and the visible reference", () => {
    expect(updateTextKey("dispatched")).toBe("dispatched");
    expect(updateTextKey("awaiting_payment")).toBe("other");
    expect(orderRef({ id: "abcdef12-0000", external_id: "1042" })).toBe("#1042");
    expect(orderRef({ id: "abcdef12-0000", external_id: null })).toBe("ABCDEF12");
  });
});

describe("CSV export", () => {
  it("quotes cells and neutralises spreadsheet formulas", () => {
    expect(csvCell('Asha "A"')).toBe('"Asha ""A"""');
    expect(csvCell("=HYPERLINK(1)")).toBe(`"'=HYPERLINK(1)"`);
    expect(csvCell("+91 98")).toBe(`"'+91 98"`);
    expect(csvCell(null)).toBe('""');
    expect(toCsv([["a", 1], ["b", 2]])).toBe('"a","1"\r\n"b","2"');
  });
});
