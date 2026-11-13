'use client';

/**
 * The Automation list's row actions against the existing APIs (authFetch adds
 * the session and the CSRF header; every route checks role, tenancy and the
 * channel rules again):
 *
 *   flow      POST /api/flows/[id]/activate {status}, PUT /api/flows/[id] {name}
 *   rule      PATCH /api/automations/[id] {is_active | name}, POST .../duplicate, DELETE
 *   sequence  PATCH /api/sequences/[id] {status | name}, DELETE (archives it)
 *
 * Going live validates on the server (flow publish checks, rule activation
 * checks); a refusal with issues comes back as a problem count.
 */

import { authFetch } from '@/lib/auth/client';
import { listProblems, problemCount, statusAfterSwitch, type AutomationItem, type ItemStatus } from './automation-items';

export type LiveOutcome =
  | { ok: true; status: ItemStatus }
  | { ok: false; problems: number }
  | { ok: false; problems: 0; error: string | null };

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});

async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** The server's translated message; a bare code (the sequence API answers `notFound`, `busy`...) is not shown. */
const errorOf = (body: Record<string, unknown> | null): string | null =>
  (typeof body?.error === 'string' && body.error.length < 300 && /\s/.test(body.error.trim()) ? body.error : null);

/** Turns a row live or off. Refuses (problems > 0) instead of going live with problems. */
export async function setLive(item: AutomationItem, on: boolean): Promise<LiveOutcome> {
  if (on) {
    const seen = listProblems(item);
    if (seen) return { ok: false, problems: seen };
  }
  const id = encodeURIComponent(item.id);
  const res = item.kind === 'flow'
    ? await authFetch(`/api/flows/${id}/activate`, json('POST', { status: on ? 'active' : 'paused' }))
    : item.kind === 'rule'
      ? await authFetch(`/api/automations/${id}`, json('PATCH', { is_active: on }))
      : await authFetch(`/api/sequences/${id}`, json('PATCH', { status: on ? 'active' : 'paused' }));
  const body = await readBody(res);
  if (res.ok) {
    const server = item.kind === 'flow' ? (body?.flow as { status?: string } | undefined)?.status
      : item.kind === 'sequence' ? (body?.sequence as { status?: string } | undefined)?.status : null;
    return { ok: true, status: statusAfterSwitch(item, on, server) };
  }
  const problems = on ? problemCount(body) : 0;
  return problems > 0 ? { ok: false, problems } : { ok: false, problems: 0, error: errorOf(body) };
}

/** Renames a row; resolves null when saved, else the server's message ('' when it gave none). */
export async function rename(item: AutomationItem, name: string): Promise<string | null> {
  const id = encodeURIComponent(item.id);
  const res = item.kind === 'flow'
    ? await authFetch(`/api/flows/${id}`, json('PUT', { name }))
    : item.kind === 'rule'
      ? await authFetch(`/api/automations/${id}`, json('PATCH', { name }))
      : await authFetch(`/api/sequences/${id}`, json('PATCH', { name }));
  if (res.ok) return null;
  return errorOf(await readBody(res)) ?? '';
}

/** Copies a rule (flows have their own duplicate with a channel; sequences have none). */
export async function duplicateRule(item: AutomationItem): Promise<string | null> {
  const res = await authFetch(`/api/automations/${encodeURIComponent(item.id)}/duplicate`, { method: 'POST' });
  if (res.ok) return null;
  return errorOf(await readBody(res)) ?? '';
}

/** Deletes a rule, or archives a sequence (its subscribers stop). Flows go through FlowList's archive-or-delete. */
export async function removeItem(item: AutomationItem): Promise<string | null> {
  const id = encodeURIComponent(item.id);
  const res = item.kind === 'rule'
    ? await authFetch(`/api/automations/${id}`, { method: 'DELETE' })
    : await authFetch(`/api/sequences/${id}`, { method: 'DELETE' });
  if (res.ok) return null;
  return errorOf(await readBody(res)) ?? '';
}
