import { beforeEach, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/errors";

// DELETE /api/whatsapp/numbers/[id]: what the disconnect reports back. The
// transactional work itself (hold, draft, default move) is covered on
// PostgreSQL in src/lib/whatsapp/number-admin.integration.test.ts.

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  listNumbers: vi.fn(),
  disconnectAndReport: vi.fn(),
  setDefaultNumber: vi.fn(),
  tenants: [] as unknown[],
  transactions: 0,
}));

vi.mock("@/lib/auth/account", async () => {
  const { toErrorResponse } = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return { requireRole: h.requireRole, toErrorResponse };
});
vi.mock("@/lib/db/tenant", () => ({
  withTenant: async (tenant: unknown, op: (tx: unknown) => unknown) => {
    h.tenants.push(tenant);
    h.transactions++;
    return op({ tx: true });
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock("@/lib/whatsapp/numbers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/numbers")>("@/lib/whatsapp/numbers");
  return { NoNumberError: actual.NoNumberError, listNumbers: h.listNumbers, setDefaultNumber: h.setDefaultNumber };
});
vi.mock("@/lib/whatsapp/number-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/number-admin")>("@/lib/whatsapp/number-admin");
  return { ...actual, disconnectAndReport: h.disconnectAndReport };
});

import { DELETE, PATCH } from "./route";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const NEXT = "44444444-4444-4444-8444-444444444444";
const ctx = { accountId: ACCOUNT, userId: "u-1", role: "admin", db: {}, account: { id: ACCOUNT, name: "A" } };
const del = (id = ID) =>
  DELETE(new Request(`http://localhost/api/whatsapp/numbers/${id}`, { method: "DELETE" }), { params: Promise.resolve({ id }) });
const nextDefault = {
  id: NEXT, phone_number_id: "777", waba_id: "456", display_name: "Sales", status: "connected", is_default: true,
  quality_rating: null, messaging_limit_tier: null, name_status: null, health_checked_at: null, connected_at: null,
  created_at: new Date("2026-01-01T00:00:00Z"),
  // A wider row must never leave the route.
  access_token: "enc-secret",
};

beforeEach(() => {
  vi.clearAllMocks();
  h.tenants = [];
  h.transactions = 0;
  h.requireRole.mockResolvedValue(ctx);
  h.listNumbers.mockResolvedValue([nextDefault]);
});

it("disconnecting the default names the oldest remaining number as the new default, in one transaction", async () => {
  h.disconnectAndReport.mockResolvedValueOnce({
    result: { newDefaultId: NEXT, pausedFlows: 0, heldCampaigns: [] },
    newDefault: nextDefault,
    noDefaultLeft: false,
  });
  const res = await del();
  expect(res.status).toBe(200);
  const text = await res.clone().text();
  expect(text).not.toMatch(/access_token|enc-secret/);
  const body = await res.json();
  expect(body).toMatchObject({
    deleted: false,
    disconnected: true,
    new_default_id: NEXT,
    new_default: { id: NEXT, display_name: "Sales", is_default: true },
    no_default_left: false,
    paused_flows: 0,
    held_campaigns: [],
  });
  expect(typeof body.message).toBe("string");
  expect(body.message.length).toBeGreaterThan(0);
  // The disconnect and the new-default lookup share one tenant transaction, attributed to the admin.
  expect(h.transactions).toBe(1);
  expect(h.tenants[0]).toEqual({ accountId: ACCOUNT, userId: "u-1", role: "admin" });
  expect(h.disconnectAndReport).toHaveBeenCalledWith({ tx: true }, ACCOUNT, ID, "u-1");
});

it("reports campaigns held (not cancelled) and flows drafted, and says when no default is left", async () => {
  const held = [{ id: "b-1", name: "Diwali sale", status: "scheduled" }, { id: "b-2", name: "Restock", status: "sending" }];
  h.disconnectAndReport.mockResolvedValueOnce({
    result: { newDefaultId: null, pausedFlows: 2, heldCampaigns: held },
    newDefault: null,
    noDefaultLeft: true,
  });
  const res = await del();
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ new_default_id: null, new_default: null, no_default_left: true, paused_flows: 2, held_campaigns: held });
  expect(body).not.toHaveProperty("cancelled_campaigns");
});

it("answers 404 for a number outside the workspace and 403 for non-admins", async () => {
  h.disconnectAndReport.mockResolvedValueOnce(null);
  expect((await del()).status).toBe(404);
  h.requireRole.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await del()).status).toBe(403);
  expect(h.disconnectAndReport).toHaveBeenCalledTimes(1);
});

it("refuses to make a disconnected number the default", async () => {
  const { NoNumberError } = await import("@/lib/whatsapp/numbers");
  h.setDefaultNumber.mockRejectedValueOnce(new NoNumberError("disconnected"));
  const res = await PATCH(
    new Request(`http://localhost/api/whatsapp/numbers/${ID}`, { method: "PATCH", body: JSON.stringify({ is_default: true }) }),
    { params: Promise.resolve({ id: ID }) },
  );
  expect(res.status).toBe(409);
  expect(await res.json()).toMatchObject({ code: "whatsapp_number_disconnected" });
});
