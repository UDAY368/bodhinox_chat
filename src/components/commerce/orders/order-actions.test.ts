// "Send payment link" keeps one idempotency key per order attempt: a retry after a timeout or an uncertain
// send repeats the same request (no second link, no second send); a definite outcome starts a new attempt.
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  listPaymentLinks: vi.fn(),
  createPaymentLinkWithSend: vi.fn(),
  sendPaymentLink: vi.fn(),
}));
vi.mock("@/components/commerce/payments/payment-api", () => ({
  ...api,
  LIVE_LINK: new Set(["created", "partially_paid"]),
}));
vi.mock("@/lib/auth/client", () => ({ authFetch: vi.fn() }));

import { clearPaymentLinkAttempt, pendingPaymentLinkAttempt, sendOrderPaymentLink } from "./order-actions";

const order = {
  id: "o1", currency: "INR", total_minor: 1000, subtotal_minor: 1000, amount_paid_minor: 0,
  conversation_id: "c1", contact: { id: "k1" },
};
const link = (over: Record<string, unknown> = {}) => ({ id: "l1", status: "created", short_url: null, conversation_id: "c1", ...over });
const createKey = (call: number) => api.createPaymentLinkWithSend.mock.calls[call][0].client_request_id as string;

beforeEach(() => {
  clearPaymentLinkAttempt();
  api.listPaymentLinks.mockResolvedValue([]);
});

describe("sendOrderPaymentLink idempotency", () => {
  it("reuses the create key after a timeout, then forgets it once sent", async () => {
    api.createPaymentLinkWithSend.mockRejectedValueOnce(new TypeError("network"));
    await expect(sendOrderPaymentLink(order, "d", "f")).rejects.toThrow("network");
    expect(pendingPaymentLinkAttempt("o1")).toBe(createKey(0));

    api.createPaymentLinkWithSend.mockResolvedValueOnce({ link: link(), send: { status: "sent", message_id: "m" } });
    expect((await sendOrderPaymentLink(order, "d", "f")).kind).toBe("sent");
    expect(createKey(1)).toBe(createKey(0));
    expect(pendingPaymentLinkAttempt("o1")).toBeNull();

    api.createPaymentLinkWithSend.mockResolvedValueOnce({ link: link(), send: { status: "sent", message_id: "m" } });
    await sendOrderPaymentLink(order, "d", "f");
    expect(createKey(2)).not.toBe(createKey(0));
  });

  it("keeps the key after a 5xx or an uncertain send and drops it after a definite refusal", async () => {
    api.createPaymentLinkWithSend.mockRejectedValueOnce(Object.assign(new Error("boom"), { status: 503 }));
    await expect(sendOrderPaymentLink(order, "d", "f")).rejects.toThrow();
    expect(pendingPaymentLinkAttempt("o1")).not.toBeNull();

    // The retry finds the link the first try made (now open), but still repeats the same create.
    api.listPaymentLinks.mockResolvedValue([link()]);
    api.createPaymentLinkWithSend.mockResolvedValueOnce({ link: link(), send: { status: "uncertain", error: "?" } });
    expect((await sendOrderPaymentLink(order, "d", "f")).kind).toBe("not_sent");
    expect(createKey(1)).toBe(createKey(0));
    expect(api.sendPaymentLink).not.toHaveBeenCalled();
    expect(pendingPaymentLinkAttempt("o1")).toBe(createKey(0));

    api.createPaymentLinkWithSend.mockRejectedValueOnce(Object.assign(new Error("no"), { status: 400 }));
    await expect(sendOrderPaymentLink(order, "d", "f")).rejects.toThrow();
    expect(pendingPaymentLinkAttempt("o1")).toBeNull();
  });

  it("re-sends an open link with one stable key until the send is definite", async () => {
    api.listPaymentLinks.mockResolvedValue([link()]);
    api.sendPaymentLink.mockResolvedValueOnce({ status: "uncertain", error: "?" });
    await sendOrderPaymentLink(order, "d", "f");
    api.sendPaymentLink.mockResolvedValueOnce({ status: "sent", message_id: "m" });
    expect(await sendOrderPaymentLink(order, "d", "f")).toMatchObject({ kind: "sent", reused: true });
    expect(api.sendPaymentLink.mock.calls[1][1]).toBe(api.sendPaymentLink.mock.calls[0][1]);
    expect(api.createPaymentLinkWithSend).not.toHaveBeenCalled();
    expect(pendingPaymentLinkAttempt("o1")).toBeNull();
  });
});
