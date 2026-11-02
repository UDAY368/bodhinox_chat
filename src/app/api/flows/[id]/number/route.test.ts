import { beforeEach, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/auth/errors";

const h = vi.hoisted(() => ({
  requireRole: vi.fn(),
  numbers: [] as string[],
  updates: [] as { where: Record<string, unknown>; data: Record<string, unknown> }[],
  flowCount: 1,
  tenants: [] as unknown[],
}));

vi.mock("@/lib/auth/account", async () => {
  const { toErrorResponse } = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return { requireRole: h.requireRole, toErrorResponse };
});
const tx = {
  whatsapp_config: {
    findFirst: async ({ where }: { where: { account_id: string; id: string } }) =>
      where.account_id === ACCOUNT && h.numbers.includes(where.id) ? { id: where.id } : null,
  },
  flows: {
    updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      h.updates.push(args);
      return { count: h.flowCount };
    },
  },
};
vi.mock("@/lib/db/tenant", () => ({
  withTenant: async (tenant: unknown, op: (t: unknown) => unknown) => { h.tenants.push(tenant); return op(tx); },
}));

import { PUT } from "./route";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const FLOW = "22222222-2222-4222-8222-222222222222";
const NUMBER = "33333333-3333-4333-8333-333333333333";
const OTHER = "44444444-4444-4444-8444-444444444444";
const put = (body: unknown, id = FLOW) =>
  PUT(new Request(`http://localhost/api/flows/${id}/number`, { method: "PUT", body: JSON.stringify(body) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.numbers = [NUMBER];
  h.updates = [];
  h.flowCount = 1;
  h.tenants = [];
  h.requireRole.mockResolvedValue({ accountId: ACCOUNT, userId: "u-1", role: "agent" });
});

it("ties a flow to one of the workspace's numbers, or back to every number", async () => {
  const res = await put({ whatsapp_config_id: NUMBER });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ whatsapp_config_id: NUMBER });
  expect(h.requireRole).toHaveBeenCalledWith("agent");
  expect(h.updates[0]).toEqual({ where: { account_id: ACCOUNT, id: FLOW }, data: { whatsapp_config_id: NUMBER } });
  expect((await put({ whatsapp_config_id: null })).status).toBe(200);
  expect(h.updates[1].data).toEqual({ whatsapp_config_id: null });
  expect(h.tenants[0]).toEqual({ accountId: ACCOUNT, userId: "u-1", role: "agent" });
});

it("refuses another workspace's number, an unknown flow, bad input and viewers", async () => {
  expect((await put({ whatsapp_config_id: OTHER })).status).toBe(404);
  expect(h.updates).toEqual([]);
  h.flowCount = 0;
  expect((await put({ whatsapp_config_id: null })).status).toBe(404);
  expect((await put({ whatsapp_config_id: "nope" })).status).toBe(400);
  expect((await put({ whatsapp_config_id: null, status: "active" })).status).toBe(400);
  expect((await put({ whatsapp_config_id: null }, "not-a-uuid")).status).toBe(400);
  h.requireRole.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await put({ whatsapp_config_id: null })).status).toBe(403);
});
