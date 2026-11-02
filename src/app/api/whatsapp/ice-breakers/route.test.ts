import { beforeEach, expect, it, vi } from "vitest";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
type Num = {
  id: string; is_default: boolean; phone_number_id: string; access_token: string; status: string;
  ice_breakers: string[]; ice_breakers_synced_at: Date | null;
};
const h = vi.hoisted(() => ({
  rows: [] as {
    id: string; is_default: boolean; phone_number_id: string; access_token: string; status: string;
    ice_breakers: string[]; ice_breakers_synced_at: Date | null;
  }[],
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  setIceBreakers: vi.fn<(args: { phoneNumberId: string; accessToken: string; prompts: string[] }) => Promise<void>>(async () => {}),
  requireRole: vi.fn(),
}));
const ctx = { accountId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "admin" };
const num = (id: string, phone: string, isDefault: boolean, prompts: string[] = []): Num => ({
  id, is_default: isDefault, phone_number_id: phone, access_token: "enc", status: "connected", ice_breakers: prompts, ice_breakers_synced_at: null,
});

const tx = {
  whatsapp_config: {
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      h.updates.push(args);
      const r = h.rows.find((n) => n.id === args.where.id && n.phone_number_id === args.where.phone_number_id);
      if (r && args.where.account_id === ctx.accountId) Object.assign(r, args.data);
      return { count: r ? 1 : 0 };
    },
  },
};
vi.mock("@/lib/db/tenant", () => ({ withTenant: (_scope: unknown, op: (t: typeof tx) => Promise<unknown>) => op(tx) }));
vi.mock("@/lib/whatsapp/numbers", () => {
  class NoNumberError extends Error {
    constructor(public readonly reason: "none" | "not_found" | "no_default") { super(reason); }
    get messageKey() {
      return `whatsappNumbers.errors.${this.reason === "not_found" ? "notFound" : this.reason === "no_default" ? "noDefault" : "none"}`;
    }
  }
  return {
    NoNumberError,
    getNumberConfig: async (_tx: unknown, accountId: string, configId?: string) => {
      if (accountId !== ctx.accountId) throw new NoNumberError("not_found");
      if (configId) {
        const r = h.rows.find((n) => n.id === configId);
        if (!r) throw new NoNumberError("not_found");
        return r;
      }
      if (h.rows.length === 0) throw new NoNumberError("none");
      const d = h.rows.find((n) => n.is_default) ?? (h.rows.length === 1 ? h.rows[0] : null);
      if (!d) throw new NoNumberError("no_default");
      return d;
    },
  };
});
vi.mock("@/lib/auth/account", () => ({
  requireRole: h.requireRole,
  getCurrentAccount: async () => ({ ...ctx, role: "viewer" }),
  toErrorResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/whatsapp/meta-api", () => ({ setIceBreakers: h.setIceBreakers }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: () => "token" }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { GET, PUT } from "./route";

const url = (n?: string) => `http://localhost/api/whatsapp/ice-breakers${n ? `?number=${n}` : ""}`;
const get = (n?: string) => GET(new Request(url(n)));
const put = (prompts: unknown, n?: string) => PUT(new Request(url(n), { method: "PUT", body: JSON.stringify({ prompts }) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.updates = [];
  h.rows = [num(A, "123", true)];
  h.requireRole.mockResolvedValue(ctx);
});

it("reads the default number's ice breakers, or a chosen number's with ?number", async () => {
  h.rows = [num(A, "123", true, ["Hi from A"]), num(B, "456", false, ["Hi from B"])];
  expect(await (await get()).json()).toEqual({ number_id: A, prompts: ["Hi from A"], synced_at: null });
  expect(await (await get(B)).json()).toEqual({ number_id: B, prompts: ["Hi from B"], synced_at: null });
  expect((await get(OTHER)).status).toBe(404);
});

it("returns an empty list when no number is connected, and asks which number when there is no default", async () => {
  h.rows = [];
  expect(await (await get()).json()).toEqual({ number_id: null, prompts: [], synced_at: null });
  expect((await put(["Hi"])).status).toBe(409);
  h.rows = [num(A, "123", false), num(B, "456", false)];
  expect((await get()).status).toBe(409);
  expect((await put(["Hi"])).status).toBe(409);
  expect(h.setIceBreakers).not.toHaveBeenCalled();
});

it("sends the prompts to Meta first, then saves them (admins only)", async () => {
  const res = await put([" Track my order ", "Talk to sales"]);
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith("admin");
  expect(h.setIceBreakers).toHaveBeenCalledWith({ phoneNumberId: "123", accessToken: "token", prompts: ["Track my order", "Talk to sales"] });
  expect(h.updates[0]).toMatchObject({
    where: { account_id: ctx.accountId, id: A, phone_number_id: "123" },
    data: { ice_breakers: ["Track my order", "Talk to sales"] },
  });
  expect((await res.json()).number_id).toBe(A);
});

it("sets ice breakers on the chosen number only", async () => {
  h.rows = [num(A, "123", true, ["Keep me"]), num(B, "456", false)];
  expect((await put(["For B"], B)).status).toBe(200);
  expect(h.setIceBreakers).toHaveBeenCalledWith(expect.objectContaining({ phoneNumberId: "456", prompts: ["For B"] }));
  expect(h.rows[0].ice_breakers).toEqual(["Keep me"]);
  expect(h.rows[1].ice_breakers).toEqual(["For B"]);
  expect((await put(["Hi"], OTHER)).status).toBe(404);
});

it("saves nothing when Meta refuses", async () => {
  h.setIceBreakers.mockRejectedValueOnce(new Error("Meta said no"));
  expect((await put(["Hi"])).status).toBe(502);
  expect(h.updates).toEqual([]);
});

it("rejects too many, too long or repeated prompts, and a disconnected number", async () => {
  expect((await put(["a", "b", "c", "d", "e"])).status).toBe(400);
  expect((await put(["x".repeat(81)])).status).toBe(400);
  expect((await put(["Hi", "hi"])).status).toBe(400);
  h.rows[0].status = "disconnected";
  expect((await put(["Hi"])).status).toBe(409);
  expect(h.setIceBreakers).not.toHaveBeenCalled();
});

it("refuses non-admins before touching Meta", async () => {
  h.requireRole.mockRejectedValueOnce(new Error("Insufficient workspace role"));
  expect((await put(["Hi"])).status).toBe(403);
  expect(h.setIceBreakers).not.toHaveBeenCalled();
});
