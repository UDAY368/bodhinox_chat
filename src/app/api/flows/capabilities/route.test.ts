import { beforeEach, expect, it, vi } from "vitest";

import { ForbiddenError, UnauthorizedError } from "@/lib/auth/errors";

const h = vi.hoisted(() => ({
  role: vi.fn(),
  load: vi.fn(),
}));
vi.mock("@/lib/auth/account", async () => {
  const { toErrorResponse } = await vi.importActual<typeof import("@/lib/auth/account")>("@/lib/auth/account");
  return { requireRole: h.role, toErrorResponse };
});
vi.mock("@/lib/flows/capabilities", () => ({ loadWorkspaceCapabilities: h.load }));

import { GET } from "./route";

const caps = { payments: true, appointments: false, ai: false, capi: false, commerce: true, meetings: false, shipping: false };

beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ userId: "u-1", accountId: "acct-1", role: "viewer" });
  h.load.mockResolvedValue(caps);
});

it("lets any member read the workspace's capabilities as booleans, uncached", async () => {
  const res = await GET();
  expect(h.role).toHaveBeenCalledWith("viewer");
  expect(h.load).toHaveBeenCalledWith({ accountId: "acct-1", userId: "u-1", role: "viewer" });
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(await res.json()).toEqual(caps);
});

it("refuses a caller without a session or workspace", async () => {
  h.role.mockRejectedValueOnce(new UnauthorizedError());
  expect((await GET()).status).toBe(401);
  h.role.mockRejectedValueOnce(new ForbiddenError("Insufficient workspace role"));
  expect((await GET()).status).toBe(403);
  expect(h.load).not.toHaveBeenCalled();
});

it("hides internal failures", async () => {
  h.load.mockRejectedValueOnce(new Error("connection string with secret"));
  const res = await GET();
  expect(res.status).toBe(500);
  expect(JSON.stringify(await res.json())).not.toContain("secret");
});
