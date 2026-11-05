// Provider contract corpus loader (owner: T3; design 1.4). Test-only; not collected by vitest.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface ProviderFixture {
  /** docs-derived: hand-written to the provider's documented shape; sandbox-capture: recorded from a sandbox and scrubbed. */
  source: 'docs-derived' | 'sandbox-capture';
  capturedAt: string;
  docsUrl: string;
  note?: string;
  request?: { method: string; path: string; headers?: Record<string, string>; body?: unknown };
  response: { status: number; headers?: Record<string, string>; body: unknown };
}

export const CORPUS_DIR = join(process.cwd(), 'src', 'test', 'fixtures', 'providers');

export function loadProviderFixture(provider: string, name: string): ProviderFixture {
  return JSON.parse(readFileSync(join(CORPUS_DIR, provider, `${name}.json`), 'utf8')) as ProviderFixture;
}

/** Every fixture file as [provider, name, raw text]. */
export function listProviderFixtures(): [string, string, string][] {
  const out: [string, string, string][] = [];
  for (const dir of readdirSync(CORPUS_DIR, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const file of readdirSync(join(CORPUS_DIR, dir.name))) {
      if (file.endsWith('.json')) out.push([dir.name, file.slice(0, -5), readFileSync(join(CORPUS_DIR, dir.name, file), 'utf8')]);
    }
  }
  return out;
}

/** A body as the webhook sender would put it on the wire. */
export function fixtureBody(fixture: ProviderFixture): Record<string, unknown> {
  if (!fixture.request || typeof fixture.request.body !== 'object' || fixture.request.body === null) throw new Error('fixture has no request body');
  return structuredClone(fixture.request.body) as Record<string, unknown>;
}

/**
 * A fetch stub that serves one fixture response per call, in order, and
 * records each request so a contract test can assert method, path and body.
 */
export function fixtureFetch(responses: ProviderFixture[]) {
  const calls: { url: string; method: string; headers: Record<string, string>; body: unknown }[] = [];
  let i = 0;
  const fn = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => { headers[k] = v; });
    let body: unknown = init.body ?? null;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch { /* form or text body */ } }
    if (body instanceof URLSearchParams) body = Object.fromEntries(body);
    calls.push({ url, method: (init.method ?? 'GET').toUpperCase(), headers, body });
    const fixture = responses[Math.min(i++, responses.length - 1)];
    if (!fixture) throw new Error('no fixture response left');
    return new Response(fixture.response.body === null ? null : JSON.stringify(fixture.response.body), {
      status: fixture.response.status, headers: { 'content-type': 'application/json', ...(fixture.response.headers ?? {}) },
    });
  };
  return Object.assign(fn, { calls });
}
