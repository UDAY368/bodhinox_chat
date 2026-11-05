// A per-call request scope for running real App Router handlers in vitest. Route handlers that call
// requireRole()/requireSession() without a request read next/headers; a test file installs this
// module as that mock:
//
//   vi.mock('next/headers', async () => (await import('@/test/tenancy/request-scope')).nextHeadersMock);
//
// and calls handlers through callRoute(), so the real session, membership and CSRF checks run
// against the request the test built. Only the Next.js runtime is replaced, never auth logic.
import { AsyncLocalStorage } from 'node:async_hooks';

const scope = new AsyncLocalStorage<Request>();

function current(): Request {
  const request = scope.getStore();
  if (!request) throw new Error('next/headers was read outside callRoute()');
  return request;
}

function parseCookies(header: string | null): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies.set(part.slice(0, index).trim(), part.slice(index + 1).trim());
  }
  return cookies;
}

export const nextHeadersMock = {
  headers: async () => new Headers(current().headers),
  cookies: async () => {
    const cookies = parseCookies(current().headers.get('cookie'));
    const entry = (name: string) => {
      const value = cookies.get(name);
      if (value === undefined) return undefined;
      try { return { name, value: decodeURIComponent(value) }; } catch { return undefined; }
    };
    return {
      get: (name: string) => entry(name),
      getAll: () => [...cookies.keys()].map(entry).filter(Boolean),
      has: (name: string) => cookies.has(name),
      set: () => undefined,
      delete: () => undefined,
    };
  },
};

type Handler<P> = (request: Request, context: { params: Promise<P> }) => Promise<Response> | Response;

/** Calls a route handler with next/headers bound to this request. */
export function callRoute<P extends Record<string, string>>(handler: Handler<P>, request: Request,
  params: P = {} as P): Promise<Response> {
  return scope.run(request, async () => handler(request, { params: Promise.resolve(params) }));
}
