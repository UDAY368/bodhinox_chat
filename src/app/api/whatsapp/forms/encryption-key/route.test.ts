import { beforeEach, expect, it, vi } from "vitest";

type Row = {
  id: string; is_default: boolean;
  phone_number_id: string; access_token: string; status: string;
  public_key: string | null; private_enc: string | null; pending_enc: string | null; leased: boolean;
  uploaded_at: Date | null;
};
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OTHER = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const h = vi.hoisted(() => ({
  rows: [] as {
    id: string; is_default: boolean; phone_number_id: string; access_token: string; status: string;
    public_key: string | null; private_enc: string | null; pending_enc: string | null; leased: boolean; uploaded_at: Date | null;
  }[],
  failPromote: false,
  setBusinessEncryptionKey: vi.fn<(args: { phoneNumberId: string; accessToken: string; publicKeyPem: string }) => Promise<void>>(async () => {}),
  requireRole: vi.fn(),
  sealed: 0,
}));
const byId = (id: unknown) => h.rows.find((r) => r.id === id);
/** The first (default) number, which most tests use alone. */
const row = () => h.rows[0];

const ctx = { accountId: "11111111-1111-4111-8111-111111111111", userId: "22222222-2222-4222-8222-222222222222", role: "admin" };
const number = (id: string, phone: string, isDefault: boolean): Row => ({
  id, is_default: isDefault, phone_number_id: phone, access_token: "enc", status: "connected",
  public_key: null, private_enc: null, pending_enc: null, leased: false, uploaded_at: null,
});

// A stand-in for whatsapp_config that answers by the statement it is given.
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FOR UPDATE")) {
      const r = byId(values[2]);
      return r ? [{ phone_number_id: r.phone_number_id, access_token: r.access_token, status: r.status, rotating: r.leased }] : [];
    }
    if (sql.includes("AS configured")) {
      // The status read never selects key material.
      expect(sql).not.toMatch(/private_key_enc\s*(,|FROM)/);
      const r = byId(values[1]);
      return r ? [{ id: r.id, configured: !!(r.public_key && r.private_enc), uploaded_at: r.uploaded_at }] : [];
    }
    throw new Error("unexpected query");
  },
  $executeRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("forms_key_rotation_started_at = now()")) {
      const r = byId(values[2]);
      if (!r) return 0;
      r.pending_enc = values[0] as string;
      r.leased = true;
      return 1;
    }
    if (sql.includes("forms_private_key_enc = forms_pending_private_key_enc")) {
      if (h.failPromote) throw new Error("connection lost");
      const [publicKey, uploadedAt, , id, phone, pending] = values;
      const r = byId(id);
      if (!r || r.phone_number_id !== phone || r.pending_enc !== pending) return 0;
      Object.assign(r, { public_key: publicKey, private_enc: r.pending_enc, pending_enc: null, leased: false, uploaded_at: uploadedAt });
      return 1;
    }
    if (sql.includes("forms_key_rotation_started_at = NULL")) {
      const r = byId(values[1]);
      if (!r || r.pending_enc !== values[2]) return 0;
      r.leased = false;
      return 1;
    }
    throw new Error("unexpected statement");
  },
};
// Transactions run one at a time, as the row lock makes them for one number.
let queue: Promise<unknown> = Promise.resolve();
vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_scope: unknown, op: (t: typeof tx) => Promise<unknown>) => {
    const run = queue.then(() => op(tx));
    queue = run.catch(() => undefined);
    return run;
  },
}));
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
        const r = byId(configId);
        if (!r) throw new NoNumberError("not_found");
        return r;
      }
      if (h.rows.length === 0) throw new NoNumberError("none");
      const d = h.rows.find((r) => r.is_default) ?? (h.rows.length === 1 ? h.rows[0] : null);
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
vi.mock("@/lib/whatsapp/meta-api", () => ({ setBusinessEncryptionKey: h.setBusinessEncryptionKey }));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: () => "token", encrypt: () => `sealed-${++h.sealed}` }));
vi.mock("@/lib/rate-limit", () => ({
  RATE_LIMITS: { adminAction: { limit: 30, windowMs: 60_000 } },
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));

import { GET, POST } from "./route";

const url = (n?: string) => `http://localhost/api/whatsapp/forms/encryption-key${n ? `?number=${n}` : ""}`;
const get = (n?: string) => GET(new Request(url(n)));
const post = (n?: string) => POST(new Request(url(n), { method: "POST" }));

beforeEach(() => {
  vi.clearAllMocks();
  h.rows = [number(A, "123", true)];
  h.failPromote = false;
  h.requireRole.mockResolvedValue(ctx);
});

it("tells any member whether the default number has a key, never the key itself", async () => {
  expect(await (await get()).json()).toEqual({ number_id: A, configured: false, uploaded_at: null });
  Object.assign(row(), { public_key: "pub", private_enc: "priv", uploaded_at: new Date("2026-11-02T10:00:00Z") });
  const body = await (await get()).json();
  expect(body).toEqual({ number_id: A, configured: true, uploaded_at: "2026-11-02T10:00:00.000Z" });
});

it("reports no key when the workspace has no number, and refuses to generate one", async () => {
  h.rows = [];
  expect(await (await get()).json()).toEqual({ number_id: null, configured: false, uploaded_at: null });
  expect((await post()).status).toBe(409);
  expect(h.setBusinessEncryptionKey).not.toHaveBeenCalled();
});

it("uploads a fresh public key to Meta, then makes the stored private key current (admins only)", async () => {
  const res = await post();
  expect(res.status).toBe(200);
  expect(h.requireRole).toHaveBeenCalledWith("admin");
  const uploaded = h.setBusinessEncryptionKey.mock.calls[0][0];
  expect(uploaded).toMatchObject({ phoneNumberId: "123", accessToken: "token" });
  expect(uploaded.publicKeyPem).toContain("BEGIN PUBLIC KEY");
  expect(row()).toMatchObject({ public_key: uploaded.publicKeyPem, private_enc: expect.stringMatching(/^sealed-/), pending_enc: null, leased: false });
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(["configured", "number_id", "uploaded_at"]);
  expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
});

it("keeps a key per number: ?number rotates only that number's key on Meta", async () => {
  h.rows = [number(A, "123", true), number(B, "456", false)];
  Object.assign(h.rows[0], { public_key: "a-public", private_enc: "a-private" });
  const res = await post(B);
  expect(res.status).toBe(200);
  expect((await res.json()).number_id).toBe(B);
  expect(h.setBusinessEncryptionKey.mock.calls[0][0]).toMatchObject({ phoneNumberId: "456" });
  expect(h.rows[0]).toMatchObject({ public_key: "a-public", private_enc: "a-private", pending_enc: null });
  expect(h.rows[1]).toMatchObject({ private_enc: expect.stringMatching(/^sealed-/), leased: false });
  expect((await (await get(B)).json())).toMatchObject({ number_id: B, configured: true });
  expect((await (await get()).json())).toMatchObject({ number_id: A, configured: true });
});

it("leases per number, so two numbers can rotate at the same time", async () => {
  h.rows = [number(A, "123", true), number(B, "456", false)];
  let finishUpload!: () => void;
  h.setBusinessEncryptionKey.mockImplementationOnce(() => new Promise<void>((resolve) => { finishUpload = resolve; }));
  const first = post(A);
  await vi.waitFor(() => expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(1));
  expect((await post(B)).status).toBe(200);
  finishUpload();
  expect((await first).status).toBe(200);
});

it("refuses a number that is not this workspace's, and asks which number when there is no default", async () => {
  expect((await post(OTHER)).status).toBe(404);
  expect((await get(OTHER)).status).toBe(404);
  h.rows = [number(A, "123", false), number(B, "456", false)];
  expect((await post()).status).toBe(409);
  expect(h.setBusinessEncryptionKey).not.toHaveBeenCalled();
});

it("serializes rotations: a second request during an upload is refused and Meta keeps the key that is stored", async () => {
  let finishUpload!: () => void;
  h.setBusinessEncryptionKey.mockImplementationOnce(() => new Promise<void>((resolve) => { finishUpload = resolve; }));
  const first = post();
  await vi.waitFor(() => expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(1));
  const second = await post();
  expect(second.status).toBe(409);
  expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(1);
  finishUpload();
  expect((await first).status).toBe(200);
  const uploaded = h.setBusinessEncryptionKey.mock.calls[0][0];
  expect(row().public_key).toBe(uploaded.publicKeyPem);
  // The lease is released, so the next rotation can run.
  expect((await post()).status).toBe(200);
  expect(h.setBusinessEncryptionKey).toHaveBeenCalledTimes(2);
});

it("keeps the current key when Meta refuses, and releases the lease", async () => {
  Object.assign(row(), { public_key: "old-public", private_enc: "old-private" });
  h.setBusinessEncryptionKey.mockRejectedValueOnce(new Error("Meta said no"));
  expect((await post()).status).toBe(502);
  expect(row()).toMatchObject({ public_key: "old-public", private_enc: "old-private", leased: false });
  expect((await post()).status).toBe(200);
});

it("keeps the uploaded key as pending when saving fails after Meta accepted it, and says so", async () => {
  Object.assign(row(), { public_key: "old-public", private_enc: "old-private" });
  h.failPromote = true;
  const res = await post();
  expect(res.status).toBe(500);
  expect((await res.json()).error).toBeTruthy();
  expect(row()).toMatchObject({ private_enc: "old-private", pending_enc: expect.stringMatching(/^sealed-/) });
});

it("does not overwrite a key from a rotation that took the row over", async () => {
  h.setBusinessEncryptionKey.mockImplementationOnce(async () => { row().pending_enc = "someone-else"; });
  expect((await post()).status).toBe(409);
  expect(row()).toMatchObject({ private_enc: null, pending_enc: "someone-else" });
});

it("needs a connected number", async () => {
  row().status = "disconnected";
  expect((await post()).status).toBe(409);
  expect(h.setBusinessEncryptionKey).not.toHaveBeenCalled();
});

it("refuses non-admins before touching Meta", async () => {
  h.requireRole.mockRejectedValueOnce(new Error("Insufficient workspace role"));
  expect((await post()).status).toBe(403);
  expect(h.setBusinessEncryptionKey).not.toHaveBeenCalled();
  expect(row()).toMatchObject({ pending_enc: null, leased: false });
});
