import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: { phone_number_id: "123", access_token: "enc", status: "connected" } as Record<string, unknown> | null,
  updates: [] as Record<string, unknown>[],
  setIceBreakers: vi.fn(async () => {}),
  requireRole: vi.fn(),
}));

const db = {
  from: () => {
    const b: Record<string, unknown> = {
      select: () => b,
      eq: () => b,
      update: (row: Record<string, unknown>) => { h.updates.push(row); return b; },
      maybeSingle: async () => ({ data: h.config, error: null }),
      then: (resolve: (r: { error: null }) => unknown) => resolve({ error: null }),
    };
    return b;
  },
};
vi.mock("@/lib/auth/account", () => ({
  requireRole: h.requireRole,
  getCurrentAccount: async () => ({ db, accountId: "acct-1", userId: "u-1" }),
  toErrorResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/whatsapp/meta-api", () => ({ setIceBreakers: h.setIceBreakers }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: () => "token" }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { PUT } from "./route";

const put = (prompts: unknown) => PUT(new Request("http://localhost/api/whatsapp/ice-breakers", { method: "PUT", body: JSON.stringify({ prompts }) }));

beforeEach(() => {
  vi.clearAllMocks();
  h.updates = [];
  h.config = { phone_number_id: "123", access_token: "enc", status: "connected" };
  h.requireRole.mockResolvedValue({ db, accountId: "acct-1", userId: "u-1" });
});

it("sends the prompts to Meta first, then saves them (admins only)", async () => {
  const res = await put([" Track my order ", "Talk to sales"]);
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith("admin");
  expect(h.setIceBreakers).toHaveBeenCalledWith({ phoneNumberId: "123", accessToken: "token", prompts: ["Track my order", "Talk to sales"] });
  expect(h.updates[0]).toMatchObject({ ice_breakers: ["Track my order", "Talk to sales"] });
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
  h.config = { phone_number_id: "123", access_token: "enc", status: "disconnected" };
  expect((await put(["Hi"])).status).toBe(409);
  expect(h.setIceBreakers).not.toHaveBeenCalled();
});

it("refuses non-admins before touching Meta", async () => {
  h.requireRole.mockRejectedValueOnce(new Error("Insufficient workspace role"));
  expect((await put(["Hi"])).status).toBe(403);
  expect(h.setIceBreakers).not.toHaveBeenCalled();
});
