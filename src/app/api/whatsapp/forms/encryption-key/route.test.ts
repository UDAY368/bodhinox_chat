import { beforeEach, expect, it, vi } from "vitest";

type Row = {
  phone_number_id: string; access_token: string; status: string;
  public_key: string | null; private_enc: string | null; pending_enc: string | null; leased: boolean;
};
const h = vi.hoisted(() => ({
  row: null as Row | null,
  keyRow: [] as { configured: boolean; uploaded_at: Date | null }[],
  failPromote: false,
  setBusinessEncryptionKey: vi.fn<(args: { phoneNumberId: string; accessToken: string; publicKeyPem: string }) => Promise<void>>(async () => {}),
  requireRole: vi.fn(),
  sealed: 0,
}));

const ctx = { accountId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "admin" };
const connected = (): Row => ({
  phone_number_id: "123", access_token: "enc", status: "connected", public_key: null, private_enc: null, pending_enc: null, leased: false,
});

// A stand-in for whatsapp_config that answers by the statement it is given.
const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes("FOR UPDATE")) {
      const r = h.row;
      return r ? [{ phone_number_id: r.phone_number_id, access_token: r.access_token, status: r.status, rotating: r.leased }] : [];
    }
    return h.keyRow;
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    const r = h.row;
    if (!r) return 0;
    if (sql.includes("forms_key_rotation_started_at = now()")) { r.pending_enc = values[0] as string; r.leased = true; return 1; }
    if (sql.includes("forms_private_key_enc = forms_pending_private_key_enc")) {
      if (h.failPromote) throw new Error("connection lost");
      const [publicKey, , , phone, pending] = values;
      if (r.phone_number_id !== phone || r.pending_enc !== pending) return 0;
      Object.assign(r, { public_key: publicKey, private_enc: r.pending_enc, pending_enc: null, leased: false });
      return 1;
    }
    if (sql.includes("forms_key_rotation_started_at = NULL")) {
      if (r.pending_enc !== values[1]) return 0;
      r.leased = false;
      return 1;
    }
    throw new Error("unexpected statement");
  },
};
// Transactions run one at a time, as the row lock makes them for one account.
let queue: Promise<unknown> = Promise.resolve();
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_scope: unknown, op: (t: typeof tx) => Promise<unknown>) => {
    const run = queue.then(() => op(tx));
    queue = run.catch(() => undefined);
    return run;
  },
}));
vi.mock("@/lib/auth/account", () => ({
  requireRole: h.requireRole,
  getCurrentAccount: async () => ({ ...ctx, role: "viewer" }),
  toErrorResponse: () => Response.json({ error: "Forbidden" }, { status: 403 }),
}));
vi.mock("@/lib/whatsapp/meta-api", () => ({ setBusinessEncryptionKey: h.setBusinessEncryptionKey }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: () => "token", encrypt: () => `sealed-${++h.sealed}` }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { GET, POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  h.keyRow = [];
  h.row = connected();
  h.failPromote = false;
  h.requireRole.mockResolvedValue(ctx);
});

it("tells any member whether a key exists, never the key itself", async () => {
  expect(await (await GET()).json()).toEqual({ configured: false, uploaded_at: null });
  h.keyRow = [{ configured: true, uploaded_at: new Date("2026-11-02T10:00:00Z") }];
  const body = await (await GET()).json();
  expect(body).toEqual({ configured: true, uploaded_at: "2026-11-02T10:00:00.000Z" });
});

it("uploads a fresh public key to Meta, then makes the stored private key current (admins only)", async () => {
  const res = await POST();
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith("admin");
  const uploaded = h.setBusinessEncryptionKey.mock.calls[0][0];
  expect(uploaded).toMatchObject({ phoneNumberId: "123", accessToken: "token" });
  expect(uploaded.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  expect(h.row).toMatchObject({ public_key: uploaded.publicKeyPem, private_enc: expect.stringMatching(/^sealed-/), pending_enc: null, leased: false });
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["configured", "uploaded_at"]);
  expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
});

it("serializes rotations: a second request during an upload is refused and Meta keeps the key that is stored", async () => {
  let finishUpload!: () => void;
  h.setBusinessEncryptionKey.mockImplementationOnce(() => new Promise<void>((resolve) => { finishUpload = resolve; }));
  const first = POST();
  await vi.waitFor(() => expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(1));
  const second = await POST();
  expect(second.status).toBe(409);
  expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(1);
  finishUpload();
  expect((await first).status).toBe(200);
  const uploaded = h.setBusinessEncryptionKey.mock.calls[0][0];
  expect(h.row?.public_key).toBe(uploaded.publicKeyPem);
  // The lease is released, so the next rotation can run.
  expect((await POST()).status).toBe(200);
  expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(2);
});

it("keeps the current key when Meta refuses, and releases the lease", async () => {
  h.row = { ...connected(), public_key: "old-public", private_enc: "old-private" };
  h.setBusinessEncryptionKey.mockRejectedValueOnce(new Error("Meta said no"));
  expect((await POST()).status).toBe(502);
  expect(h.row).toMatchObject({ public_key: "old-public", private_enc: "old-private", leased: false });
  expect((await POST()).status).toBe(200);
});

it("keeps the uploaded key as pending when saving fails after Meta accepted it, and says so", async () => {
  h.row = { ...connected(), public_key: "old-public", private_enc: "old-private" };
  h.failPromote = true;
  const res = await POST();
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBeTruthy();
  expect(h.row).toMatchObject({ private_enc: "old-private", pending_enc: expect.stringMatching(/^sealed-/) });
});

it("does not overwrite a key from a rotation that took the row over", async () => {
  h.setBusinessEncryptionKey.mockImplementationOnce(async () => { h.row!.pending_enc = "someone-else"; });
  expect((await POST()).status).toBe(409);
  expect(h.row).toMatchObject({ private_enc: null, pending_enc: "someone-else" });
});

it("needs a connected number", async () => {
  h.row = { ...connected(), status: "disconnected" };
  expect((await POST()).status).toBe(409);
  h.row = null;
  expect((await POST()).status).toBe(409);
  expect(h.setBusinessEncryptionKey).not.toHaveBeenCalled();
});

it("refuses non-admins before touching Meta", async () => {
  h.requireRole.mockRejectedValueOnce(new Error("Insufficient workspace role"));
  expect((await POST()).status).toBe(403);
  expect(h.setBusinessEncryptionKey).not.toHaveBeenCalled();
  expect(h.row).toMatchObject({ pending_enc: null, leased: false });
});
