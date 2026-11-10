'use client';
import type { AccountRole } from './roles';

export interface User {
  id: string;
  email: string;
  user_metadata: { full_name: string };
  created_at?: string;
}
export interface Session {
  user: User;
  expires_at: number;
  accountId: string;
  role: AccountRole;
  mfaRequired?: boolean;
}
export type PublicSession = Session;
type AuthFailure = { message: string; code?: string };
type AuthEvent =
  'SIGNED_IN' | 'SIGNED_OUT' | 'USER_UPDATED' | 'TOKEN_REFRESHED';
const listeners = new Set<
  (event: AuthEvent, session: Session | null) => void
>();
let refreshPromise: Promise<boolean> | null = null;
let currentSession: Session | null = null;
let broadcast: BroadcastChannel | null = null;
function channel(): BroadcastChannel | null {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined')
    return null;
  if (!broadcast) {
    broadcast = new BroadcastChannel('bodhinox-auth');
    broadcast.onmessage = async (event) => {
      if (event.data === 'SIGNED_OUT') {
        currentSession = null;
        listeners.forEach((listener) => listener('SIGNED_OUT', null));
      } else {
        const session = await sessionRequest();
        listeners.forEach((listener) => listener('TOKEN_REFRESHED', session));
      }
    };
  }
  return broadcast;
}
function notify(event: AuthEvent, session: Session | null) {
  currentSession = session;
  listeners.forEach((listener) => listener(event, session));
  channel()?.postMessage(event);
}
function csrfCookie(): string | undefined {
  const name =
    window.location.protocol === 'https:' &&
    process.env.NODE_ENV === 'production'
      ? '__Host-bnx_csrf'
      : 'bnx_csrf';
  return document.cookie
    .split(';')
    .map((v) => v.trim())
    .find((v) => v.startsWith(`${name}=`))
    ?.slice(name.length + 1);
}
async function csrfHeaders(init?: HeadersInit): Promise<Headers> {
  if (!csrfCookie())
    await fetch('/api/auth/csrf', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
  const headers = new Headers(init);
  const token = csrfCookie();
  if (token) headers.set('x-csrf-token', decodeURIComponent(token));
  return headers;
}
async function sessionRequest(): Promise<Session | null> {
  const response = await fetch('/api/auth/session', {
    credentials: 'same-origin',
    cache: 'no-store',
  });
  if (!response.ok) return null;
  const data = await response.json();
  currentSession = data.session ?? null;
  return currentSession;
}
async function refresh(): Promise<boolean> {
  if (refreshPromise) return refreshPromise;
  const perform = async () => {
    // Across tabs, the preceding refresh may already have installed fresh shared cookies.
    if (await sessionRequest()) return true;
    const response = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: await csrfHeaders(),
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!response.ok) {
      notify('SIGNED_OUT', null);
      return false;
    }
    const session = await sessionRequest();
    notify('TOKEN_REFRESHED', session);
    return !!session;
  };
  refreshPromise = (
    typeof navigator !== 'undefined' && navigator.locks
      ? navigator.locks.request('bodhinox-auth-refresh', perform)
      : perform()
  ).finally(() => {
    refreshPromise = null;
  });
  return refreshPromise;
}
/** Cookie credentials never leave this origin. A retry happens only after a rejected auth request. */
export async function authFetch(
  input: RequestInfo | URL,
  init: RequestInit = {}
): Promise<Response> {
  const target = new URL(
    input instanceof Request ? input.url : String(input),
    window.location.origin
  );
  if (target.origin !== window.location.origin)
    throw new Error('Authentication requests require the same origin');
  // Serialize the body once so multipart boundaries remain paired with
  // their Content-Type, including when authentication requires a retry.
  const request = new Request(
    input instanceof Request ? input.clone() : target,
    init
  );
  const method = request.method.toUpperCase();
  const mutating = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const makeRequest = async () =>
    new Request(request.clone(), {
      credentials: 'same-origin',
      headers: mutating
        ? await csrfHeaders(request.headers)
        : request.headers,
    });
  const first = await fetch(await makeRequest());
  const preauth = [
    'login',
    'signup',
    'refresh',
    'reset-request',
    'verify-request',
    'reset',
  ].some((action) => target.pathname === `/api/auth/${action}`);
  if (first.status === 401 && !preauth) {
    const failure = await first
      .clone()
      .json()
      .catch(() => null);
    if (
      !['mfa_invalid', 'mfa_required', 'current_password_invalid'].includes(
        failure?.error?.code
      ) &&
      (await refresh())
    )
      return fetch(await makeRequest());
  }
  return first;
}
export const csrfFetch = authFetch;
async function authRequest(
  action: string,
  payload?: unknown
): Promise<{ error: AuthFailure | null; data: Record<string, unknown> }> {
  try {
    const response = await authFetch(`/api/auth/${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload ?? {}),
    });
    const data = await response.json();
    return {
      data,
      error: response.ok
        ? null
        : (data.error ?? { message: 'Authentication failed' }),
    };
  } catch {
    return {
      data: {},
      error: { message: 'Unable to reach authentication service' },
    };
  }
}
const auth = {
  async getSession() {
    try {
      let session = await sessionRequest();
      if (!session && (await refresh())) session = await sessionRequest();
      return { data: { session }, error: null as AuthFailure | null };
    } catch {
      return {
        data: { session: null },
        error: { message: 'Unable to load session' } as AuthFailure,
      };
    }
  },
  async getUser() {
    const result = await auth.getSession();
    return {
      data: { user: result.data.session?.user ?? null },
      error: result.error,
    };
  },
  onAuthStateChange(
    callback: (event: AuthEvent, session: Session | null) => void
  ) {
    listeners.add(callback);
    channel();
    return {
      data: { subscription: { unsubscribe: () => listeners.delete(callback) } },
    };
  },
  async signInWithPassword(input: {
    email: string;
    password: string;
    mfaCode?: string;
  }) {
    const result = await authRequest('login', input);
    const session = result.error ? null : await sessionRequest();
    if (!result.error) notify('SIGNED_IN', session);
    return {
      data: { user: session?.user ?? null, session },
      error: result.error,
    };
  },
  async signUp(input: {
    email: string;
    password: string;
    options?: {
      data?: { full_name?: string };
      emailRedirectTo?: string;
      /** Invitation link token: the new identity joins that workspace. */
      invite?: string;
    };
  }) {
    const redirect = input.options?.emailRedirectTo
      ? new URL(input.options.emailRedirectTo, window.location.origin)
      : null;
    const result = await authRequest('signup', {
      email: input.email,
      password: input.password,
      fullName: input.options?.data?.full_name,
      next: redirect?.searchParams.get('next') ?? '/dashboard',
      ...(input.options?.invite ? { invite: input.options.invite } : {}),
    });
    return { data: { user: null, session: null }, error: result.error };
  },
  async signOut(options?: { scope?: 'global' | 'local' }) {
    if (!(await sessionRequest())) await refresh();
    const result = await authRequest(
      options?.scope === 'global' ? 'logout-all' : 'logout'
    );
    if (!result.error || result.error.code === 'unauthorized')
      notify('SIGNED_OUT', null);
    return {
      error: result.error?.code === 'unauthorized' ? null : result.error,
    };
  },
  async resetPasswordForEmail(
    email: string,
    options?: { redirectTo?: string }
  ) {
    const next = options?.redirectTo
      ? (new URL(options.redirectTo).searchParams.get('next') ??
        '/reset-password')
      : '/reset-password';
    const result = await authRequest('reset-request', { email, next });
    return { data: {}, error: result.error };
  },
  async updateUser(input: {
    email?: string;
    password?: string;
    currentPassword?: string;
    mfaCode?: string;
    data?: { full_name?: string };
  }) {
    const result = input.password
      ? await authRequest('password', {
          password: input.password,
          currentPassword: input.currentPassword,
          mfaCode: input.mfaCode,
        })
      : input.email
        ? await authRequest('email-change', {
            email: input.email,
            currentPassword: input.currentPassword,
            mfaCode: input.mfaCode,
          })
        : await authRequest('user', { fullName: input.data?.full_name });
    if (!result.error) {
      const session = await sessionRequest();
      notify(input.password ? 'SIGNED_OUT' : 'USER_UPDATED', session);
    }
    return {
      data: { user: currentSession?.user ?? null },
      error: result.error,
    };
  },
  async recoverPassword(password: string, mfaCode?: string) {
    return authRequest('reset', { password, mfaCode });
  },
  /** Finishes email verification: the emailed link (HttpOnly cookie) plus the signup password. */
  async confirmEmail(password: string) {
    return authRequest('verify-email', { password });
  },
  async verifyLinkValid(): Promise<boolean> {
    try {
      const response = await authFetch('/api/auth/verify-status');
      return !!(await response.json()).valid;
    } catch {
      return false;
    }
  },
  async resendVerification(email: string) {
    return authRequest('verify-request', { email });
  },
  async switchAccount(accountId: string) {
    const result = await authRequest('switch', { accountId });
    if (!result.error) {
      const session = await sessionRequest();
      notify('TOKEN_REFRESHED', session);
    }
    return { error: result.error };
  },
};
export function createAuthClient() {
  return auth;
}
