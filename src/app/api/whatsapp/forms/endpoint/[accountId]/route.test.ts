import crypto from "node:crypto";
import { afterAll, beforeEach, expect, it, vi } from "vitest";

import { generateFormsKeyPair } from "@/lib/whatsapp/forms/crypto";
import { openLikeMeta, sealLikeMeta } from "@/lib/whatsapp/forms/meta-flow-sim";
import type { FormDefinition } from "@/lib/whatsapp/forms/types";

const ACCOUNT = "11111111-1111-4111-8111-111111111111";
const TOKEN = "T".repeat(43);
const SECRET = "test-only-app-secret";
const keys = generateFormsKeyPair();
const definition: FormDefinition = {
  version: 1,
  screens: [
    { id: "ONE", title: "One", button_label: "Next", fields: [{ id: "name", type: "short_text", label: "Name", required: true }] },
    { id: "TWO", title: "Two", button_label: "Send", fields: [{ id: "email", type: "email", label: "Email", required: true }] },
  ],
};

const h = vi.hoisted(() => ({
  privateKey: null as string | null,
  pendingKey: null as string | null,
  session: null as null | { id: string; answers: Record<string, unknown>; expired: boolean; completed: boolean; definition: unknown },
  scopes: [] as unknown[],
  limited: false,
  keyWaba: "waba-1" as string | null,
  formWaba: "waba-1" as string | null,
}));

// A stand-in for the tenant transaction: answers by the statement it is given.
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FROM whatsapp_config")) return [{ forms_private_key_enc: h.privateKey, forms_pending_private_key_enc: h.pendingKey, waba_id: h.keyWaba }];
    if (sql.includes("FROM whatsapp_form_sessions")) {
      // Mirrors the WABA filter: (unscoped OR form WABA unknown OR form WABA in the key's WABAs).
      const [unscoped, wabaIds] = values.slice(-2) as [boolean, string[]];
      const inScope = unscoped || h.formWaba === null || wabaIds.includes(h.formWaba);
      return h.session && values.includes(TOKEN) && inScope ? [h.session] : [];
    }
    if (sql.includes("completed_at = now()")) {
      if (!h.session || h.session.completed) return [];
      h.session.answers = { ...h.session.answers, ...JSON.parse(values[0] as string) };
      h.session.completed = true;
      return [{ answers: h.session.answers }];
    }
    throw new Error("unexpected query");
  },
  $executeRaw: async (_strings: TemplateStringsArray, ...values: unknown[]) => {
    h.session!.answers = { ...h.session!.answers, ...JSON.parse(values[0] as string) };
    return 1;
  },
};
vi.mock("@/lib/db/prisma", () => ({ getWorkerPrisma: () => "worker-db" }));
vi.mock("@/lib/db/tenant", () => ({
  withTenant: async (scope: unknown, op: (t: typeof tx) => unknown, db: unknown) => { h.scopes.push({ scope, db }); return op(tx); },
}));
vi.mock("@/lib/whatsapp/encryption", () => ({ decrypt: (value: string) => value }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: () => ({ success: !h.limited }),
  rateLimitResponse: () => new Response(null, { status: 429 }),
}));

import { POST } from "./route";

const previousSecret = process.env.META_APP_SECRET;
afterAll(() => { process.env.META_APP_SECRET = previousSecret; });

function post(raw: string, { signature, account = ACCOUNT }: { signature?: string | null; account?: string } = {}) {
  const sig = signature === undefined ? "sha256=" + crypto.createHmac("sha256", SECRET).update(raw).digest("hex") : signature;
  return POST(
    new Request(`http://localhost/api/whatsapp/forms/endpoint/${account}`, { method: "POST", body: raw, headers: sig ? { "x-hub-signature-256": sig } : {} }),
    { params: Promise.resolve({ accountId: account }) },
  );
}

/** Sends one request as WhatsApp would and opens the encrypted reply. */
async function exchange(payload: Record<string, unknown>) {
  const meta = sealLikeMeta(payload, keys.publicKeyPem);
  const res = await post(JSON.stringify(meta.body));
  if (res.status !== 200) return { status: res.status };
  expect(res.headers.get("content-type")).toBe("text/plain");
  return { status: 200, body: openLikeMeta(await res.text(), meta.aesKey, meta.iv) as Record<string, unknown> };
}

beforeEach(() => {
  process.env.META_APP_SECRET = SECRET;
  h.privateKey = keys.privateKeyPem;
  h.pendingKey = null;
  h.session = { id: "s-1", answers: {}, expired: false, completed: false, definition };
  h.scopes = [];
  h.limited = false;
  h.keyWaba = "waba-1";
  h.formWaba = "waba-1";
});

it("only serves forms of the WABA whose number holds the decrypting key", async () => {
  expect((await exchange({ action: "INIT", flow_token: TOKEN })).status).toBe(200);
  h.formWaba = "waba-2";
  expect((await exchange({ action: "INIT", flow_token: TOKEN })).status).toBe(427);
  h.keyWaba = "waba-2";
  expect((await exchange({ action: "INIT", flow_token: TOKEN })).status).toBe(200);
});

it("answers a ping with an encrypted active status, as the account's worker scope", async () => {
  expect(await exchange({ version: "3.0", action: "ping" })).toEqual({ status: 200, body: { data: { status: "active" } } });
  expect(h.scopes[0]).toEqual({ scope: { accountId: ACCOUNT, role: "owner" }, db: "worker-db" });
});

it("walks a two-screen form to completion", async () => {
  expect((await exchange({ action: "INIT", flow_token: TOKEN })).body).toEqual({ screen: "ONE", data: {} });
  expect((await exchange({ action: "data_exchange", flow_token: TOKEN, screen: "ONE", data: { name: "Ana" } })).body).toEqual({ screen: "TWO", data: {} });
  const bad = await exchange({ action: "data_exchange", flow_token: TOKEN, screen: "TWO", data: { email: "nope" } });
  expect(bad.body).toMatchObject({ screen: "TWO", data: { error_message: expect.any(String) } });
  expect((await exchange({ action: "data_exchange", flow_token: TOKEN, screen: "TWO", data: { email: "ana@example.com" } })).body).toEqual({
    screen: "SUCCESS",
    data: { extension_message_response: { params: { flow_token: TOKEN, name: "Ana", email: "ana@example.com" } } },
  });
  expect(h.session!.completed).toBe(true);
});

it("rejects a missing or wrong signature before any lookup, and fails closed without an app secret", async () => {
  const body = JSON.stringify(sealLikeMeta({ action: "ping" }, keys.publicKeyPem).body);
  expect((await post(body, { signature: null })).status).toBe(401);
  expect((await post(body, { signature: "sha256=" + "0".repeat(64) })).status).toBe(401);
  delete process.env.META_APP_SECRET;
  expect((await post(body)).status).toBe(401);
  expect(h.scopes).toEqual([]);
});

it("answers 421 when the request cannot be decrypted or no key is stored", async () => {
  const other = generateFormsKeyPair();
  expect((await post(JSON.stringify(sealLikeMeta({ action: "ping" }, other.publicKeyPem).body))).status).toBe(421);
  h.privateKey = null;
  expect((await exchange({ action: "ping" })).status).toBe(421);
});

it("decrypts with a key Meta holds but that was never promoted, after the current key fails", async () => {
  const previous = generateFormsKeyPair();
  h.privateKey = previous.privateKeyPem;
  h.pendingKey = keys.privateKeyPem;
  expect(await exchange({ version: "3.0", action: "ping" })).toEqual({ status: 200, body: { data: { status: "active" } } });
  h.pendingKey = null;
  expect((await exchange({ action: "ping" })).status).toBe(421);
  h.privateKey = null;
  h.pendingKey = keys.privateKeyPem;
  expect((await exchange({ action: "ping" })).status).toBe(200);
});

it("answers 427 for an unknown or expired flow token", async () => {
  expect((await exchange({ action: "INIT", flow_token: "U".repeat(43) })).status).toBe(427);
  h.session!.expired = true;
  expect((await exchange({ action: "INIT", flow_token: TOKEN })).status).toBe(427);
});

it("rejects malformed bodies, bad account ids and rate-limited accounts", async () => {
  expect((await post("not json")).status).toBe(400);
  expect((await post(JSON.stringify({ hello: "world" }))).status).toBe(400);
  expect((await post(JSON.stringify(sealLikeMeta({}, keys.publicKeyPem).body), { account: "not-a-uuid" })).status).toBe(404);
  h.limited = true;
  expect((await exchange({ action: "ping" })).status).toBe(429);
});
