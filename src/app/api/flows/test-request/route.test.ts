import { beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  role: vi.fn(async () => ({ userId: "u-1", accountId: "acct-1", role: "admin" })),
  run: vi.fn(),
  workspace: vi.fn(async (_account: string, _text: string, options?: { secrets?: boolean }) => (options?.secrets ? { token: "secret" } : {})),
  limited: false,
}));
vi.mock("@/lib/auth/account", () => ({
  requireRole: h.role,
  toErrorResponse: (e: unknown) => Response.json({ error: String(e) }, { status: 403 }),
}));
vi.mock("@/lib/flows/api-request", () => ({ runApiRequest: h.run }));
vi.mock("@/lib/workspace/attributes", () => ({ workspaceValuesFor: h.workspace }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { flowTestRequest: { limit: 10, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => Response.json({ error: "slow down" }, { status: 429 }),
}));

import { POST } from "./route";

const post = (body: unknown) => POST(new Request("http://localhost/api/flows/test-request", { method: "POST", body: JSON.stringify(body) }));
const config = { method: "GET", url: "https://api.example.com/x", headers: [{ key: "Authorization", value: "Bearer {{workspace.token}}" }] };

beforeEach(() => { vi.clearAllMocks(); h.limited = false; });

it("requires an agent and returns only the status, timing, mapped values and a preview", async () => {
  h.run.mockResolvedValue({ result: { ok: true, status: 200, contentType: "application/json", body: '{"a":1}' }, mapped: { a: "1" }, next: "", durationMs: 12 });
  const res = await post({ config, vars: { order: "7" }, contact: { name: "Ann" } });
  expect(h.role).toHaveBeenCalledWith("agent");
  expect(await res.json()).toEqual({ status: 200, error: null, duration_ms: 12, mapped: { a: "1" }, preview: '{"a":1}' });
  // Secrets are resolved for the headers on the server only.
  expect(h.run.mock.calls[0][1]).toMatchObject({ vars: { order: "7" }, contact: { name: "Ann" }, workspace: { token: "secret" }, publicWorkspace: {} });
});

it("reports a blocked destination without a body", async () => {
  h.run.mockResolvedValue({ result: { ok: false, error: "blocked" }, mapped: {}, next: "", durationMs: 1 });
  expect(await (await post({ config })).json()).toMatchObject({ status: null, error: "blocked", preview: null });
});

it("rejects malformed input and honours the rate limit", async () => {
  expect((await post({ config: { ...config, method: "TRACE" } })).status).toBe(400);
  expect((await post({ config: { ...config, url: "x".repeat(3000) } })).status).toBe(400);
  h.limited = true;
  expect((await post({ config })).status).toBe(429);
  expect(h.run).not.toHaveBeenCalled();
});

it("never decrypts secrets for an agent's test", async () => {
  h.role.mockResolvedValueOnce({ userId: "u-2", accountId: "acct-1", role: "agent" });
  h.run.mockResolvedValue({ result: { ok: true, status: 200, contentType: "", body: "" }, mapped: {}, next: "", durationMs: 1 });
  await post({ config });
  expect(h.workspace.mock.calls.every(([, , options]) => !options?.secrets)).toBe(true);
  expect(h.run.mock.calls[0][1].workspace).toEqual({});
});
