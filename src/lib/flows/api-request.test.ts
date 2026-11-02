import { describe, expect, it } from "vitest";
import { buildApiRequest, mapResponse, readPath, routeFor } from "./api-request";
import type { ApiRequestNodeConfig } from "./types";

const values = {
  vars: { name: 'Ann "the" \\ one', order: "A/1 2" },
  contact: { phone: "14155550100" },
  workspace: { token: "secret-key", host: "api.example.com" },
  publicWorkspace: { host: "api.example.com" },
};
const cfg = (patch: Partial<ApiRequestNodeConfig>): ApiRequestNodeConfig =>
  ({ method: "POST", url: "https://api.example.com/x", fallback_next: "fb", ...patch });

describe("buildApiRequest", () => {
  it("escapes values into the JSON body and encodes them into the URL", () => {
    const req = buildApiRequest(cfg({
      url: "https://{{workspace.host}}/orders/{{vars.order}}",
      params: [{ key: "phone", value: "{{contact.phone}}" }],
      body: '{"name": "{{vars.name}}"}',
    }), values)!;
    expect(req.url).toBe("https://api.example.com/orders/A%2F1%202?phone=14155550100");
    expect(JSON.parse(req.body!)).toEqual({ name: 'Ann "the" \\ one' });
    expect(req.headers["content-type"]).toBe("application/json");
  });

  it("puts secrets only into headers and the body, never the URL or query", () => {
    const req = buildApiRequest(cfg({
      url: "https://api.example.com/?k={{workspace.token}}",
      params: [{ key: "k2", value: "{{workspace.token}}" }],
      headers: [{ key: "Authorization", value: "Bearer {{workspace.token}}" }],
      body: '{"k":"{{workspace.token}}"}',
    }), values)!;
    expect(req.url).not.toContain("secret-key");
    expect(req.headers.authorization).toBe("Bearer secret-key");
    expect(req.body).toContain("secret-key");
  });

  it("strips line breaks from header values and drops the body for GET", () => {
    const req = buildApiRequest(cfg({ method: "GET", headers: [{ key: "X-Name", value: "{{vars.evil}}" }], body: '{"a":1}' }),
      { ...values, vars: { evil: "a\r\nInjected: 1" } })!;
    expect(req.headers["x-name"]).toBe("a Injected: 1");
    expect(req.body).toBeUndefined();
  });

  it("refuses a URL that does not end up http(s)", () => {
    expect(buildApiRequest(cfg({ url: "{{vars.order}}" }), values)).toBeNull();
    expect(buildApiRequest(cfg({ url: "ftp://x/" }), values)).toBeNull();
  });
});

describe("reply mapping and routing", () => {
  it("reads dot paths but never prototype keys", () => {
    const json = { data: { items: [{ id: 7 }] } };
    expect(readPath(json, "data.items.0.id")).toBe(7);
    expect(readPath(json, "data.__proto__")).toBeUndefined();
    expect(readPath(json, "constructor")).toBeUndefined();
    expect(readPath(json, "data.missing.x")).toBeUndefined();
  });

  it("maps values as text and skips missing paths and non-JSON replies", () => {
    expect(mapResponse('{"a":{"b":1},"c":"x"}', [{ path: "a", var_key: "obj" }, { path: "c", var_key: "c" }, { path: "z", var_key: "z" }]))
      .toEqual({ obj: '{"b":1}', c: "x" });
    expect(mapResponse("<html>", [{ path: "a", var_key: "a" }])).toEqual({});
    expect(mapResponse(JSON.stringify({ a: "y".repeat(5000) }), [{ path: "a", var_key: "a" }]).a).toHaveLength(1000);
  });

  it("routes on an exact status, then a class, then the fallback", () => {
    const routed = cfg({ routes: [{ status: "404", next_node_key: "missing" }, { status: "2xx", next_node_key: "ok" }] });
    expect(routeFor(routed, 201)).toBe("ok");
    expect(routeFor(routed, 404)).toBe("missing");
    expect(routeFor(routed, 500)).toBe("fb");
    expect(routeFor(routed, null)).toBe("fb");
  });
});
