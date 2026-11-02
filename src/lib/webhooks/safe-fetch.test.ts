import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ allow: true, addresses: [{ address: "93.184.216.34", family: 4 }] }));

// The local test server is a loopback address, which the real guard refuses;
// letting 127.0.0.1 through exercises everything after that guard.
vi.mock("./ssrf", async (load) => {
  const real = await load<typeof import("./ssrf")>();
  return { ...real, isPrivateOrReservedIp: (ip: string) => (h.allow && ip === "127.0.0.1" ? false : real.isPrivateOrReservedIp(ip)) };
});
vi.mock("node:dns", async (load) => ({
  ...(await load<typeof import("node:dns")>()),
  lookup: (_host: string, _opts: unknown, cb: (err: null, addresses: typeof h.addresses) => void) => cb(null, h.addresses),
}));

import { safeFetch, safeLookup } from "./safe-fetch";

let server: http.Server;
let base = "";
beforeAll(async () => {
  server = http.createServer((req, res) => {
    if (req.url === "/json") return res.writeHead(201, { "content-type": "application/json" }).end('{"ok":true}');
    if (req.url === "/redirect") return res.writeHead(302, { location: "http://169.254.169.254/" }).end();
    if (req.url === "/big") return res.writeHead(200).end("x".repeat(2048));
    if (req.url === "/slow") return setTimeout(() => res.end("late"), 500);
    if (req.url === "/echo") { let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => res.end(JSON.stringify({ body, auth: req.headers.authorization }))); return; }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("safeFetch", () => {
  it("returns the status and body", async () => {
    expect(await safeFetch(`${base}/json`, { method: "GET", headers: {} })).toEqual({ ok: true, status: 201, contentType: "application/json", body: '{"ok":true}' });
  });

  it("sends the body and headers it is given", async () => {
    const result = await safeFetch(`${base}/echo`, { method: "POST", headers: { authorization: "Bearer k" }, body: '{"a":1}' });
    expect(result.ok && JSON.parse(result.body)).toEqual({ body: '{"a":1}', auth: "Bearer k" });
  });

  it("never follows a redirect", async () => {
    expect(await safeFetch(`${base}/redirect`, { method: "GET", headers: {} })).toMatchObject({ ok: true, status: 302 });
  });

  it("stops at the size cap and the deadline", async () => {
    expect(await safeFetch(`${base}/big`, { method: "GET", headers: {} }, { maxBytes: 1024 })).toEqual({ ok: false, error: "too_large" });
    expect(await safeFetch(`${base}/slow`, { method: "GET", headers: {} }, { timeoutMs: 100 })).toEqual({ ok: false, error: "timeout" });
  });

  it("refuses non-http schemes, credentials in the URL, header injection and blocked hosts", async () => {
    expect(await safeFetch("file:///etc/passwd", { method: "GET", headers: {} })).toEqual({ ok: false, error: "invalid_url" });
    expect(await safeFetch(`http://user:pw@127.0.0.1/`, { method: "GET", headers: {} })).toEqual({ ok: false, error: "invalid_url" });
    expect(await safeFetch(`${base}/json`, { method: "GET", headers: { "x-a": "1\r\nx-b: 2" } })).toEqual({ ok: false, error: "invalid_url" });
    h.allow = false;
    try {
      expect(await safeFetch(`${base}/json`, { method: "GET", headers: {} })).toEqual({ ok: false, error: "blocked" });
    } finally { h.allow = true; }
    for (const url of ["http://10.0.0.1/", "http://[::1]/", "http://167772161/", "http://metadata.google.internal/", "http://printer.local/"]) {
      expect(await safeFetch(url, { method: "GET", headers: {} })).toEqual({ ok: false, error: "blocked" });
    }
  });
});

describe("safeLookup", () => {
  it("refuses a host that resolves to any private address, at connect time", async () => {
    const resolve = (all: boolean) => new Promise<unknown>((done) =>
      safeLookup("example.test", { all }, (err, address) => done(err ? (err as NodeJS.ErrnoException).code : address)));
    expect(await resolve(false)).toBe("93.184.216.34");
    h.addresses = [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }];
    expect(await resolve(true)).toBe("EBLOCKED");
    h.addresses = [{ address: "93.184.216.34", family: 4 }];
  });
});
