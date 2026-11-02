import { beforeEach, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/auth/errors";

const h = vi.hoisted(() => ({
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  listNumbers: vi.fn(),
  setDefaultNumber: vi.fn(async () => {}),
  disconnectAndReport: vi.fn(),
  renameNumber: vi.fn(async () => true),
  tenants: [] as unknown[],
}));

vi.mock("@/lib/auth/account", async () => {
  const { toErrorResponse } = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return { getCurrentAccount: h.getCurrentAccount, requireRole: h.requireRole, toErrorResponse };
});
vi.mock("@/lib/db/tenant", () => ({
  withTenant: async (tenant: unknown, op: (tx: unknown) => unknown) => { h.tenants.push(tenant); return op({ tx: true }); },
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
  return { ...actual, disconnectAndReport: h.disconnectAndReport, renameNumber: h.renameNumber };
});

import { GET } from "./route";
import { DELETE, PATCH } from "./[id]/route";
import { NoNumberError } from "@/lib/whatsapp/numbers";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const ctx = { accountId: ACCOUNT, userId: "u-1", role: "admin", db: {}, account: { id: ACCOUNT, name: "A" } };
const row = (over: Record<string, unknown> = {}) => ({
  id: ID, phone_number_id: "123", waba_id: "456", display_name: "Support", status: "connected", is_default: false,
  quality_rating: "GREEN", messaging_limit_tier: "TIER_1K", name_status: "APPROVED",
  health_checked_at: new Date("2026-11-01T00:00:00Z"), connected_at: null, created_at: new Date("2026-10-01T00:00:00Z"),
  ...over,
});
const params = (id = ID) => ({ params: Promise.resolve({ id }) });
const patch = (body: unknown, id = ID) =>
  PATCH(new Request(`http://localhost/api/whatsapp/numbers/${id}`, { method: "PATCH", body: JSON.stringify(body) }), params(id));
const list = (query = "") => GET(new Request(`http://localhost/api/whatsapp/numbers${query}`));
const del = (id = ID) => DELETE(new Request(`http://localhost/api/whatsapp/numbers/${id}`, { method: "DELETE" }), params(id));

beforeEach(() => {
  vi.clearAllMocks();
  h.tenants = [];
  h.getCurrentAccount.mockResolvedValue({ ...ctx, role: "agent" });
  h.requireRole.mockResolvedValue(ctx);
  h.listNumbers.mockResolvedValue([row({ is_default: true })]);
  h.renameNumber.mockResolvedValue(true);
});

it("lists the workspace's numbers to any member, scoped to their tenant, with no token fields", async () => {
  // Even if a wider row ever reached the route, only allow-listed fields leave it.
  h.listNumbers.mockResolvedValue([row({ is_default: true, access_token: "enc-secret", verify_token: "enc-v", forms_private_key_enc: "k" })]);
  const res = await list();
  expect(res.status).toBe(200);
  const text = await res.clone().text();
  expect(text).not.toMatch(/access_token|verify_token|enc-secret|forms_private/);
  const body = await res.json();
  expect(body.numbers).toEqual([expect.objectContaining({ id: ID, is_default: true, health_checked_at: "2026-11-01T00:00:00.000Z" })]);
  expect(h.listNumbers).toHaveBeenCalledWith({ tx: true }, ACCOUNT);
  expect(h.tenants[0]).toEqual({ accountId: ACCOUNT, userId: "u-1", role: "agent" });
  expect(res.headers.get("Cache-Control")).toContain("no-store");
});

it("refuses the list without a session", async () => {
  h.getCurrentAccount.mockRejectedValueOnce(new UnauthorizedError());
  expect((await list()).status).toBe(401);
  expect(h.listNumbers).not.toHaveBeenCalled();
});

it("marks disconnected numbers as removed on every entry, and ?connected=1 leaves them out", async () => {
  const GONE = "44444444-4444-4444-8444-444444444444";
  h.listNumbers.mockResolvedValue([row({ is_default: true }), row({ id: GONE, status: "disconnected", removed: true })]);

  const all = await (await list()).json();
  expect(all.numbers.map((n: { id: string; removed: boolean }) => [n.id, n.removed])).toEqual([[ID, false], [GONE, true]]);

  for (const query of ["?connected=1", "?connected=true"]) {
    const connected = await (await list(query)).json();
    expect(connected.numbers).toEqual([expect.objectContaining({ id: ID, removed: false })]);
  }
  // Anything else lists every number; the tenant scope is unchanged either way.
  expect((await (await list("?connected=0")).json()).numbers).toHaveLength(2);
  expect(h.tenants.every((tenant) => (tenant as { accountId: string }).accountId === ACCOUNT)).toBe(true);
});

it("switches the default for admins only, in the caller's workspace", async () => {
  h.listNumbers.mockResolvedValue([row({ is_default: true })]);
  const res = await patch({ is_default: true });
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith("admin");
  expect(h.setDefaultNumber).toHaveBeenCalledWith({ tx: true }, ACCOUNT, ID);
  const body = await res.json();
  expect(body.number).toMatchObject({ id: ID, is_default: true });
  expect(JSON.stringify(body)).not.toContain("access_token");

  h.requireRole.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await patch({ is_default: true })).status).toBe(403);
  expect(h.setDefaultNumber).toHaveBeenCalledTimes(1);
});

it("answers 404 for a number outside the workspace", async () => {
  h.setDefaultNumber.mockRejectedValueOnce(new NoNumberError("not_found"));
  expect((await patch({ is_default: true })).status).toBe(404);
  h.renameNumber.mockResolvedValueOnce(false);
  expect((await patch({ display_name: "Sales" })).status).toBe(404);
  h.disconnectAndReport.mockResolvedValueOnce(null);
  expect((await del()).status).toBe(404);
});

it("renames, and rejects anything but a label or the default flag", async () => {
  expect((await patch({ display_name: "Sales line" })).status).toBe(200);
  expect(h.renameNumber).toHaveBeenCalledWith({ tx: true }, ACCOUNT, ID, "Sales line");
  expect((await patch({ display_name: null })).status).toBe(200);
  expect((await patch({ access_token: "x" })).status).toBe(400);
  expect((await patch({ display_name: "x", phone_number_id: "1" })).status).toBe(400);
  expect((await patch({ is_default: false })).status).toBe(400);
  expect((await patch({ display_name: "x".repeat(201) })).status).toBe(400);
  expect((await patch({})).status).toBe(400);
});

it("disconnects one number for admins only", async () => {
  h.disconnectAndReport.mockResolvedValueOnce({
    result: { newDefaultId: "n2", pausedFlows: 1, heldCampaigns: [] },
    newDefault: null,
    noDefaultLeft: false,
  });
  const res = await del();
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ disconnected: true, new_default_id: "n2", paused_flows: 1, held_campaigns: [] });
  expect(h.disconnectAndReport).toHaveBeenCalledWith({ tx: true }, ACCOUNT, ID, "u-1");

  h.requireRole.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await del()).status).toBe(403);
  expect(h.disconnectAndReport).toHaveBeenCalledTimes(1);
});
