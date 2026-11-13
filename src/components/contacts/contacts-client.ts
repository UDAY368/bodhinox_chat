'use client';
// Browser helpers shared by the contacts pages: workspace members (owner
// pickers), the custom fields with types, saving one profile field, and
// downloading an export. Every call goes through the session's authFetch.
import { useCallback, useEffect, useState } from 'react';
import { authFetch } from '@/lib/auth/client';
import type { CustomFieldSummary } from '@/lib/contacts/custom-fields';

export type { CustomFieldSummary };

export interface ContactMember {
  user_id: string;
  full_name: string;
}

/** The workspace's members, names only (any member may read them). */
export function useContactMembers(): ContactMember[] {
  const [members, setMembers] = useState<ContactMember[]>([]);
  useEffect(() => {
    let live = true;
    authFetch('/api/account/members', { cache: 'no-store' })
      .then(async (res) => {
        const body = res.ok ? ((await res.json()) as { members?: { user_id: string; full_name: string | null }[] }) : null;
        if (live && body?.members)
          setMembers(body.members.map((m) => ({ user_id: m.user_id, full_name: m.full_name || '' })));
      })
      .catch(() => {
        // Owner names show as "No one" until the list loads.
      });
    return () => {
      live = false;
    };
  }, []);
  return members;
}

export function memberName(members: ContactMember[], userId: string | null | undefined): string | null {
  if (!userId) return null;
  return members.find((m) => m.user_id === userId)?.full_name || null;
}

/** The custom fields with their types, fill counts and segment use. */
export function useCustomFields(): { fields: CustomFieldSummary[]; loading: boolean; reload: () => Promise<void> } {
  const [fields, setFields] = useState<CustomFieldSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    const res = await authFetch('/api/custom-fields', { cache: 'no-store' }).catch(() => null);
    const body = res?.ok ? ((await res.json()) as { fields: CustomFieldSummary[] }) : null;
    if (body) setFields(body.fields);
    setLoading(false);
  }, []);
  useEffect(() => {
    let live = true;
    authFetch('/api/custom-fields', { cache: 'no-store' })
      .then(async (res) => {
        const body = res.ok ? ((await res.json()) as { fields: CustomFieldSummary[] }) : null;
        if (live && body) setFields(body.fields);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);
  return { fields, loading, reload };
}

/** PATCH /api/contacts/[id]; the error code (profile.ts ProfileErrorCode) on refusal. */
export async function saveContactField(
  contactId: string,
  body: { field: string; value: string | boolean } | { customFieldId: string; value: string },
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string }> {
  const res = await authFetch(`/api/contacts/${encodeURIComponent(contactId)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  const payload = (await res?.json().catch(() => null)) as (Record<string, unknown> & { error?: string }) | null;
  if (!res?.ok) return { ok: false, code: payload?.error ?? 'network' };
  return { ok: true, data: payload ?? {} };
}

/** Downloads GET /api/contacts/export?<query> as a file; false (with the server's message) on refusal. */
export async function downloadContactsCsv(query: string): Promise<{ ok: true } | { ok: false; error?: string }> {
  const res = await authFetch(`/api/contacts/export${query ? `?${query}` : ''}`).catch(() => null);
  if (!res?.ok) {
    const payload = (await res?.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, error: payload?.error };
  }
  const url = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = url;
  link.download = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') ?? '')?.[1] ?? 'contacts.csv';
  link.click();
  URL.revokeObjectURL(url);
  return { ok: true };
}
