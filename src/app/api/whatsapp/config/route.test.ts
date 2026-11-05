import { beforeEach, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { ForbiddenError } from "@/lib/auth/errors";

type Op = { table: string; op: string; values?: Record<string, unknown>; filters: [string, unknown][] };
const h = vi.hoisted(() => ({
  ops: [] as Op[],
  existing: null as Record<string, unknown> | null,
  insertError: null as { code: string } | null,
  updateError: null as { code: string } | null,
  getCurrentAccount: vi.fn(),
  requireRole: vi.fn(),
  getNumberConfig: vi.fn(),
  listNumbers: vi.fn(),
  disconnectAndReport: vi.fn(),
  verifyPhoneNumber: vi.fn(async () => ({ id: "123", verified_name: "Acme", display_phone_number: "+1 555 0100" })),
  subscribeWabaToApp: vi.fn(async () => {}),
  claimed: null as string | null,
  numberRoom: vi.fn(async () => {}),
}));

// Minimal data client: records each statement with its filters.
const db = {
  from: (table: string) => {
    const op: Op = { table, op: "select", filters: [] };
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (field: string, value: unknown) => { op.filters.push([field, value]); return b; },
      update: (values: Record<string, unknown>) => { op.op = "update"; op.values = values; return b; },
      insert: (values: Record<string, unknown>) => { op.op = "insert"; op.values = values; return b; },
      maybeSingle: async () => {
        h.ops.push(op);
        if (op.op === "insert") return h.insertError ? { data: null, error: h.insertError } : { data: { id: "new-id" }, error: null };
        return { data: h.existing, error: null };
      },
      then: (resolve: (r: { error: { code: string } | null }) => unknown) => {
        h.ops.push(op);
        return resolve({ error: op.op === "update" ? h.updateError : null });
      },
    };
    return b;
  },
};

vi.mock("@/lib/auth/account", async () => {
  const { toErrorResponse } = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return { getCurrentAccount: h.getCurrentAccount, requireRole: h.requireRole, toErrorResponse };
});
// Tenant transaction: the write (and its room check) runs here, recorded like the data client.
const prismaError = (code: string) => new Prisma.PrismaClientKnownRequestError("write failed", { code, clientVersion: "test" });
const tx = {
  tx: true,
  whatsapp_config: {
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      h.ops.push({ table: "whatsapp_config", op: "update", values: data, filters: Object.entries(where) });
      if (h.updateError) throw prismaError(h.updateError.code);
      return { count: 1 };
    },
    create: async ({ data }: { data: Record<string, unknown> }) => {
      h.ops.push({ table: "whatsapp_config", op: "insert", values: data, filters: [] });
      if (h.insertError) throw prismaError(h.insertError.code);
      return { id: "new-id" };
    },
  },
};
vi.mock("@/lib/db/tenant", () => ({ withTenant: async (_t: unknown, op: (t: unknown) => unknown) => op(tx) }));
vi.mock("@/lib/whatsapp/numbers", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/numbers")>("@/lib/whatsapp/numbers");
  return {
    NoNumberError: actual.NoNumberError,
    isNumberDisconnected: actual.isNumberDisconnected,
    getNumberConfig: h.getNumberConfig,
    listNumbers: h.listNumbers,
  };
});
vi.mock("@/lib/whatsapp/number-admin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/number-admin")>("@/lib/whatsapp/number-admin");
  return { DISPLAY_NAME_MAX: 200, disconnectAndReport: h.disconnectAndReport, disconnectResponse: actual.disconnectResponse };
});
vi.mock("@/lib/billing/entitlements", async () => {
  const actual = await vi.importActual<typeof import("@/lib/billing/entitlements")>("@/lib/billing/entitlements");
  return { PlanLimitError: actual.PlanLimitError };
});
vi.mock("@/lib/billing/limits", () => ({ requireWhatsAppNumberRoom: h.numberRoom }));
vi.mock("@/lib/repositories/routing", () => ({ resolveWhatsAppAccount: async () => h.claimed }));
vi.mock("@/lib/whatsapp/encryption", () => ({ encrypt: (v: string) => `enc:${v}`, decrypt: (v: string) => v.replace(/^enc:/, "") }));
vi.mock("@/lib/whatsapp/meta-api", () => ({
  verifyPhoneNumber: h.verifyPhoneNumber,
  listWabaPhoneNumbers: async () => [{ id: "123" }],
  registerPhoneNumber: async () => {},
  subscribeWabaToApp: h.subscribeWabaToApp,
  getSubscribedApps: async () => [{ id: "app" }],
}));
vi.mock("@/lib/whatsapp/waba-pairing", async () => {
  const actual = await vi.importActual<typeof import("@/lib/whatsapp/waba-pairing")>("@/lib/whatsapp/waba-pairing");
  return { ...actual, phoneNumberBelongsToWaba: () => true };
});

import { DELETE, GET, POST } from "./route";
import { NoNumberError } from "@/lib/whatsapp/numbers";
import { PlanLimitError } from "@/lib/billing/entitlements";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const ID = "33333333-3333-4333-8333-333333333333";
const ctx = { accountId: ACCOUNT, userId: "u-1", role: "admin", db, account: { id: ACCOUNT, name: "A" } };
const post = (body: Record<string, unknown>) =>
  POST(new Request("http://localhost/api/whatsapp/config", { method: "POST", body: JSON.stringify(body) }));
const del = (query = "") => DELETE(new Request(`http://localhost/api/whatsapp/config${query}`, { method: "DELETE" }));
const save = { phone_number_id: "123", waba_id: "456", access_token: "EAAG-secret" };

beforeEach(() => {
  vi.clearAllMocks();
  h.ops = [];
  h.existing = null;
  h.insertError = null;
  h.updateError = null;
  h.claimed = null;
  h.requireRole.mockResolvedValue(ctx);
  h.getCurrentAccount.mockResolvedValue({ ...ctx, role: "agent" });
});

it("refuses non-admins before calling Meta or writing", async () => {
  h.requireRole.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await post(save)).status).toBe(403);
  expect(h.requireRole).toHaveBeenCalledWith("admin");
  expect(h.verifyPhoneNumber).not.toHaveBeenCalled();
  expect(h.ops).toEqual([]);
});

it("adds a new number when the workspace does not have this phone_number_id", async () => {
  const res = await post(save);
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body).toMatchObject({ success: true, number_id: "new-id", created: true });
  expect(JSON.stringify(body)).not.toContain("EAAG-secret");
  const [lookup, write] = h.ops;
  expect(lookup.filters).toEqual([["account_id", ACCOUNT], ["phone_number_id", "123"]]);
  expect(write.op).toBe("insert");
  expect(write.values).toMatchObject({
    account_id: ACCOUNT, user_id: "u-1", phone_number_id: "123", access_token: "enc:EAAG-secret", display_name: "Acme · +1 555 0100",
  });
  expect(h.ops.some((o) => o.op === "update")).toBe(false);
});

it("updates only that number when the phone_number_id is already connected, keeping its label", async () => {
  h.existing = { id: ID, phone_number_id: "123", registered_at: "2026-10-01", verify_token: "enc:v", display_name: "Support" };
  const res = await post(save);
  expect(await res.json()).toMatchObject({ number_id: ID, created: false });
  const write = h.ops.find((o) => o.op === "update")!;
  expect(write.filters).toEqual([["account_id", ACCOUNT], ["id", ID]]);
  expect(write.values).not.toHaveProperty("display_name");
  expect(write.values).toMatchObject({ verify_token: "enc:v" });
  expect(h.ops.some((o) => o.op === "insert")).toBe(false);
  // Saving a number the workspace already has is never limited by the plan.
  expect(h.numberRoom).not.toHaveBeenCalled();
});

it("refuses an additional number over the plan before Meta registration or any write", async () => {
  h.numberRoom.mockRejectedValueOnce(new PlanLimitError("The Free plan allows up to 1 WhatsApp numbers. Upgrade for more."));
  const res = await post({ ...save, pin: "123456" });
  expect(res.status).toBe(402);
  expect(await res.json()).toMatchObject({ error: expect.stringContaining("WhatsApp numbers") });
  expect(h.numberRoom).toHaveBeenCalledWith(tx, ACCOUNT);
  expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
  expect(h.ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
});

it("refuses a number another workspace has, and maps a racing insert to 409", async () => {
  h.claimed = "other-account";
  expect((await post(save)).status).toBe(409);
  expect(h.ops).toEqual([]);
  h.claimed = null;
  h.insertError = { code: "P2002" };
  expect((await post(save)).status).toBe(409);
});

it("reconnects a number another workspace only disconnected, but not one it holds connected", async () => {
  // This workspace's own disconnected row; the routing lookup counts only
  // connected rows, so null means no workspace holds the number right now.
  h.existing = { id: ID, phone_number_id: "123", registered_at: null, verify_token: null, display_name: "Sales", status: "disconnected", access_token: "" };
  expect(await (await post(save)).json()).toMatchObject({ success: true, number_id: ID, reconnected: true });

  // Another workspace connected it meanwhile: refused before Meta or a write.
  h.ops = [];
  h.claimed = "other-account";
  const refused = await post(save);
  expect(refused.status).toBe(409);
  expect(h.ops).toEqual([]);

  // ...or connected it between the check and the write: the partial unique index answers 409.
  h.claimed = null;
  h.updateError = { code: "P2002" };
  const raced = await post(save);
  expect(raced.status).toBe(409);
  expect(await raced.json()).toMatchObject({ error: expect.any(String) });
});

it("health-checks the requested number (any member) and never returns its token", async () => {
  h.getNumberConfig.mockResolvedValueOnce({ id: ID, phone_number_id: "123", waba_id: "456", access_token: "enc:EAAG-secret", status: "connected" });
  const res = await GET(new Request(`http://localhost/api/whatsapp/config?id=${ID}`));
  expect(h.getNumberConfig).toHaveBeenCalledWith(tx, ACCOUNT, ID);
  const body = await res.json();
  expect(body).toMatchObject({ connected: true, number_id: ID });
  expect(JSON.stringify(body)).not.toMatch(/EAAG|access_token/);
});

it("explains a missing, foreign or ambiguous number instead of failing", async () => {
  const get = async (query = "") => (await GET(new Request(`http://localhost/api/whatsapp/config${query}`))).json();
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError("none"));
  expect(await get()).toMatchObject({ connected: false, reason: "no_config" });
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError("no_default"));
  expect(await get()).toMatchObject({ connected: false, reason: "no_default" });
  h.getNumberConfig.mockRejectedValueOnce(new NoNumberError("not_found"));
  expect(await get(`?id=${ID}`)).toMatchObject({ connected: false, reason: "not_found" });
});

it("resets one number: the named one, or the only connected one, never all of several", async () => {
  const held = [{ id: "b-1", name: "API orders", status: "sent" }];
  h.disconnectAndReport.mockResolvedValue({
    result: { newDefaultId: null, pausedFlows: 0, heldCampaigns: held },
    newDefault: null,
    noDefaultLeft: true,
  });
  const res = await del(`?id=${ID}`);
  expect(res.status).toBe(200);
  // Reset is the same soft disconnect: campaigns are held, never cancelled, and it says so.
  const body = await res.json();
  expect(body).toMatchObject({ success: true, disconnected: true, held_campaigns: held, no_default_left: true });
  expect(body).not.toHaveProperty("cancelled_campaigns");
  expect(typeof body.message).toBe("string");
  // Attributed to the admin who reset it.
  expect(h.disconnectAndReport).toHaveBeenLastCalledWith(tx, ACCOUNT, ID, ctx.userId);

  h.listNumbers.mockResolvedValueOnce([{ id: "only" }, { id: "gone", removed: true }]);
  expect((await del()).status).toBe(200);
  expect(h.disconnectAndReport).toHaveBeenLastCalledWith(tx, ACCOUNT, "only", ctx.userId);

  // Only disconnected numbers left: nothing to reset.
  h.listNumbers.mockResolvedValueOnce([{ id: "gone", removed: true }]);
  expect(await (await del()).json()).toEqual({ success: true });

  h.listNumbers.mockResolvedValueOnce([{ id: "a" }, { id: "b" }]);
  expect((await del()).status).toBe(400);
  expect(h.disconnectAndReport).toHaveBeenCalledTimes(2);

  h.requireRole.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await del(`?id=${ID}`)).status).toBe(403);
  expect(h.disconnectAndReport).toHaveBeenCalledTimes(2);
});

it("reports an admin-disconnected number as disconnected, not as a corrupted token", async () => {
  h.getNumberConfig.mockResolvedValueOnce({ id: ID, phone_number_id: "123", waba_id: null, status: "disconnected", access_token: "" });
  const body = await (await GET(new Request(`http://localhost/api/whatsapp/config?id=${ID}`))).json();
  expect(body).toMatchObject({ connected: false, reason: "disconnected", number_id: ID });
  expect(h.verifyPhoneNumber).not.toHaveBeenCalled();
});

it("saving a disconnected number's Phone Number ID again revives that row in place", async () => {
  h.existing = { id: ID, phone_number_id: "123", registered_at: "2026-10-01", verify_token: null, display_name: "Sales", status: "disconnected", access_token: "" };
  const body = await (await post(save)).json();
  expect(body).toMatchObject({ success: true, number_id: ID, created: false, reconnected: true });
  const write = h.ops.find((o) => o.op === "update")!;
  expect(write.filters).toEqual([["account_id", ACCOUNT], ["id", ID]]);
  expect(write.values).toMatchObject({ status: "connected", access_token: "enc:EAAG-secret" });
  expect(h.ops.some((o) => o.op === "insert")).toBe(false);
  expect(JSON.stringify(body)).not.toContain("EAAG-secret");
});

it("reviving a removed number takes a slot again, so it must fit the plan (402, no write)", async () => {
  h.existing = { id: ID, phone_number_id: "123", registered_at: null, verify_token: null, display_name: "Sales", status: "disconnected", access_token: "" };
  h.numberRoom.mockRejectedValueOnce(new PlanLimitError("The Free plan allows up to 1 WhatsApp numbers. Upgrade for more."));
  const res = await post(save);
  expect(res.status).toBe(402);
  expect(h.numberRoom).toHaveBeenCalledWith(tx, ACCOUNT);
  expect(h.subscribeWabaToApp).not.toHaveBeenCalled();
  expect(h.ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
});

it("re-checks the room inside the write transaction, so a concurrent add that took the slot wins (402, no write)", async () => {
  // First check (before Meta) passes; the locked re-check in the write transaction does not.
  h.numberRoom.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new PlanLimitError("The Free plan allows up to 1 WhatsApp numbers. Upgrade for more."));
  const res = await post(save);
  expect(res.status).toBe(402);
  expect(h.numberRoom).toHaveBeenCalledTimes(2);
  expect(h.ops.some((o) => o.op === "insert" || o.op === "update")).toBe(false);
});
